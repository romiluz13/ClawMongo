import type { Collection, Db, Document } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mongodb-active-slate.js", () => ({
  hydrateActiveSlate: vi.fn(),
}));

vi.mock("./mongodb-discovery-projections.js", () => ({
  buildDiscoveryProjection: vi.fn(),
}));

vi.mock("./mongodb-profile.js", () => ({
  synthesizeProfile: vi.fn(),
}));

vi.mock("./mongodb-schema.js", () => ({
  episodesCollection: vi.fn(),
  eventsCollection: vi.fn(),
}));

vi.mock("./mongodb-telemetry.js", () => ({
  emitTelemetry: vi.fn(),
}));

import { hydrateActiveSlate } from "./mongodb-active-slate.js";
import { buildContextBundle } from "./mongodb-context-bundle.js";
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js";
import { synthesizeProfile } from "./mongodb-profile.js";
import { episodesCollection, eventsCollection } from "./mongodb-schema.js";
import { emitTelemetry } from "./mongodb-telemetry.js";

const PREFIX = "test_";
const AGENT_ID = "agent-1";

function createFindCollection(params: { next?: Document | null; docs?: Document[] }): Collection {
  const cursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    project: vi.fn(),
    next: vi.fn().mockResolvedValue(params.next ?? null),
    toArray: vi.fn().mockResolvedValue(params.docs ?? []),
  };
  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  cursor.project.mockReturnValue(cursor);
  return {
    find: vi.fn().mockReturnValue(cursor),
  } as unknown as Collection;
}

describe("mongodb-context-bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hydrateActiveSlate).mockResolvedValue({
      agentId: AGENT_ID,
      scope: "agent",
      scopeRef: "agent:agent-1",
      items: [
        {
          kind: "active-critical",
          source: "structured",
          title: "phoenix-current-blocker",
          summary: "Atlas Local preview validation is blocking the Phoenix launch.",
          path: "structured:project:phoenix-current-blocker",
          timestamp: new Date("2026-04-05T10:00:00.000Z"),
        },
        {
          kind: "procedure",
          source: "procedural",
          title: "Phoenix rollback runbook",
          summary: "Disable rollout, restore stable image, verify health checks.",
          path: "procedure:phoenix-rollback",
          timestamp: new Date("2026-04-05T09:45:00.000Z"),
        },
      ],
      metadata: {
        maxItems: 4,
        truncated: false,
        partial: false,
        countsByKind: { "active-critical": 1, procedure: 1 },
        sourceCounts: { structured: 1, procedural: 1 },
      },
      hydratedAt: new Date("2026-04-05T10:00:00.000Z"),
    });
    vi.mocked(buildDiscoveryProjection).mockResolvedValue({
      kind: "topic-brief",
      query: "Phoenix",
      title: "Phoenix topic brief",
      summary: "Phoenix has one active blocker and one rollback procedure.",
      scope: "agent",
      scopeRef: "agent:agent-1",
      sections: [],
      metadata: { partial: false, evidenceCount: 0, sourceCounts: {} },
      builtAt: new Date("2026-04-05T10:00:00.000Z"),
    });
    vi.mocked(synthesizeProfile).mockResolvedValue({
      agentId: AGENT_ID,
      scope: "agent",
      scopeRef: "agent:agent-1",
      preferences: [],
      decisions: [
        {
          key: "phoenix-release-window",
          value: "Phoenix deploys after validation completes.",
          salience: "high",
          updatedAt: new Date("2026-04-05T10:00:00.000Z"),
        },
      ],
      facts: [],
      todos: [],
      topEntities: [],
      recentEpisodes: [],
      activityPatterns: {
        roleDistribution: {},
        totalEvents: 0,
        lastActive: null,
      },
      synthesizedAt: new Date("2026-04-05T10:00:00.000Z"),
    });
  });

  it("assembles active state, durable evidence, summary, and session events into a prompt-ready bundle", async () => {
    vi.mocked(episodesCollection).mockReturnValue(
      createFindCollection({
        next: {
          episodeId: "ep-1",
          title: "Phoenix launch review",
          summary: "The team aligned on launch timing and remaining blockers.",
          shortTermSummary: "Phoenix launch remains blocked on Atlas Local preview validation.",
          timeRange: {
            end: new Date("2026-04-05T09:55:00.000Z"),
          },
          scope: "agent",
          scopeRef: "agent:agent-1",
          sourceEventIds: ["evt-1"],
        },
      }),
    );
    vi.mocked(eventsCollection).mockReturnValue(
      createFindCollection({
        docs: [
          {
            eventId: "evt-10",
            role: "user",
            body: "The current blocker is Atlas Local preview validation.",
            timestamp: new Date("2026-04-05T10:05:00.000Z"),
            scope: "session",
            scopeRef: "session:session-main",
          },
          {
            eventId: "evt-11",
            role: "assistant",
            body: "I will prepare the rollout brief once validation passes.",
            timestamp: new Date("2026-04-05T10:06:00.000Z"),
            scope: "session",
            scopeRef: "session:session-main",
          },
        ],
      }),
    );

    const bundle = await buildContextBundle({
      db: {} as Db,
      prefix: PREFIX,
      agentId: AGENT_ID,
      scope: "agent",
      scopeRef: "agent:agent-1",
      request: {
        query: "Phoenix handoff",
        sessionId: "session-main",
        tokenBudget: 320,
      },
      search: vi.fn().mockResolvedValue({
        results: [
          {
            path: "structured:decision:phoenix-release-window",
            startLine: 0,
            endLine: 0,
            score: 0.94,
            snippet: "Phoenix deploys on Monday afternoon after validation completes.",
            source: "structured",
            canonicalId: "structured:decision:phoenix-release-window",
            timestamp: new Date("2026-04-05T09:00:00.000Z"),
            scope: "agent",
            scopeRef: "agent:agent-1",
            trust: {
              score: 0.92,
              freshness: 0.91,
              provenance: 0.9,
              exactness: 1,
              contradiction: 0,
              recency: 0.88,
            },
          },
        ],
        pathsExecuted: ["structured", "procedural"],
        trustSummary: {
          topScore: 0.92,
          averageScore: 0.92,
          topBand: "high",
          distribution: { high: 1, medium: 0, low: 0 },
          contradictionCount: 0,
          staleCount: 0,
          exactCount: 1,
          sourceDiversity: "single",
        },
      }),
    });

    expect(bundle.sections.map((section) => section.kind)).toEqual([
      "active-slate",
      "query-evidence",
      "summary",
      "recent-events",
    ]);
    expect(bundle.metadata.pathsExecuted).toEqual([
      "active-slate",
      "structured",
      "procedural",
      "episode-summary",
      "recent-events",
    ]);
    expect(bundle.metadata.trustSummary?.topBand).toBe("high");
    expect(bundle.rendered).toContain("## Active Slate");
    expect(bundle.rendered).toContain("## Query Evidence");
    expect(bundle.rendered).toContain("## Recent Session Events");
    expect(hydrateActiveSlate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "agent",
        scopeRef: "agent:agent-1",
      }),
    );
    expect(
      vi.mocked(vi.mocked(eventsCollection).mock.results[0]?.value.find).mock.calls[0]?.[0],
    ).toEqual({
      agentId: AGENT_ID,
      scope: "session",
      scopeRef: "session:session-main",
    });
    expect(emitTelemetry).toHaveBeenCalledWith(
      expect.anything(),
      PREFIX,
      expect.objectContaining({
        meta: expect.objectContaining({ operation: "context-bundle" }),
      }),
    );
  });

  it("adds discovery projection and profile sections when requested", async () => {
    vi.mocked(episodesCollection).mockReturnValue(createFindCollection({ next: null }));
    vi.mocked(eventsCollection).mockReturnValue(createFindCollection({ docs: [] }));

    const bundle = await buildContextBundle({
      db: {} as Db,
      prefix: PREFIX,
      agentId: AGENT_ID,
      scope: "agent",
      scopeRef: "agent:agent-1",
      request: {
        query: "Phoenix",
        tokenBudget: 1200,
        includeDiscoveryProjection: true,
        includeProfile: true,
      },
      search: vi.fn().mockResolvedValue({
        results: [],
        pathsExecuted: [],
      }),
    });

    expect(bundle.sections.map((section) => section.kind)).toContain("discovery-projection");
    expect(bundle.sections.map((section) => section.kind)).toContain("profile");
    expect(bundle.metadata.pathsExecuted).toContain("discovery-projection");
    expect(bundle.metadata.pathsExecuted).toContain("profile");
  });
});
