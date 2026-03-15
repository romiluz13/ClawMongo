/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  materializeEpisode,
  getEpisodesByTimeRange,
  getEpisodesByType,
  searchEpisodes,
  type Episode,
  type EpisodeSummarizer,
} from "./mongodb-episodes.js";

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(overrides: Partial<Record<string, unknown>> = {}): Collection {
  return {
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1, matchedCount: 0, modifiedCount: 0 }),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
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

const mockSummarizer: EpisodeSummarizer = vi.fn().mockResolvedValue({
  title: "Daily Standup Notes",
  summary: "Discussed project roadmap and blockers",
  tags: ["standup", "planning"],
});

function makeEventDocs(count: number, start: Date): Document[] {
  const docs: Document[] = [];
  for (let i = 0; i < count; i++) {
    docs.push({
      eventId: `evt-${i}`,
      agentId: AGENT_ID,
      role: i % 2 === 0 ? "user" : "assistant",
      body: `Message ${i}`,
      scope: "agent",
      timestamp: new Date(start.getTime() + i * 60_000),
    });
  }
  return docs;
}

function makeEpisodeDoc(overrides: Partial<Episode> = {}): Document {
  return {
    episodeId: "ep-1",
    type: "daily",
    title: "Daily Standup Notes",
    summary: "Discussed project roadmap and blockers",
    agentId: AGENT_ID,
    scope: "agent",
    timeRange: {
      start: new Date("2026-03-15T09:00:00Z"),
      end: new Date("2026-03-15T10:00:00Z"),
    },
    sourceEventCount: 5,
    sourceEventIds: ["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"],
    tags: ["standup", "planning"],
    updatedAt: new Date("2026-03-15T10:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-episodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("materializeEpisode", () => {
    it("creates an episode from a time range of events", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      // Events collection returns 5 events for the time range
      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      // Episodes collection for the upsert
      const episodesCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      const result = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
        timeRange: { start, end },
        summarizer: mockSummarizer,
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("daily");
      expect(result!.title).toBe("Daily Standup Notes");
      expect(result!.summary).toBe("Discussed project roadmap and blockers");
      expect(result!.agentId).toBe(AGENT_ID);
      expect(result!.sourceEventCount).toBe(5);
      expect(result!.timeRange.start).toEqual(start);
      expect(result!.timeRange.end).toEqual(end);

      // Verify summarizer was called with events
      expect(mockSummarizer).toHaveBeenCalledOnce();
      const summarizerArgs = (mockSummarizer as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(summarizerArgs).toHaveLength(5);
      expect(summarizerArgs[0].role).toBe("user");
      expect(summarizerArgs[0].body).toBe("Message 0");

      // Verify upsert was called on episodes collection
      expect(episodesCol.updateOne).toHaveBeenCalledOnce();
    });

    it("stores sourceEventCount and sample sourceEventIds", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      const episodesCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      const result = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
        timeRange: { start, end },
        summarizer: mockSummarizer,
      });

      expect(result).not.toBeNull();
      expect(result!.sourceEventCount).toBe(5);
      expect(result!.sourceEventIds).toBeDefined();
      expect(result!.sourceEventIds).toEqual(["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]);

      // Verify the upsert includes sourceEventCount and sourceEventIds
      const [, update] = (episodesCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(update.$set.sourceEventCount).toBe(5);
      expect(update.$set.sourceEventIds).toEqual(["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]);
    });

    it("returns null when fewer than 2 events in time range", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(1, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      const episodesCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      const result = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
        timeRange: { start, end },
        summarizer: mockSummarizer,
      });

      expect(result).toBeNull();
      // Summarizer should NOT be called
      expect(mockSummarizer).not.toHaveBeenCalled();
      // No upsert should happen
      expect(episodesCol.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("getEpisodesByTimeRange", () => {
    it("returns episodes overlapping the range", async () => {
      const episodeDoc = makeEpisodeDoc();
      const findResult = {
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([episodeDoc]),
          }),
        }),
      };
      const episodesCol = createMockCollection({
        find: vi.fn().mockReturnValue(findResult),
      });
      const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol });

      const results = await getEpisodesByTimeRange({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        start: new Date("2026-03-15T08:00:00Z"),
        end: new Date("2026-03-15T11:00:00Z"),
      });

      expect(results).toHaveLength(1);
      expect(results[0].episodeId).toBe("ep-1");
      expect(results[0].type).toBe("daily");

      // Verify the overlap query: episode.timeRange.start <= end AND episode.timeRange.end >= start
      const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter.agentId).toBe(AGENT_ID);
      expect(filter["timeRange.start"]).toEqual({ $lte: new Date("2026-03-15T11:00:00Z") });
      expect(filter["timeRange.end"]).toEqual({ $gte: new Date("2026-03-15T08:00:00Z") });
    });
  });

  describe("getEpisodesByType", () => {
    it("returns episodes of a given type", async () => {
      const episodeDoc = makeEpisodeDoc();
      const findResult = {
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([episodeDoc]),
          }),
        }),
      };
      const episodesCol = createMockCollection({
        find: vi.fn().mockReturnValue(findResult),
      });
      const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol });

      const results = await getEpisodesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
      });

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("daily");

      const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter).toEqual({ agentId: AGENT_ID, type: "daily" });
    });
  });

  describe("searchEpisodes", () => {
    it("uses regex search on summary/title", async () => {
      const episodeDoc = makeEpisodeDoc();
      const findResult = {
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([episodeDoc]),
          }),
        }),
      };
      const episodesCol = createMockCollection({
        find: vi.fn().mockReturnValue(findResult),
      });
      const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol });

      const results = await searchEpisodes({
        db,
        prefix: PREFIX,
        query: "standup",
        agentId: AGENT_ID,
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Daily Standup Notes");

      // Verify $regex search on title/summary with $or
      const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter.agentId).toBe(AGENT_ID);
      expect(filter.$or).toBeDefined();
      expect(filter.$or).toHaveLength(2);
    });
  });

  describe("idempotent upsert", () => {
    it("duplicate materialization for same time range updates existing episode", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      // Episodes collection: second call means update (upsertedCount: 0)
      const episodesCol = createMockCollection({
        updateOne: vi
          .fn()
          .mockResolvedValue({ upsertedCount: 0, matchedCount: 1, modifiedCount: 1 }),
      });
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      const result = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
        timeRange: { start, end },
        summarizer: mockSummarizer,
      });

      expect(result).not.toBeNull();

      // Verify the upsert filter uses the idempotent key
      const [filter, , opts] = (episodesCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter.agentId).toBe(AGENT_ID);
      expect(filter.type).toBe("daily");
      expect(filter["timeRange.start"]).toEqual(start);
      expect(filter["timeRange.end"]).toEqual(end);
      expect(opts).toEqual({ upsert: true });
    });
  });

  describe("summarizer output validation", () => {
    it("throws when summarizer returns empty title", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      const episodesCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      const badSummarizer: EpisodeSummarizer = vi.fn().mockResolvedValue({
        title: "",
        summary: "Some summary",
        tags: [],
      });

      await expect(
        materializeEpisode({
          db,
          prefix: PREFIX,
          agentId: AGENT_ID,
          type: "daily",
          timeRange: { start, end },
          summarizer: badSummarizer,
        }),
      ).rejects.toThrow(/title/i);

      // Upsert should NOT be called
      expect(episodesCol.updateOne).not.toHaveBeenCalled();
    });

    it("throws when summarizer returns empty summary", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      const episodesCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      const badSummarizer: EpisodeSummarizer = vi.fn().mockResolvedValue({
        title: "Some title",
        summary: "",
        tags: [],
      });

      await expect(
        materializeEpisode({
          db,
          prefix: PREFIX,
          agentId: AGENT_ID,
          type: "daily",
          timeRange: { start, end },
          summarizer: badSummarizer,
        }),
      ).rejects.toThrow(/summary/i);

      expect(episodesCol.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("empty query guard", () => {
    it("returns empty array for empty query string", async () => {
      const episodesCol = createMockCollection();
      const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol });

      const results = await searchEpisodes({
        db,
        prefix: PREFIX,
        query: "",
        agentId: AGENT_ID,
      });

      expect(results).toEqual([]);
      // find() should NOT be called - early return
      expect(episodesCol.find).not.toHaveBeenCalled();
    });

    it("returns empty array for whitespace-only query", async () => {
      const episodesCol = createMockCollection();
      const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol });

      const results = await searchEpisodes({
        db,
        prefix: PREFIX,
        query: "   ",
        agentId: AGENT_ID,
      });

      expect(results).toEqual([]);
      expect(episodesCol.find).not.toHaveBeenCalled();
    });
  });

  describe("episodeId stability on re-materialization", () => {
    it("places episodeId in $setOnInsert, not $set", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      const episodesCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
        timeRange: { start, end },
        summarizer: mockSummarizer,
      });

      const [, update] = (episodesCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];

      // episodeId must NOT be in $set (would overwrite on re-materialization)
      expect(update.$set.episodeId).toBeUndefined();
      // episodeId MUST be in $setOnInsert (only assigned on first creation)
      expect(update.$setOnInsert.episodeId).toBeDefined();
      expect(typeof update.$setOnInsert.episodeId).toBe("string");
    });
  });

  describe("error handling", () => {
    it("materializeEpisode wraps and re-throws errors", async () => {
      const start = new Date("2026-03-15T09:00:00Z");
      const end = new Date("2026-03-15T10:00:00Z");
      const eventDocs = makeEventDocs(5, start);

      const eventsCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(eventDocs),
            }),
          }),
        }),
      });

      const episodesCol = createMockCollection({
        updateOne: vi.fn().mockRejectedValue(new Error("db write failed")),
      });
      const db = createMockDb({
        [`${PREFIX}events`]: eventsCol,
        [`${PREFIX}episodes`]: episodesCol,
      });

      await expect(
        materializeEpisode({
          db,
          prefix: PREFIX,
          agentId: AGENT_ID,
          type: "daily",
          timeRange: { start, end },
          summarizer: mockSummarizer,
        }),
      ).rejects.toThrow("db write failed");
    });

    it("searchEpisodes wraps and re-throws errors", async () => {
      const episodesCol = createMockCollection({
        find: vi.fn().mockImplementation(() => {
          throw new Error("db read failed");
        }),
      });
      const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol });

      await expect(
        searchEpisodes({
          db,
          prefix: PREFIX,
          query: "test",
          agentId: AGENT_ID,
        }),
      ).rejects.toThrow("db read failed");
    });
  });
});
