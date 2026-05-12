import type { Db, Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import { scanNovelty } from "./mongodb-novelty.js";

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(overrides: Partial<Record<string, unknown>> = {}): Collection {
  return {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
      toArray: vi.fn().mockResolvedValue([]),
    }),
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
const AGENT_ID = "agent-1";

// Helper to create events with embeddings
function makeEvent(overrides: Partial<Document> = {}): Document {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
    agentId: AGENT_ID,
    role: "user",
    body: "some event body",
    scope: "agent",
    scopeRef: "agent-1",
    timestamp: new Date("2026-01-15"),
    embedding: Array.from({ length: 4 }, () => Math.random()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-novelty", () => {
  describe("scanNovelty", () => {
    it("returns empty report when events collection is empty", async () => {
      const eventsCol = createMockCollection();
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      const report = await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID });

      expect(report.events).toEqual([]);
      expect(report.scannedCount).toBe(0);
      expect(report.agentId).toBe(AGENT_ID);
      expect(report.error).toBeUndefined();
    });

    it("returns empty report when events have no embeddings", async () => {
      const eventsWithoutEmbeddings = [
        makeEvent({ embedding: undefined }),
        makeEvent({ embedding: undefined }),
      ];
      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventsWithoutEmbeddings),
            }),
          }),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      const report = await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID });

      expect(report.events).toEqual([]);
      expect(report.scannedCount).toBe(0);
      expect(report.error).toBeUndefined();
    });

    it("returns error report (not exception) when mongot is unavailable", async () => {
      const eventsWithEmbeddings = [
        makeEvent({ eventId: "evt-1", embedding: [0.1, 0.2, 0.3, 0.4] }),
        makeEvent({ eventId: "evt-2", embedding: [0.5, 0.6, 0.7, 0.8] }),
      ];
      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventsWithEmbeddings),
            }),
          }),
        }),
        // $vectorSearch fails — mongot not available
        aggregate: vi.fn().mockReturnValue({
          toArray: vi
            .fn()
            .mockRejectedValue(new Error("PlanExecutor error: $vectorSearch is not allowed")),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      // Must NOT throw — should return degraded report
      const report = await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID });

      expect(report.events).toEqual([]);
      expect(report.scannedCount).toBe(0);
      expect(report.error).toBe("mongot_unavailable");
      expect(report.agentId).toBe(AGENT_ID);
    });

    it("isolates by agentId — only scans events for the given agent", async () => {
      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID });

      // Verify the find call includes agentId filter
      const findCall = (eventsCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(findCall[0]).toEqual(expect.objectContaining({ agentId: AGENT_ID }));
    });

    it("scores events — event far from centroid has higher novelty score", async () => {
      // Create events where one is clearly an outlier
      const normalEvent1 = makeEvent({
        eventId: "evt-normal-1",
        embedding: [0.49, 0.51, 0.5, 0.5],
        body: "normal event 1",
      });
      const normalEvent2 = makeEvent({
        eventId: "evt-normal-2",
        embedding: [0.51, 0.49, 0.5, 0.5],
        body: "normal event 2",
      });
      const outlierEvent = makeEvent({
        eventId: "evt-outlier",
        embedding: [0.99, 0.01, 0.99, 0.01], // far from centroid
        body: "outlier event",
      });
      const allEvents = [normalEvent1, normalEvent2, outlierEvent];

      // $vectorSearch returns results ordered by similarity (closest to centroid first)
      // Normal events are most similar to centroid, outlier is least similar
      const vectorSearchResults = [
        { eventId: "evt-normal-1", score: 0.99 },
        { eventId: "evt-normal-2", score: 0.98 },
        { eventId: "evt-outlier", score: 0.45 },
      ];

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(allEvents),
            }),
          }),
        }),
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(
            vectorSearchResults.map((r) =>
              Object.assign({}, allEvents.find((e) => e.eventId === r.eventId), {
                __vectorSearchScore: r.score,
              }),
            ),
          ),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      const report = await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID });

      expect(report.events.length).toBeGreaterThan(0);
      expect(report.scannedCount).toBe(3);

      // The outlier should have the highest novelty score
      const outlierResult = report.events.find((e) => e.eventId === "evt-outlier");
      const normalResult = report.events.find((e) => e.eventId === "evt-normal-1");
      expect(outlierResult).toBeDefined();
      expect(normalResult).toBeDefined();
      expect(outlierResult!.noveltyScore).toBeGreaterThan(normalResult!.noveltyScore);
    });

    it("respects limit parameter", async () => {
      // Create 5 events with embeddings
      const events = Array.from({ length: 5 }, (_, i) =>
        makeEvent({
          eventId: `evt-${i}`,
          embedding: Array.from({ length: 4 }, () => Math.random()),
          body: `event ${i}`,
        }),
      );

      const vectorSearchResults = events.map((e, i) => ({
        ...e,
        __vectorSearchScore: 0.9 - i * 0.1,
      }));

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(events),
            }),
          }),
        }),
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(vectorSearchResults),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      const report = await scanNovelty({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        options: { limit: 2 },
      });

      expect(report.events.length).toBeLessThanOrEqual(2);
    });

    it("applies scope filter", async () => {
      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      await scanNovelty({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        options: { scope: "workspace" },
      });

      const findCall = (eventsCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(findCall[0]).toEqual(expect.objectContaining({ scope: "workspace" }));
    });

    it("applies time range filter", async () => {
      const start = new Date("2026-01-01");
      const end = new Date("2026-01-31");
      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
      const db = createMockDb({ [`${PREFIX}events`]: eventsCol });

      await scanNovelty({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        options: { timeRange: { start, end } },
      });

      const findCall = (eventsCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(findCall[0]).toEqual(
        expect.objectContaining({
          timestamp: { $gte: start, $lte: end },
        }),
      );
    });
  });
});
