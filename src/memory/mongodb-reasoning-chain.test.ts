import type { Db, Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import { traceReasoningChain } from "./mongodb-reasoning-chain.js";

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection (same pattern as mongodb-graph.test.ts)
// ---------------------------------------------------------------------------

function createMockCollection(overrides: Partial<Record<string, unknown>> = {}): Collection {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    aggregate: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    }),
    ...overrides,
  } as unknown as Collection;
}

function createMockDb(collections: Record<string, Collection>): Db {
  return {
    collection: vi.fn((name: string) => {
      return collections[name] ?? createMockCollection();
    }),
  } as unknown as Db;
}

const PREFIX = "test_";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-reasoning-chain", () => {
  describe("traceReasoningChain", () => {
    it("single-hop chain — fact with 2 sourceEventIds returns 3-node chain", async () => {
      const factDoc = {
        type: "preference",
        key: "editor",
        value: "I prefer VS Code",
        agentId: "agent-1",
        sourceEventIds: ["evt-1", "evt-2"],
        updatedAt: new Date("2026-04-01"),
      };

      const evt1 = {
        eventId: "evt-1",
        body: "I like VS Code",
        role: "user",
        agentId: "agent-1",
        timestamp: new Date("2026-03-01"),
      };
      const evt2 = {
        eventId: "evt-2",
        body: "Yes I prefer VS Code for everything",
        role: "user",
        agentId: "agent-1",
        timestamp: new Date("2026-03-15"),
      };

      // The aggregate pipeline finds the fact and does $lookup for events
      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [evt1, evt2],
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "editor",
        collection: "structured_mem",
      });

      expect(result.nodes).toHaveLength(3);
      // Events first (oldest to newest), fact last
      expect(result.nodes[0].type).toBe("event");
      expect(result.nodes[0].id).toBe("evt-1");
      expect(result.nodes[0].timestamp).toEqual(new Date("2026-03-01"));
      expect(result.nodes[1].type).toBe("event");
      expect(result.nodes[1].id).toBe("evt-2");
      expect(result.nodes[2].type).toBe("fact");
      expect(result.nodes[2].id).toBe("editor");
      expect(result.chainComplete).toBe(true);
      expect(result.maxDepthReached).toBe(false);
      expect(result.agentId).toBe("agent-1");
    });

    it("fact with no sourceEventIds returns single-node chain (fact only)", async () => {
      const factDoc = {
        type: "fact",
        key: "city",
        value: "Lives in NYC",
        agentId: "agent-1",
        // No sourceEventIds field
        updatedAt: new Date("2026-04-01"),
      };

      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [], // $ifNull produces empty array
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "city",
        collection: "structured_mem",
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe("fact");
      expect(result.nodes[0].id).toBe("city");
      expect(result.chainComplete).toBe(true);
    });

    it("fact not found returns empty chain with chainComplete: true", async () => {
      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "nonexistent",
        collection: "structured_mem",
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.chainComplete).toBe(true);
      expect(result.factId).toBe("nonexistent");
    });

    it("agentId isolation — chain for agent-A does not include agent-B fact", async () => {
      // Agent-B's fact should not be returned when querying for agent-A
      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]), // not found for agent-A
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-A",
        factId: "some-key",
        collection: "structured_mem",
      });

      // Verify agentId is in the pipeline match
      const aggregateFn = sourceCol.aggregate as ReturnType<typeof vi.fn>;
      expect(aggregateFn).toHaveBeenCalledOnce();
      const [pipeline] = aggregateFn.mock.calls[0] as [Document[]];
      const matchStage = pipeline.find((s: Document) => s.$match);
      expect(matchStage?.$match?.agentId).toBe("agent-A");

      // Verify agentId is in the $lookup pipeline too
      const lookupStage = pipeline.find((s: Document) => s.$lookup);
      expect(lookupStage).toBeDefined();
      const lookupPipeline = lookupStage!.$lookup.pipeline as Document[];
      const lookupMatch = lookupPipeline.find((s: Document) => s.$match);
      expect(lookupMatch?.$match?.agentId).toBe("agent-A");

      expect(result.nodes).toHaveLength(0);
      expect(result.agentId).toBe("agent-A");
    });

    it("maxDepth clamping — maxDepth=0 produces valid behavior", async () => {
      const factDoc = {
        type: "fact",
        key: "test-key",
        value: "test value",
        agentId: "agent-1",
        sourceEventIds: ["evt-1"],
        updatedAt: new Date("2026-04-01"),
      };

      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [
                {
                  eventId: "evt-1",
                  body: "original",
                  role: "user",
                  agentId: "agent-1",
                  timestamp: new Date("2026-03-01"),
                },
              ],
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      // maxDepth=0 should still return valid results (single-hop, depth clamped to 0)
      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "test-key",
        collection: "structured_mem",
        options: { maxDepth: 0 },
      });

      // With maxDepth=0, we still get the fact and its direct source events
      // because the single-hop $lookup is always performed
      expect(result.maxDepthReached).toBe(true);
      expect(result.factId).toBe("test-key");
    });

    it("deleted event in sourceEventIds produces gap node", async () => {
      const factDoc = {
        type: "preference",
        key: "lang",
        value: "Prefers TypeScript",
        agentId: "agent-1",
        sourceEventIds: ["evt-1", "evt-deleted"],
        updatedAt: new Date("2026-04-01"),
      };

      // Only evt-1 resolves; evt-deleted is missing
      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [
                {
                  eventId: "evt-1",
                  body: "I use TypeScript",
                  role: "user",
                  agentId: "agent-1",
                  timestamp: new Date("2026-03-01"),
                },
              ],
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "lang",
        collection: "structured_mem",
      });

      // 3 nodes: 1 event + 1 gap + 1 fact
      expect(result.nodes).toHaveLength(3);
      const gapNode = result.nodes.find((n) => n.type === "gap");
      expect(gapNode).toBeDefined();
      expect(gapNode!.id).toBe("evt-deleted");
      expect(gapNode!.reason).toBe("deleted");
      expect(result.chainComplete).toBe(false);
    });

    it("empty sourceEventIds array returns single-node chain", async () => {
      const factDoc = {
        type: "fact",
        key: "empty-sources",
        value: "A fact with empty sources",
        agentId: "agent-1",
        sourceEventIds: [],
        updatedAt: new Date("2026-04-01"),
      };

      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [],
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "empty-sources",
        collection: "structured_mem",
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe("fact");
      expect(result.nodes[0].id).toBe("empty-sources");
      expect(result.chainComplete).toBe(true);
    });

    it("collection name validation — unknown collection returns empty chain", async () => {
      const db = createMockDb({});

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "some-fact",
        collection: "nonexistent_collection",
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.chainComplete).toBe(true);
      expect(result.collection).toBe("nonexistent_collection");
    });

    it("chain ordering — events sorted by timestamp ascending, fact last", async () => {
      const factDoc = {
        type: "fact",
        key: "ordering-test",
        value: "test ordering",
        agentId: "agent-1",
        sourceEventIds: ["evt-a", "evt-b", "evt-c"],
        updatedAt: new Date("2026-04-01"),
      };

      // Events returned already sorted by the pipeline (timestamp: 1)
      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [
                {
                  eventId: "evt-a",
                  body: "first event",
                  role: "user",
                  agentId: "agent-1",
                  timestamp: new Date("2026-01-01"),
                },
                {
                  eventId: "evt-b",
                  body: "second event",
                  role: "assistant",
                  agentId: "agent-1",
                  timestamp: new Date("2026-02-01"),
                },
                {
                  eventId: "evt-c",
                  body: "third event",
                  role: "user",
                  agentId: "agent-1",
                  timestamp: new Date("2026-03-01"),
                },
              ],
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "ordering-test",
        collection: "structured_mem",
      });

      expect(result.nodes).toHaveLength(4);
      // Events ordered by timestamp ascending
      expect(result.nodes[0].type).toBe("event");
      expect(result.nodes[0].id).toBe("evt-a");
      expect(result.nodes[0].timestamp).toEqual(new Date("2026-01-01"));
      expect(result.nodes[1].type).toBe("event");
      expect(result.nodes[1].id).toBe("evt-b");
      expect(result.nodes[1].timestamp).toEqual(new Date("2026-02-01"));
      expect(result.nodes[2].type).toBe("event");
      expect(result.nodes[2].id).toBe("evt-c");
      // Fact is last
      expect(result.nodes[3].type).toBe("fact");
      expect(result.nodes[3].id).toBe("ordering-test");
    });

    it("maxDepth respected — chain uses clamped depth", async () => {
      const factDoc = {
        type: "fact",
        key: "depth-test",
        value: "test depth",
        agentId: "agent-1",
        sourceEventIds: ["evt-1"],
        updatedAt: new Date("2026-04-01"),
      };

      const sourceCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              ...factDoc,
              sourceEvents: [
                {
                  eventId: "evt-1",
                  body: "an event",
                  role: "user",
                  agentId: "agent-1",
                  timestamp: new Date("2026-03-01"),
                },
              ],
            },
          ]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}structured_mem`]: sourceCol,
      });

      // Negative maxDepth should be clamped to 0
      const result = await traceReasoningChain({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        factId: "depth-test",
        collection: "structured_mem",
        options: { maxDepth: -5 },
      });

      // Even with negative maxDepth (clamped to 0), single-hop still works
      expect(result.maxDepthReached).toBe(true);
      expect(result.factId).toBe("depth-test");
    });
  });
});
