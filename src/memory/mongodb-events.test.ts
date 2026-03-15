/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db } from "mongodb";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the schema module before imports
vi.mock("./mongodb-schema.js", () => ({
  eventsCollection: vi.fn(),
  chunksCollection: vi.fn(),
}));

import {
  writeEvent,
  getEventsByTimeRange,
  getEventsBySession,
  getUnprojectedEvents,
  markEventsProjected,
  projectChunksFromEvents,
  type CanonicalEvent,
} from "./mongodb-events.js";
import { eventsCollection, chunksCollection } from "./mongodb-schema.js";

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockEventsCol(): Collection {
  return {
    updateOne: vi.fn(async () => ({
      upsertedCount: 1,
      upsertedId: "new-id",
      modifiedCount: 0,
    })),
    updateMany: vi.fn(async () => ({
      modifiedCount: 0,
    })),
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn(async () => []),
        })),
      })),
    })),
  } as unknown as Collection;
}

function createMockChunksCol(): Collection {
  return {
    updateOne: vi.fn(async () => ({
      upsertedCount: 1,
      upsertedId: "chunk-id",
      modifiedCount: 0,
    })),
  } as unknown as Collection;
}

function mockDb(): Db {
  return {} as unknown as Db;
}

// ---------------------------------------------------------------------------
// Tests: writeEvent
// ---------------------------------------------------------------------------

describe("writeEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts an event and returns the eventId", async () => {
    const col = createMockEventsCol();
    vi.mocked(eventsCollection).mockReturnValue(col);

    const result = await writeEvent({
      db: mockDb(),
      prefix: "test_",
      event: {
        agentId: "agent-1",
        role: "user",
        body: "Hello world",
        scope: "agent",
      },
    });

    expect(result.eventId).toBeDefined();
    expect(typeof result.eventId).toBe("string");
    expect(result.eventId.length).toBeGreaterThan(0);

    // Verify upsert was called with $setOnInsert
    expect(col.updateOne).toHaveBeenCalledOnce();
    const [filter, update, opts] = vi.mocked(col.updateOne).mock.calls[0];
    expect(filter).toEqual({ eventId: result.eventId });
    expect(update).toHaveProperty("$setOnInsert");
    expect(opts).toEqual({ upsert: true });

    // Verify the doc has correct fields
    const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert;
    expect(doc.agentId).toBe("agent-1");
    expect(doc.role).toBe("user");
    expect(doc.body).toBe("Hello world");
    expect(doc.scope).toBe("agent");
    expect(doc.timestamp).toBeInstanceOf(Date);
  });

  it("with duplicate eventId is idempotent", async () => {
    const col = createMockEventsCol();
    vi.mocked(col.updateOne).mockResolvedValue({
      upsertedCount: 0,
      upsertedId: null,
      modifiedCount: 0,
      matchedCount: 1,
      acknowledged: true,
    });
    vi.mocked(eventsCollection).mockReturnValue(col);

    const result = await writeEvent({
      db: mockDb(),
      prefix: "test_",
      event: {
        eventId: "existing-id",
        agentId: "agent-1",
        role: "user",
        body: "Hello world",
        scope: "agent",
      },
    });

    expect(result.eventId).toBe("existing-id");
    // updateOne was called (idempotent upsert, not an error)
    expect(col.updateOne).toHaveBeenCalledOnce();
  });

  it("defaults scope to agent when not provided", async () => {
    const col = createMockEventsCol();
    vi.mocked(eventsCollection).mockReturnValue(col);

    await writeEvent({
      db: mockDb(),
      prefix: "test_",
      event: {
        agentId: "agent-1",
        role: "assistant",
        body: "Response",
      } as Parameters<typeof writeEvent>[0]["event"],
    });

    const [, update] = vi.mocked(col.updateOne).mock.calls[0];
    const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert;
    expect(doc.scope).toBe("agent");
  });

  it("preserves optional fields when provided", async () => {
    const col = createMockEventsCol();
    vi.mocked(eventsCollection).mockReturnValue(col);

    await writeEvent({
      db: mockDb(),
      prefix: "test_",
      event: {
        agentId: "agent-1",
        role: "user",
        body: "Hello",
        scope: "session",
        sessionId: "sess-123",
        channel: "discord",
        metadata: { key: "value" },
      },
    });

    const [, update] = vi.mocked(col.updateOne).mock.calls[0];
    const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert;
    expect(doc.sessionId).toBe("sess-123");
    expect(doc.channel).toBe("discord");
    expect(doc.metadata).toEqual({ key: "value" });
  });
});

// ---------------------------------------------------------------------------
// Tests: getEventsByTimeRange
// ---------------------------------------------------------------------------

describe("getEventsByTimeRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns events in timestamp order within range", async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60000);
    const mockEvents: CanonicalEvent[] = [
      {
        eventId: "e1",
        agentId: "agent-1",
        role: "user",
        body: "First",
        scope: "agent",
        timestamp: earlier,
      },
      {
        eventId: "e2",
        agentId: "agent-1",
        role: "assistant",
        body: "Second",
        scope: "agent",
        timestamp: now,
      },
    ];

    const toArrayFn = vi.fn(async () => mockEvents);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const col = Object.assign(createMockEventsCol(), { find: findFn });
    vi.mocked(eventsCollection).mockReturnValue(col);

    const start = new Date(now.getTime() - 120000);
    const end = new Date(now.getTime() + 1000);
    const result = await getEventsByTimeRange({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
      start,
      end,
    });

    expect(result).toHaveLength(2);
    expect(result[0].eventId).toBe("e1");
    expect(result[1].eventId).toBe("e2");

    // Verify filter
    expect(findFn).toHaveBeenCalledWith({
      agentId: "agent-1",
      timestamp: { $gte: start, $lte: end },
    });
    expect(sortFn).toHaveBeenCalledWith({ timestamp: 1 });
    expect(limitFn).toHaveBeenCalledWith(1000); // default limit
  });

  it("applies scope filter when provided", async () => {
    const toArrayFn = vi.fn(async () => []);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const col = Object.assign(createMockEventsCol(), { find: findFn });
    vi.mocked(eventsCollection).mockReturnValue(col);

    const start = new Date("2025-01-01");
    const end = new Date("2025-12-31");
    await getEventsByTimeRange({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
      start,
      end,
      scope: "session",
    });

    expect(findFn).toHaveBeenCalledWith({
      agentId: "agent-1",
      timestamp: { $gte: start, $lte: end },
      scope: "session",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: getEventsBySession
// ---------------------------------------------------------------------------

describe("getEventsBySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters by agentId and sessionId", async () => {
    const mockEvents: CanonicalEvent[] = [
      {
        eventId: "e1",
        agentId: "agent-1",
        sessionId: "sess-1",
        role: "user",
        body: "Hello",
        scope: "agent",
        timestamp: new Date(),
      },
    ];

    const toArrayFn = vi.fn(async () => mockEvents);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const col = Object.assign(createMockEventsCol(), { find: findFn });
    vi.mocked(eventsCollection).mockReturnValue(col);

    const result = await getEventsBySession({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
      sessionId: "sess-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("sess-1");
    expect(findFn).toHaveBeenCalledWith({ agentId: "agent-1", sessionId: "sess-1" });
    expect(sortFn).toHaveBeenCalledWith({ timestamp: 1 });
  });
});

// ---------------------------------------------------------------------------
// Tests: getUnprojectedEvents
// ---------------------------------------------------------------------------

describe("getUnprojectedEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns events where projectedAt does not exist", async () => {
    const mockEvents: CanonicalEvent[] = [
      {
        eventId: "e1",
        agentId: "agent-1",
        role: "user",
        body: "Unprojected",
        scope: "agent",
        timestamp: new Date(),
      },
    ];

    const toArrayFn = vi.fn(async () => mockEvents);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const col = Object.assign(createMockEventsCol(), { find: findFn });
    vi.mocked(eventsCollection).mockReturnValue(col);

    const result = await getUnprojectedEvents({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
    });

    expect(result).toHaveLength(1);
    expect(findFn).toHaveBeenCalledWith({
      agentId: "agent-1",
      projectedAt: { $exists: false },
    });
    expect(limitFn).toHaveBeenCalledWith(500); // default limit
  });
});

// ---------------------------------------------------------------------------
// Tests: markEventsProjected
// ---------------------------------------------------------------------------

describe("markEventsProjected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets projectedAt on given eventIds", async () => {
    const col = createMockEventsCol();
    vi.mocked(col.updateMany).mockResolvedValue({
      modifiedCount: 3,
      matchedCount: 3,
      upsertedCount: 0,
      upsertedId: null,
      acknowledged: true,
    });
    vi.mocked(eventsCollection).mockReturnValue(col);

    const result = await markEventsProjected({
      db: mockDb(),
      prefix: "test_",
      eventIds: ["e1", "e2", "e3"],
    });

    expect(result).toBe(3);
    expect(col.updateMany).toHaveBeenCalledOnce();
    const [filter, update] = vi.mocked(col.updateMany).mock.calls[0];
    expect(filter).toEqual({ eventId: { $in: ["e1", "e2", "e3"] } });
    expect(update).toHaveProperty("$set");
    const setClause = (update as Record<string, Record<string, unknown>>).$set;
    expect(setClause.projectedAt).toBeInstanceOf(Date);
  });

  it("returns 0 for empty eventIds array", async () => {
    const col = createMockEventsCol();
    vi.mocked(eventsCollection).mockReturnValue(col);

    const result = await markEventsProjected({
      db: mockDb(),
      prefix: "test_",
      eventIds: [],
    });

    expect(result).toBe(0);
    expect(col.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: projectChunksFromEvents
// ---------------------------------------------------------------------------

describe("projectChunksFromEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates chunks and marks events as projected", async () => {
    const mockEvents: CanonicalEvent[] = [
      {
        eventId: "evt-1",
        agentId: "agent-1",
        role: "user",
        body: "Hello world",
        scope: "agent",
        timestamp: new Date(),
      },
      {
        eventId: "evt-2",
        agentId: "agent-1",
        role: "assistant",
        body: "Hi there",
        scope: "agent",
        timestamp: new Date(),
      },
    ];

    // Events collection mock
    const toArrayFn = vi.fn(async () => mockEvents);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const eventCol = {
      find: findFn,
      updateMany: vi.fn(async () => ({
        modifiedCount: 2,
        matchedCount: 2,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      })),
      updateOne: vi.fn(async () => ({
        upsertedCount: 1,
        upsertedId: "new-id",
        modifiedCount: 0,
      })),
    } as unknown as Collection;

    // Chunks collection mock
    const chunkCol = createMockChunksCol();

    vi.mocked(eventsCollection).mockReturnValue(eventCol);
    vi.mocked(chunksCollection).mockReturnValue(chunkCol);

    const result = await projectChunksFromEvents({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
    });

    expect(result.eventsProcessed).toBe(2);
    expect(result.chunksCreated).toBe(2);

    // Verify chunks were created with correct path and source
    expect(chunkCol.updateOne).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(chunkCol.updateOne).mock.calls[0];
    const firstFilter = firstCall[0] as Record<string, unknown>;
    expect(firstFilter.path).toBe("events/evt-1");

    const firstUpdate = firstCall[1] as Record<string, Record<string, unknown>>;
    const firstDoc = firstUpdate.$setOnInsert;
    expect(firstDoc.source).toBe("conversation");
    expect(firstDoc.text).toBe("Hello world");
    expect(typeof firstDoc.hash).toBe("string");

    // Verify events were marked as projected
    expect(eventCol.updateMany).toHaveBeenCalledOnce();
  });

  it("with zero unprojected events is a no-op", async () => {
    const toArrayFn = vi.fn(async () => []);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const eventCol = {
      find: findFn,
      updateMany: vi.fn(),
      updateOne: vi.fn(),
    } as unknown as Collection;

    const chunkCol = createMockChunksCol();

    vi.mocked(eventsCollection).mockReturnValue(eventCol);
    vi.mocked(chunksCollection).mockReturnValue(chunkCol);

    const result = await projectChunksFromEvents({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
    });

    expect(result.eventsProcessed).toBe(0);
    expect(result.chunksCreated).toBe(0);
    expect(chunkCol.updateOne).not.toHaveBeenCalled();
    expect(eventCol.updateMany).not.toHaveBeenCalled();
  });

  it("projected chunks have correct source and path format", async () => {
    const mockEvents: CanonicalEvent[] = [
      {
        eventId: "abc-def-123",
        agentId: "agent-1",
        role: "user",
        body: "Test content",
        scope: "agent",
        timestamp: new Date(),
      },
    ];

    const toArrayFn = vi.fn(async () => mockEvents);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const eventCol = {
      find: findFn,
      updateMany: vi.fn(async () => ({
        modifiedCount: 1,
        matchedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      })),
      updateOne: vi.fn(),
    } as unknown as Collection;

    const chunkCol = createMockChunksCol();

    vi.mocked(eventsCollection).mockReturnValue(eventCol);
    vi.mocked(chunksCollection).mockReturnValue(chunkCol);

    await projectChunksFromEvents({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
    });

    const call = vi.mocked(chunkCol.updateOne).mock.calls[0];
    const filter = call[0] as Record<string, unknown>;
    expect(filter.path).toBe("events/abc-def-123");

    const update = call[1] as Record<string, Record<string, unknown>>;
    const doc = update.$setOnInsert;
    expect(doc.source).toBe("conversation");
    expect(doc.path).toBe("events/abc-def-123");
    expect(doc.agentId).toBe("agent-1");
  });

  it("only counts chunksCreated when upsertedCount > 0 (not duplicates)", async () => {
    const mockEvents: CanonicalEvent[] = [
      {
        eventId: "evt-new",
        agentId: "agent-1",
        role: "user",
        body: "New event",
        scope: "agent",
        timestamp: new Date(),
      },
      {
        eventId: "evt-dup",
        agentId: "agent-1",
        role: "assistant",
        body: "Duplicate event",
        scope: "agent",
        timestamp: new Date(),
      },
    ];

    const toArrayFn = vi.fn(async () => mockEvents);
    const limitFn = vi.fn(() => ({ toArray: toArrayFn }));
    const sortFn = vi.fn(() => ({ limit: limitFn }));
    const findFn = vi.fn(() => ({ sort: sortFn }));

    const eventCol = {
      find: findFn,
      updateMany: vi.fn(async () => ({
        modifiedCount: 2,
        matchedCount: 2,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      })),
      updateOne: vi.fn(),
    } as unknown as Collection;

    // First call: upsert (new chunk), second call: no upsert (duplicate)
    const chunkCol = {
      updateOne: vi
        .fn()
        .mockResolvedValueOnce({
          upsertedCount: 1,
          upsertedId: "new-id",
          modifiedCount: 0,
        })
        .mockResolvedValueOnce({
          upsertedCount: 0,
          upsertedId: null,
          modifiedCount: 0,
        }),
    } as unknown as Collection;

    vi.mocked(eventsCollection).mockReturnValue(eventCol);
    vi.mocked(chunksCollection).mockReturnValue(chunkCol);

    const result = await projectChunksFromEvents({
      db: mockDb(),
      prefix: "test_",
      agentId: "agent-1",
    });

    expect(result.eventsProcessed).toBe(2);
    // Only 1 chunk was actually created (the other was a duplicate)
    expect(result.chunksCreated).toBe(1);
  });
});
