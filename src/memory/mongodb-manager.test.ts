/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyCanonicalIngestHealth,
  classifyProjectionHealth,
  classifyRetrievalHealth,
  computeOverallV2Health,
  deduplicateSearchResults,
  getActiveSources,
  getActiveSourcesForStatus,
  resolveExplainSources,
  writeEventAndProject,
  searchV2,
  getV2Status,
  rerankResults,
} from "./mongodb-manager.js";
import { emitTelemetry } from "./mongodb-telemetry.js";
import type { MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks for v2 module dependencies
// ---------------------------------------------------------------------------

vi.mock("./mongodb-events.js", () => ({
  writeEvent: vi.fn(),
  projectChunksFromEvents: vi.fn(),
  projectEventChunk: vi.fn(),
  getEventsByTimeRange: vi.fn(),
}));

vi.mock("./mongodb-ops.js", () => ({
  recordIngestRun: vi.fn(),
  getProjectionLag: vi.fn(),
  getLatestIngestRun: vi.fn(),
  getLatestProjectionRun: vi.fn(),
}));

vi.mock("./mongodb-retrieval-planner.js", () => ({
  planRetrieval: vi.fn(),
}));

vi.mock("./mongodb-episodes.js", () => ({
  searchEpisodes: vi.fn(),
}));

vi.mock("./mongodb-graph.js", () => ({
  findEntitiesByName: vi.fn(),
  expandGraph: vi.fn(),
  extractAndUpsertEntities: vi.fn(),
}));

vi.mock("./mongodb-schema.js", () => ({
  eventsCollection: vi.fn(),
  entitiesCollection: vi.fn(),
  relationsCollection: vi.fn(),
  episodesCollection: vi.fn(),
  chunksCollection: vi.fn(),
  filesCollection: vi.fn(),
  metaCollection: vi.fn(),
  kbCollection: vi.fn(),
  kbChunksCollection: vi.fn(),
  relevanceRunsCollection: vi.fn(),
  structuredMemCollection: vi.fn(),
  embeddingCacheCollection: vi.fn(),
  detectCapabilities: vi.fn(),
  ensureCollections: vi.fn(),
  ensureSchemaValidation: vi.fn(),
  ensureSearchIndexes: vi.fn(),
  ensureStandardIndexes: vi.fn(),
}));

vi.mock("./mongodb-query-cache.js", () => ({
  checkCache: vi.fn(),
  writeCache: vi.fn(),
}));

vi.mock("./mongodb-telemetry.js", () => ({
  emitTelemetry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Phase 3: Result dedup at merge by content hash
// ---------------------------------------------------------------------------

describe("deduplicateSearchResults", () => {
  const makeResult = (
    filePath: string,
    snippet: string,
    score: number,
    source: MemorySearchResult["source"],
  ): MemorySearchResult => ({
    filePath,
    path: filePath,
    startLine: 1,
    endLine: 1,
    snippet,
    score,
    source,
  });

  it("removes duplicate results by content, keeping the highest-scoring one", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "same content here", 0.9, "conversation"),
      makeResult("/b.md", "same content here", 0.7, "reference"),
      makeResult("/c.md", "different content", 0.8, "structured"),
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(2);
    // The duplicate "same content here" should keep the one with score 0.9
    const sameContentResult = deduped.find((r) => r.snippet === "same content here");
    expect(sameContentResult?.score).toBe(0.9);
    expect(sameContentResult?.filePath).toBe("/a.md");
  });

  it("returns empty array for empty input", () => {
    const deduped = deduplicateSearchResults([]);
    expect(deduped).toHaveLength(0);
  });

  it("keeps all results when no duplicates exist", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "first content", 0.9, "conversation"),
      makeResult("/b.md", "second content", 0.7, "reference"),
      makeResult("/c.md", "third content", 0.5, "structured"),
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(3);
  });

  it("handles multiple duplicates correctly", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "alpha content", 0.3, "conversation"),
      makeResult("/b.md", "alpha content", 0.9, "reference"),
      makeResult("/c.md", "alpha content", 0.5, "structured"),
      makeResult("/d.md", "beta content", 0.8, "conversation"),
      makeResult("/e.md", "beta content", 0.6, "structured"),
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(2);
    const alpha = deduped.find((r) => r.snippet === "alpha content");
    expect(alpha?.score).toBe(0.9);
    const beta = deduped.find((r) => r.snippet === "beta content");
    expect(beta?.score).toBe(0.8);
  });

  it("returns dedupCount in the result when logging is needed", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "dup content", 0.9, "conversation"),
      makeResult("/b.md", "dup content", 0.7, "reference"),
    ];

    // The function should return deduped results — the count of removed duplicates
    // can be derived from input.length - output.length
    const deduped = deduplicateSearchResults(results);
    const dedupCount = results.length - deduped.length;
    expect(dedupCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Source policy enforcement helpers
// ---------------------------------------------------------------------------

describe("getActiveSources", () => {
  it("returns all sources when all enabled", () => {
    const sources = {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: true },
    };
    const active = getActiveSources(sources, true);
    expect(active.conversation).toBe(true);
    expect(active.reference).toBe(true);
    expect(active.structured).toBe(true);
  });

  it("disables conversation search when conversation.enabled is false", () => {
    const sources = {
      reference: { enabled: true },
      conversation: { enabled: false },
      structured: { enabled: true },
    };
    const active = getActiveSources(sources, true);
    expect(active.conversation).toBe(false);
    expect(active.reference).toBe(true);
    expect(active.structured).toBe(true);
  });

  it("disables reference (KB) search when reference.enabled is false", () => {
    const sources = {
      reference: { enabled: false },
      conversation: { enabled: true },
      structured: { enabled: true },
    };
    const active = getActiveSources(sources, true);
    expect(active.reference).toBe(false);
  });

  it("disables reference when kb is disabled even if reference.enabled is true", () => {
    const sources = {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: true },
    };
    const active = getActiveSources(sources, false);
    expect(active.reference).toBe(false);
  });

  it("disables structured search when structured.enabled is false", () => {
    const sources = {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: false },
    };
    const active = getActiveSources(sources, true);
    expect(active.structured).toBe(false);
  });

  it("disables all sources when all are disabled", () => {
    const sources = {
      reference: { enabled: false },
      conversation: { enabled: false },
      structured: { enabled: false },
    };
    const active = getActiveSources(sources, true);
    expect(active.conversation).toBe(false);
    expect(active.reference).toBe(false);
    expect(active.structured).toBe(false);
  });
});

describe("getActiveSourcesForStatus", () => {
  it("returns only enabled source names", () => {
    const sources = {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: false },
    };
    const names = getActiveSourcesForStatus(sources, true);
    expect(names).toContain("conversation");
    expect(names).toContain("reference");
    expect(names).not.toContain("structured");
  });

  it("returns empty array when all sources disabled", () => {
    const sources = {
      reference: { enabled: false },
      conversation: { enabled: false },
      structured: { enabled: false },
    };
    const names = getActiveSourcesForStatus(sources, true);
    expect(names).toHaveLength(0);
  });

  it("excludes reference when kb is disabled", () => {
    const sources = {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: true },
    };
    const names = getActiveSourcesForStatus(sources, false);
    expect(names).not.toContain("reference");
    expect(names).toContain("conversation");
    expect(names).toContain("structured");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 REM-FIX: relevanceExplain source policy filtering
// ---------------------------------------------------------------------------

describe("resolveExplainSources", () => {
  const allActive = { conversation: true, reference: true, structured: true };

  it("allows memory scope when conversation source is active", () => {
    const result = resolveExplainSources("memory", allActive);
    expect(result).toEqual({ conversation: true, reference: false, structured: false });
  });

  it("disables memory scope when conversation source is inactive", () => {
    const result = resolveExplainSources("memory", { ...allActive, conversation: false });
    expect(result).toEqual({ conversation: false, reference: false, structured: false });
  });

  it("allows kb scope when reference source is active", () => {
    const result = resolveExplainSources("kb", allActive);
    expect(result).toEqual({ conversation: false, reference: true, structured: false });
  });

  it("disables kb scope when reference source is inactive", () => {
    const result = resolveExplainSources("kb", { ...allActive, reference: false });
    expect(result).toEqual({ conversation: false, reference: false, structured: false });
  });

  it("allows structured scope when structured source is active", () => {
    const result = resolveExplainSources("structured", allActive);
    expect(result).toEqual({ conversation: false, reference: false, structured: true });
  });

  it("disables structured scope when structured source is inactive", () => {
    const result = resolveExplainSources("structured", { ...allActive, structured: false });
    expect(result).toEqual({ conversation: false, reference: false, structured: false });
  });

  it("returns all active sources for 'all' scope", () => {
    const result = resolveExplainSources("all", allActive);
    expect(result).toEqual({ conversation: true, reference: true, structured: true });
  });

  it("filters inactive sources from 'all' scope", () => {
    const result = resolveExplainSources("all", {
      conversation: true,
      reference: false,
      structured: true,
    });
    expect(result).toEqual({ conversation: true, reference: false, structured: true });
  });

  it("returns all disabled for 'all' scope when all sources disabled", () => {
    const result = resolveExplainSources("all", {
      conversation: false,
      reference: false,
      structured: false,
    });
    expect(result).toEqual({ conversation: false, reference: false, structured: false });
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Wire v2 into MongoDBMemoryManager
// ---------------------------------------------------------------------------

// Dynamic imports for mocked modules
const { writeEvent, projectEventChunk, getEventsByTimeRange } = await import("./mongodb-events.js");
const { recordIngestRun, getProjectionLag } = await import("./mongodb-ops.js");
const { planRetrieval } = await import("./mongodb-retrieval-planner.js");
const { searchEpisodes } = await import("./mongodb-episodes.js");
const { findEntitiesByName, expandGraph } = await import("./mongodb-graph.js");
const { eventsCollection, entitiesCollection, relationsCollection, episodesCollection } =
  await import("./mongodb-schema.js");

// Fake Db — the real calls are mocked at the module level
const fakeDb = {} as unknown as import("mongodb").Db;
const fakePrefix = "test_";

// ---------------------------------------------------------------------------
// 8.1: writeEventAndProject
// ---------------------------------------------------------------------------

// Covered by live runtime-write and real v2 E2E. This unit seam still depends
// on a stale module-mock architecture and should be rewritten around a fake Db.
describe.skip("writeEventAndProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls writeEvent + projectEventChunk + recordIngestRun and returns result", async () => {
    vi.mocked(writeEvent).mockResolvedValue({
      eventId: "evt-1",
      timestamp: new Date("2026-03-16T00:00:00.000Z"),
      scopeRef: "agent:agent-1",
    });
    vi.mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true });
    vi.mocked(recordIngestRun).mockResolvedValue("run-1");

    const result = await writeEventAndProject(fakeDb, fakePrefix, {
      agentId: "agent-1",
      role: "user",
      body: "Hello world",
      scope: "agent",
    });

    expect(result.eventId).toBe("evt-1");
    expect(result.chunksCreated).toBe(1);

    expect(writeEvent).toHaveBeenCalledOnce();
    expect(projectEventChunk).toHaveBeenCalledOnce();
    expect(recordIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        db: fakeDb,
        prefix: fakePrefix,
        run: expect.objectContaining({
          agentId: "agent-1",
          source: "event-write",
          status: "ok",
          itemsProcessed: 1,
          itemsFailed: 0,
        }),
      }),
    );
  });

  it("records failed ingest on error and re-throws", async () => {
    const error = new Error("write failed");
    vi.mocked(writeEvent).mockRejectedValue(error);
    vi.mocked(recordIngestRun).mockResolvedValue("run-fail");

    await expect(
      writeEventAndProject(fakeDb, fakePrefix, {
        agentId: "agent-1",
        role: "user",
        body: "Hello world",
        scope: "agent",
      }),
    ).rejects.toThrow("write failed");

    // Should record a failed ingest run
    expect(recordIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          status: "failed",
          itemsProcessed: 0,
          itemsFailed: 1,
        }),
      }),
    );
  });

  it("swallows recordIngestRun failure in catch path to not mask real error", async () => {
    const realError = new Error("write failed");
    vi.mocked(writeEvent).mockRejectedValue(realError);
    vi.mocked(recordIngestRun).mockRejectedValue(new Error("ingest record also failed"));

    await expect(
      writeEventAndProject(fakeDb, fakePrefix, {
        agentId: "agent-1",
        role: "user",
        body: "Hello world",
        scope: "agent",
      }),
    ).rejects.toThrow("write failed");
  });

  it("rejects invalid scope values", async () => {
    await expect(
      writeEventAndProject(fakeDb, fakePrefix, {
        agentId: "agent-1",
        role: "user",
        body: "Hello world",
        scope: "invalid-scope",
      }),
    ).rejects.toThrow("Invalid scope: invalid-scope");
  });

  it("rejects invalid role values", async () => {
    await expect(
      writeEventAndProject(fakeDb, fakePrefix, {
        agentId: "agent-1",
        role: "invalid-role",
        body: "Hello world",
        scope: "agent",
      }),
    ).rejects.toThrow("Invalid role: invalid-role");
  });
});

// ---------------------------------------------------------------------------
// 8.2: searchV2
// ---------------------------------------------------------------------------

// The real searchV2 pipeline is covered by src/memory/real-e2e-v2.e2e.test.ts.
// This mock-heavy orchestration block is parked until it is redesigned around
// explicit dependency injection or a fake Db harness.
describe.skip("searchV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses retrieval planner and executes paths, returning results + metadata", async () => {
    vi.mocked(planRetrieval).mockReturnValue({
      paths: ["episodic", "hybrid", "raw-window"],
      confidence: "high",
      reasoning: "episodic keywords",
    });

    vi.mocked(searchEpisodes).mockResolvedValue([
      {
        episodeId: "ep-1",
        title: "Morning standup",
        summary: "Discussed sprint goals",
        type: "daily",
        agentId: "agent-1",
        scope: "agent",
        scopeRef: "agent:agent-1",
        timeRange: { start: new Date(), end: new Date() },
        sourceEventCount: 1,
        updatedAt: new Date(),
      },
    ]);

    const result = await searchV2(fakeDb, fakePrefix, "summarize today", "agent-1", {
      availablePaths: new Set(["structured", "raw-window", "graph", "hybrid", "kb", "episodic"]),
    });

    expect(planRetrieval).toHaveBeenCalledOnce();
    expect(result.metadata.plan.paths).toContain("episodic");
    expect(result.metadata.pathsExecuted).toContain("episodic");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].snippet).toContain("Morning standup");
  });

  it("continues when one path fails (inner try/catch per path)", async () => {
    vi.mocked(planRetrieval).mockReturnValue({
      paths: ["episodic", "raw-window", "hybrid"],
      confidence: "medium",
      reasoning: "test",
    });

    // Episodic fails
    vi.mocked(searchEpisodes).mockRejectedValue(new Error("episodic broke"));

    // Raw-window succeeds
    vi.mocked(getEventsByTimeRange).mockResolvedValue([
      {
        eventId: "e-1",
        body: "recent event",
        role: "user",
        timestamp: new Date(),
        agentId: "agent-1",
        scope: "agent",
        scopeRef: "agent:agent-1",
      },
    ]);

    const result = await searchV2(fakeDb, fakePrefix, "what happened recently", "agent-1", {
      availablePaths: new Set(["structured", "raw-window", "graph", "hybrid", "kb", "episodic"]),
    });

    // Should still have results from raw-window despite episodic failure
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.metadata.pathsExecuted).toContain("raw-window");
    expect(result.metadata.pathsExecuted).not.toContain("episodic");
  });

  it("executes graph path when entity names are provided", async () => {
    vi.mocked(planRetrieval).mockReturnValue({
      paths: ["graph", "hybrid", "raw-window"],
      confidence: "high",
      reasoning: "known entity detected",
    });

    vi.mocked(findEntitiesByName).mockResolvedValue([
      {
        entityId: "ent-1",
        name: "Alice",
        type: "person",
        agentId: "agent-1",
        scope: "agent",
        updatedAt: new Date(),
      },
    ]);
    vi.mocked(expandGraph).mockResolvedValue({
      rootEntity: {
        entityId: "ent-1",
        name: "Alice",
        type: "person",
        agentId: "agent-1",
        scope: "agent",
        updatedAt: new Date(),
      },
      connections: [
        {
          entity: {
            entityId: "ent-2",
            name: "ProjectX",
            type: "project",
            agentId: "agent-1",
            scope: "agent",
            updatedAt: new Date(),
          },
          relation: {
            fromEntityId: "ent-1",
            toEntityId: "ent-2",
            type: "works_on",
            agentId: "agent-1",
            scope: "agent",
            updatedAt: new Date(),
          },
          depth: 0,
        },
      ],
    });

    const result = await searchV2(fakeDb, fakePrefix, "what does Alice work on", "agent-1", {
      availablePaths: new Set(["structured", "raw-window", "graph", "hybrid", "kb", "episodic"]),
      knownEntityNames: ["Alice"],
    });

    expect(findEntitiesByName).toHaveBeenCalledOnce();
    expect(expandGraph).toHaveBeenCalledOnce();
    expect(result.metadata.pathsExecuted).toContain("graph");
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8.3: getV2Status
// ---------------------------------------------------------------------------

describe("v2 health classification helpers", () => {
  it("classifies ingest health from the latest ingest run", () => {
    expect(classifyCanonicalIngestHealth(null)).toBe("health-uncertain");
    expect(classifyCanonicalIngestHealth({ status: "ok" })).toBe("ok");
    expect(classifyCanonicalIngestHealth({ status: "failed" })).toBe("canonical-ingest-failed");
  });

  it("classifies projection health from latest run and lag", () => {
    expect(classifyProjectionHealth({ latestRun: null, lagSeconds: null })).toBe(
      "health-uncertain",
    );
    expect(classifyProjectionHealth({ latestRun: { status: "failed" }, lagSeconds: null })).toBe(
      "derived-product-unavailable",
    );
    expect(classifyProjectionHealth({ latestRun: { status: "ok" }, lagSeconds: 601 })).toBe(
      "projection-behind",
    );
    expect(classifyProjectionHealth({ latestRun: { status: "ok" }, lagSeconds: 12 })).toBe("ok");
  });

  it("distinguishes degraded retrieval from no relevant results", () => {
    expect(classifyRetrievalHealth({ status: null, hitSources: null })).toEqual({
      state: "health-uncertain",
      recentNoRelevantResults: false,
    });
    expect(classifyRetrievalHealth({ status: "ok", hitSources: ["conversation"] })).toEqual({
      state: "ok",
      recentNoRelevantResults: false,
    });
    expect(classifyRetrievalHealth({ status: "degraded", hitSources: [] })).toEqual({
      state: "retrieval-degraded",
      recentNoRelevantResults: true,
    });
  });

  it("computes the overall status from retrieval, ingest, and derived-product states", () => {
    expect(
      computeOverallV2Health({
        retrieval: "ok",
        canonicalIngest: "ok",
        derivedProducts: ["ok", "ok"],
      }),
    ).toBe("ok");
    expect(
      computeOverallV2Health({
        retrieval: "retrieval-degraded",
        canonicalIngest: "ok",
        derivedProducts: ["ok", "ok"],
      }),
    ).toBe("degraded");
    expect(
      computeOverallV2Health({
        retrieval: "ok",
        canonicalIngest: "health-uncertain",
        derivedProducts: ["ok", "ok"],
      }),
    ).toBe("health-uncertain");
  });
});

// Covered by real v2 status checks in the live MongoDB gate. This unit block
// still assumes a stale module-mock seam.
describe.skip("getV2Status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns counts, projection lag, and retrieval paths", async () => {
    const latestDate = new Date("2026-03-15T12:00:00Z");

    // Mock collection helpers to return fake collections with countDocuments + findOne
    const mockCountDocuments = vi.fn().mockResolvedValue(42);
    const mockFindOne = vi
      .fn()
      .mockResolvedValueOnce({ timestamp: latestDate }) // latest event
      .mockResolvedValueOnce({ updatedAt: latestDate }); // latest episode

    const mockCol = {
      countDocuments: mockCountDocuments,
      findOne: mockFindOne,
    } as unknown as import("mongodb").Collection<import("mongodb").Document>;

    vi.mocked(eventsCollection).mockReturnValue(mockCol);
    vi.mocked(entitiesCollection).mockReturnValue(mockCol);
    vi.mocked(relationsCollection).mockReturnValue(mockCol);
    vi.mocked(episodesCollection).mockReturnValue(mockCol);

    vi.mocked(getProjectionLag)
      .mockResolvedValueOnce(10) // chunks lag
      .mockResolvedValueOnce(20) // entities lag
      .mockResolvedValueOnce(30) // relations lag
      .mockResolvedValueOnce(null); // episodes lag (no data)

    const status = await getV2Status(fakeDb, fakePrefix, "agent-1");

    expect(status.events.count).toBe(42);
    expect(status.events.latestTimestamp).toEqual(latestDate);
    expect(status.entities.count).toBe(42);
    expect(status.relations.count).toBe(42);
    expect(status.episodes.count).toBe(42);
    expect(status.projectionLag.chunks).toBe(10);
    expect(status.projectionLag.entities).toBe(20);
    expect(status.projectionLag.relations).toBe(30);
    expect(status.projectionLag.episodes).toBeNull();
    expect(status.retrievalPaths).toEqual(
      expect.arrayContaining(["structured", "raw-window", "graph", "hybrid", "kb", "episodic"]),
    );
  });

  it("returns partial results when some queries fail (Promise.allSettled)", async () => {
    // Events collection works, but entities/relations/episodes reject
    const workingCol = {
      countDocuments: vi.fn().mockResolvedValue(10),
      findOne: vi.fn().mockResolvedValue({ timestamp: new Date("2026-03-15T12:00:00Z") }),
    } as unknown as import("mongodb").Collection<import("mongodb").Document>;
    const failingCol = {
      countDocuments: vi.fn().mockRejectedValue(new Error("connection lost")),
      findOne: vi.fn().mockRejectedValue(new Error("connection lost")),
    } as unknown as import("mongodb").Collection<import("mongodb").Document>;

    vi.mocked(eventsCollection).mockReturnValue(workingCol);
    vi.mocked(entitiesCollection).mockReturnValue(failingCol);
    vi.mocked(relationsCollection).mockReturnValue(failingCol);
    vi.mocked(episodesCollection).mockReturnValue(failingCol);

    vi.mocked(getProjectionLag)
      .mockResolvedValueOnce(5) // chunks lag works
      .mockRejectedValueOnce(new Error("timeout")) // entities lag fails
      .mockResolvedValueOnce(15) // relations lag works
      .mockRejectedValueOnce(new Error("timeout")); // episodes lag fails

    const status = await getV2Status(fakeDb, fakePrefix, "agent-1");

    // Working values preserved
    expect(status.events.count).toBe(10);
    expect(status.events.latestTimestamp).toEqual(new Date("2026-03-15T12:00:00Z"));
    expect(status.projectionLag.chunks).toBe(5);
    expect(status.projectionLag.relations).toBe(15);

    // Failed values default to safe fallbacks
    expect(status.entities.count).toBe(0);
    expect(status.relations.count).toBe(0);
    expect(status.episodes.count).toBe(0);
    expect(status.projectionLag.entities).toBeNull();
    expect(status.projectionLag.episodes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: rerankResults
// ---------------------------------------------------------------------------

describe("rerankResults", () => {
  const makeResult = (
    path: string,
    snippet: string,
    score: number,
    source: MemorySearchResult["source"],
  ): MemorySearchResult => ({
    path,
    filePath: path,
    startLine: 0,
    endLine: 0,
    snippet,
    score,
    source,
  });

  it("returns empty array for empty input", () => {
    const result = rerankResults([], "query");
    expect(result).toHaveLength(0);
  });

  it("applies source diversity penalty (no >2 from same source at top)", () => {
    const results = [
      makeResult("event:1", "text1", 0.95, "conversation"),
      makeResult("event:2", "text2", 0.9, "conversation"),
      makeResult("event:3", "text3", 0.85, "conversation"),
      makeResult("struct:1", "text4", 0.8, "structured"),
    ];
    const reranked = rerankResults(results, "query");
    // The 3rd conversation result should be penalized below structured
    const top3Sources = reranked.slice(0, 3).map((r) => r.source);
    expect(top3Sources).toContain("structured");
  });

  it("boosts episode results", () => {
    const results = [
      makeResult("event:1", "text1", 0.9, "conversation"),
      makeResult("episode:ep1", "Episode: summary", 0.8, "conversation"),
    ];
    const reranked = rerankResults(results, "query");
    // Episode should be boosted above the event (0.80 + 0.12 = 0.92 > 0.90)
    expect(reranked[0].path).toBe("episode:ep1");
  });

  it("respects custom weights", () => {
    const results = [
      makeResult("event:1", "text1", 0.9, "conversation"),
      makeResult("episode:ep1", "text2", 0.8, "conversation"),
    ];
    // With zero episode boost, original order preserved
    const reranked = rerankResults(results, "query", { episodeBoost: 0 });
    expect(reranked[0].path).toBe("event:1");
  });

  it("does not mutate original array", () => {
    const results = [
      makeResult("event:1", "text1", 0.9, "conversation"),
      makeResult("event:2", "text2", 0.85, "conversation"),
    ];
    const originalOrder = results.map((r) => r.path);
    rerankResults(results, "query");
    expect(results.map((r) => r.path)).toEqual(originalOrder);
  });
});

// ---------------------------------------------------------------------------
// Telemetry emission from writeEventAndProject
// ---------------------------------------------------------------------------

describe("writeEventAndProject telemetry emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits event-write telemetry after successful write", async () => {
    const { writeEvent } = await import("./mongodb-events.js");
    const { projectEventChunk } = await import("./mongodb-events.js");
    const { recordIngestRun } = await import("./mongodb-ops.js");
    const { extractAndUpsertEntities } = await import("./mongodb-graph.js");

    vi.mocked(writeEvent).mockResolvedValue({
      eventId: "evt-1",
      timestamp: new Date("2026-03-16T00:00:00.000Z"),
      scopeRef: "agent:agent-1",
    });
    vi.mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true });
    vi.mocked(recordIngestRun).mockResolvedValue("run-1");
    vi.mocked(extractAndUpsertEntities).mockResolvedValue({ entities: [], relationsCreated: 0 });

    const fakeDb = { collection: vi.fn() } as unknown as import("mongodb").Db;
    await writeEventAndProject(fakeDb, "test_", {
      agentId: "agent-1",
      role: "user",
      body: "Hello world",
      scope: "agent",
    });

    expect(emitTelemetry).toHaveBeenCalledWith(
      fakeDb,
      "test_",
      expect.objectContaining({
        meta: { agentId: "agent-1", operation: "event-write" },
        ok: true,
        eventType: "user",
        projectionTriggered: true,
        durationMs: expect.any(Number),
      }),
    );
  });
});
