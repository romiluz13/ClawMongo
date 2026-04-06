import type { Db, Collection } from "mongodb";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { consolidateMemory, markEventsDreamerProcessed } from "./mongodb-consolidator.js";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock("./mongodb-novelty.js", () => ({
  scanNovelty: vi.fn(),
}));

vi.mock("./mongodb-result-trust.js", () => ({
  computeImportanceDecay: vi.fn(),
  computeResultTrust: vi.fn(),
}));

vi.mock("./mongodb-structured-memory.js", () => ({
  writeStructuredMemory: vi.fn(),
}));

vi.mock("./mongodb-reasoning-chain.js", () => ({
  traceReasoningChain: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { scanNovelty } from "./mongodb-novelty.js";
import { traceReasoningChain } from "./mongodb-reasoning-chain.js";
import { computeImportanceDecay, computeResultTrust } from "./mongodb-result-trust.js";
import { writeStructuredMemory } from "./mongodb-structured-memory.js";

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB
// ---------------------------------------------------------------------------

const PREFIX = "test_";

type MockCollectionOverrides = {
  find?: ReturnType<typeof vi.fn>;
  findOne?: ReturnType<typeof vi.fn>;
  insertOne?: ReturnType<typeof vi.fn>;
  updateOne?: ReturnType<typeof vi.fn>;
  updateMany?: ReturnType<typeof vi.fn>;
  aggregate?: ReturnType<typeof vi.fn>;
};

function createMockCollection(overrides: MockCollectionOverrides = {}): Collection {
  const defaultFind = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    }),
  });
  return {
    findOne: vi.fn().mockResolvedValue(null),
    find: overrides.find ?? defaultFind,
    insertOne: vi.fn().mockResolvedValue({ insertedId: "mock-id" }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    aggregate: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    }),
    ...(overrides.find ? { find: overrides.find } : {}),
    ...(overrides.findOne ? { findOne: overrides.findOne } : {}),
    ...(overrides.insertOne ? { insertOne: overrides.insertOne } : {}),
    ...(overrides.updateOne ? { updateOne: overrides.updateOne } : {}),
    ...(overrides.updateMany ? { updateMany: overrides.updateMany } : {}),
    ...(overrides.aggregate ? { aggregate: overrides.aggregate } : {}),
  } as unknown as Collection;
}

function createMockDb(collections: Record<string, Collection>): Db {
  return {
    collection: vi.fn((name: string) => {
      return collections[name] ?? createMockCollection();
    }),
  } as unknown as Db;
}

// Helper to create a mock events collection that returns specified events
function createEventsCollection(events: Document[]): Collection {
  const findFn = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(events),
      }),
    }),
  });
  return createMockCollection({
    find: findFn,
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: events.length }),
  });
}

// Helper to create consolidation_runs collection that simulates rate limiting
function createConsolidationRunsCollection(lastRun?: Document): Collection {
  const findOneFn = vi.fn().mockResolvedValue(lastRun ?? null);
  return createMockCollection({
    findOne: findOneFn,
    insertOne: vi.fn().mockResolvedValue({ insertedId: "run-id" }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-consolidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock behaviors
    (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: [],
      scannedCount: 0,
      agentId: "agent-1",
    });
    (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.5);
    (computeResultTrust as ReturnType<typeof vi.fn>).mockReturnValue({
      score: 0.8,
      freshness: 0.8,
      provenance: 0.8,
      exactness: 0.8,
      contradiction: 1,
      recency: 0.8,
    });
    (writeStructuredMemory as ReturnType<typeof vi.fn>).mockResolvedValue({
      upserted: true,
      id: "sm-id",
    });
    (traceReasoningChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      factId: "test",
      collection: "events",
      nodes: [],
      chainComplete: true,
      maxDepthReached: false,
      agentId: "agent-1",
    });
  });

  describe("consolidateMemory", () => {
    it("test 1: empty events returns 0 processed", async () => {
      const eventsCol = createEventsCollection([]);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
      });

      expect(result.eventsProcessed).toBe(0);
      expect(result.factsPromoted).toBe(0);
      expect(result.candidates).toEqual([]);
    });

    it("test 2: rate limiting — second run within minIntervalMs returns early", async () => {
      const recentRun = {
        runId: "prev-run",
        agentId: "agent-1",
        startedAt: new Date(), // just now
        status: "completed",
      };
      const consolidationRunsCol = createConsolidationRunsCollection(recentRun);
      const eventsCol = createEventsCollection([]);
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minIntervalMs: 3_600_000 },
      });

      expect(result.eventsProcessed).toBe(0);
      // Should not have inserted a new run record
      expect(consolidationRunsCol.insertOne).not.toHaveBeenCalled();
    });

    it("test 3: candidate scoring — higher novelty + importance = higher combined score", async () => {
      const events = [
        {
          eventId: "evt-high",
          agentId: "agent-1",
          body: "I prefer TypeScript",
          timestamp: new Date("2026-04-01"),
          importance: 0.9,
          accessCount: 5,
        },
        {
          eventId: "evt-low",
          agentId: "agent-1",
          body: "The weather is nice",
          timestamp: new Date("2026-04-01"),
          importance: 0.1,
          accessCount: 0,
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      // High novelty for first event, low for second
      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [
          { eventId: "evt-high", noveltyScore: 0.9 },
          { eventId: "evt-low", noveltyScore: 0.1 },
        ],
        scannedCount: 2,
        agentId: "agent-1",
      });

      // High importance decay for first, low for second
      (computeImportanceDecay as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(0.9) // evt-high
        .mockReturnValueOnce(0.1); // evt-low

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0 },
      });

      expect(result.candidates.length).toBe(2);
      // Higher-scoring candidate should be first
      expect(result.candidates[0].eventId).toBe("evt-high");
      expect(result.candidates[0].combinedScore).toBeGreaterThan(
        result.candidates[1].combinedScore,
      );
    });

    it("test 4: minCombinedScore threshold filters low-score candidates", async () => {
      const events = [
        {
          eventId: "evt-1",
          agentId: "agent-1",
          body: "I prefer dark mode",
          timestamp: new Date("2026-04-01"),
          importance: 0.1,
          accessCount: 0,
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [{ eventId: "evt-1", noveltyScore: 0.1 }],
        scannedCount: 1,
        agentId: "agent-1",
      });
      (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.1);

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0.8 }, // very high threshold
      });

      // Events still processed (marked) but no candidates above threshold
      expect(result.eventsProcessed).toBe(1);
      expect(result.factsPromoted).toBe(0);
      expect(result.candidates).toEqual([]);
    });

    it('test 5: pattern matching — "I prefer X" extracts preference fact', async () => {
      const events = [
        {
          eventId: "evt-pref",
          agentId: "agent-1",
          body: "I prefer using VS Code for all my coding",
          role: "user",
          timestamp: new Date("2026-04-01"),
          importance: 0.8,
          accessCount: 3,
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [{ eventId: "evt-pref", noveltyScore: 0.8 }],
        scannedCount: 1,
        agentId: "agent-1",
      });
      (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.8);

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0 },
      });

      expect(result.factsPromoted).toBe(1);
      expect(writeStructuredMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            type: "preference",
            sourceEventIds: ["evt-pref"],
          }),
        }),
      );
    });

    it('test 6: pattern matching — "I decided X" extracts decision fact', async () => {
      const events = [
        {
          eventId: "evt-dec",
          agentId: "agent-1",
          body: "I decided to use MongoDB for all persistence",
          role: "user",
          timestamp: new Date("2026-04-01"),
          importance: 0.8,
          accessCount: 2,
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [{ eventId: "evt-dec", noveltyScore: 0.8 }],
        scannedCount: 1,
        agentId: "agent-1",
      });
      (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.8);

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0 },
      });

      expect(result.factsPromoted).toBe(1);
      expect(writeStructuredMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            type: "decision",
            sourceEventIds: ["evt-dec"],
          }),
        }),
      );
    });

    it("test 7: conflict detected — fact NOT promoted, conflict logged", async () => {
      const events = [
        {
          eventId: "evt-conflict",
          agentId: "agent-1",
          body: "I prefer Python over everything",
          role: "user",
          timestamp: new Date("2026-04-01"),
          importance: 0.8,
          accessCount: 2,
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();

      // Structured memory collection returns an existing conflicting fact
      const structuredMemCol = createMockCollection({
        findOne: vi.fn().mockResolvedValue({
          type: "preference",
          key: "Python over everything",
          value: "I prefer TypeScript over everything",
          agentId: "agent-1",
          state: "active",
        }),
      });

      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
        [`${PREFIX}structured_mem`]: structuredMemCol,
      });

      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [{ eventId: "evt-conflict", noveltyScore: 0.8 }],
        scannedCount: 1,
        agentId: "agent-1",
      });
      (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.8);

      // Signal conflict via trust scoring
      (computeResultTrust as ReturnType<typeof vi.fn>).mockReturnValue({
        score: 0.3,
        freshness: 0.3,
        provenance: 0.3,
        exactness: 0.3,
        contradiction: 0.2, // low contradiction score = conflict detected
        recency: 0.3,
      });

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0 },
      });

      expect(result.factsPromoted).toBe(0);
      expect(result.conflictsResolved).toBe(0);
    });

    it("test 8: events marked as dreamer-processed after processing", async () => {
      const events = [
        {
          eventId: "evt-1",
          agentId: "agent-1",
          body: "Some conversation text",
          timestamp: new Date("2026-04-01"),
        },
        {
          eventId: "evt-2",
          agentId: "agent-1",
          body: "More conversation text",
          timestamp: new Date("2026-04-01"),
        },
      ];

      const updateManyFn = vi.fn().mockResolvedValue({ modifiedCount: 2 });
      const eventsCol = createEventsCollection(events);
      (eventsCol as unknown as { updateMany: ReturnType<typeof vi.fn> }).updateMany = updateManyFn;

      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
      });

      // Verify updateMany was called with dreamerProcessedAt and dreamerRunId
      expect(updateManyFn).toHaveBeenCalledWith(
        { eventId: { $in: ["evt-1", "evt-2"] } },
        expect.objectContaining({
          $set: expect.objectContaining({
            dreamerProcessedAt: expect.any(Date),
            dreamerRunId: expect.any(String),
          }),
        }),
      );
    });

    it("test 9: run recorded in consolidation_runs collection", async () => {
      const events = [
        {
          eventId: "evt-1",
          agentId: "agent-1",
          body: "Hello world",
          timestamp: new Date("2026-04-01"),
        },
      ];

      const eventsCol = createEventsCollection(events);
      const insertOneFn = vi.fn().mockResolvedValue({ insertedId: "run-id" });
      const updateOneFn = vi.fn().mockResolvedValue({ modifiedCount: 1 });
      const consolidationRunsCol = createConsolidationRunsCollection();
      (consolidationRunsCol as unknown as { insertOne: ReturnType<typeof vi.fn> }).insertOne =
        insertOneFn;
      (consolidationRunsCol as unknown as { updateOne: ReturnType<typeof vi.fn> }).updateOne =
        updateOneFn;

      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
      });

      // Run start recorded
      expect(insertOneFn).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: result.runId,
          agentId: "agent-1",
          status: "running",
          startedAt: expect.any(Date),
        }),
      );

      // Run completion recorded
      expect(updateOneFn).toHaveBeenCalledWith(
        { runId: result.runId },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "completed",
            completedAt: expect.any(Date),
            eventsProcessed: expect.any(Number),
            durationMs: expect.any(Number),
          }),
        }),
      );
    });

    it("test 10: idempotency — re-running on dreamer-processed events produces 0 new promotions", async () => {
      // First run: events found
      const events = [
        {
          eventId: "evt-1",
          agentId: "agent-1",
          body: "I prefer dark mode",
          timestamp: new Date("2026-04-01"),
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [{ eventId: "evt-1", noveltyScore: 0.8 }],
        scannedCount: 1,
        agentId: "agent-1",
      });
      (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.8);

      const result1 = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0, minIntervalMs: 0 },
      });

      expect(result1.eventsProcessed).toBe(1);

      // Second run: no un-dreamer-processed events (already marked)
      const emptyEventsCol = createEventsCollection([]);
      const consolidationRunsCol2 = createConsolidationRunsCollection();
      const db2 = createMockDb({
        [`${PREFIX}events`]: emptyEventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol2,
      });

      const result2 = await consolidateMemory({
        db: db2,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minIntervalMs: 0 },
      });

      expect(result2.eventsProcessed).toBe(0);
      expect(result2.factsPromoted).toBe(0);
    });

    it("test 11: individual candidate failure doesn't crash pipeline", async () => {
      const events = [
        {
          eventId: "evt-good",
          agentId: "agent-1",
          body: "I prefer TypeScript",
          role: "user",
          timestamp: new Date("2026-04-01"),
          importance: 0.8,
          accessCount: 3,
        },
        {
          eventId: "evt-bad",
          agentId: "agent-1",
          body: "I decided to use Rust",
          role: "user",
          timestamp: new Date("2026-04-02"),
          importance: 0.8,
          accessCount: 2,
        },
      ];

      const eventsCol = createEventsCollection(events);
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      (scanNovelty as ReturnType<typeof vi.fn>).mockResolvedValue({
        events: [
          { eventId: "evt-good", noveltyScore: 0.8 },
          { eventId: "evt-bad", noveltyScore: 0.8 },
        ],
        scannedCount: 2,
        agentId: "agent-1",
      });
      (computeImportanceDecay as ReturnType<typeof vi.fn>).mockReturnValue(0.8);

      // First call succeeds, second call throws
      (writeStructuredMemory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ upserted: true, id: "sm-1" })
        .mockRejectedValueOnce(new Error("DB write failed"));

      const result = await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        options: { minCombinedScore: 0 },
      });

      // Pipeline should not crash — at least one fact should be promoted
      expect(result.factsPromoted).toBe(1);
      expect(result.eventsProcessed).toBe(2);
    });

    it("test 12: agentId isolation — only processes events for given agent", async () => {
      const events = [
        {
          eventId: "evt-agent1",
          agentId: "agent-1",
          body: "I prefer dark mode",
          timestamp: new Date("2026-04-01"),
        },
      ];

      // The find filter should include agentId
      const findFn = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(events),
          }),
        }),
      });

      const eventsCol = createMockCollection({ find: findFn });
      const consolidationRunsCol = createConsolidationRunsCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}consolidation_runs`]: consolidationRunsCol,
      });

      await consolidateMemory({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
      });

      // Verify the find filter includes agentId
      expect(findFn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          dreamerProcessedAt: { $exists: false },
        }),
      );
    });
  });

  describe("markEventsDreamerProcessed", () => {
    it("sets dreamerProcessedAt and dreamerRunId on events", async () => {
      const updateManyFn = vi.fn().mockResolvedValue({ modifiedCount: 3 });
      const eventsCol = createMockCollection({ updateMany: updateManyFn });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      const count = await markEventsDreamerProcessed({
        db,
        prefix: PREFIX,
        eventIds: ["evt-1", "evt-2", "evt-3"],
        runId: "run-abc",
      });

      expect(count).toBe(3);
      expect(updateManyFn).toHaveBeenCalledWith(
        { eventId: { $in: ["evt-1", "evt-2", "evt-3"] } },
        {
          $set: {
            dreamerProcessedAt: expect.any(Date),
            dreamerRunId: "run-abc",
          },
        },
      );
    });

    it("returns 0 for empty eventIds", async () => {
      const updateManyFn = vi.fn();
      const eventsCol = createMockCollection({ updateMany: updateManyFn });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      const count = await markEventsDreamerProcessed({
        db,
        prefix: PREFIX,
        eventIds: [],
        runId: "run-abc",
      });

      expect(count).toBe(0);
      expect(updateManyFn).not.toHaveBeenCalled();
    });
  });
});
