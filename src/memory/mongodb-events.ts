import { createHash, randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { eventsCollection, chunksCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:events");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonicalEvent = {
  eventId: string;
  agentId: string;
  sessionId?: string;
  channel?: string;
  role: "user" | "assistant" | "system" | "tool";
  body: string;
  metadata?: Record<string, unknown>;
  scope: MemoryScope;
  timestamp: Date;
  projectedAt?: Date;
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function writeEvent(params: {
  db: Db;
  prefix: string;
  event: Omit<CanonicalEvent, "eventId" | "timestamp"> & {
    eventId?: string;
    timestamp?: Date;
  };
}): Promise<{ eventId: string }> {
  const { db, prefix, event } = params;
  const collection = eventsCollection(db, prefix);
  const eventId = event.eventId ?? randomUUID();
  const timestamp = event.timestamp ?? new Date();

  const doc: CanonicalEvent = {
    eventId,
    agentId: event.agentId,
    role: event.role,
    body: event.body,
    scope: event.scope ?? ("agent" as MemoryScope),
    timestamp,
    ...(event.sessionId && { sessionId: event.sessionId }),
    ...(event.channel && { channel: event.channel }),
    ...(event.metadata && { metadata: event.metadata }),
  };

  await collection.updateOne({ eventId }, { $setOnInsert: doc }, { upsert: true });

  log.info(`event written: ${eventId} role=${event.role}`);
  return { eventId };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getEventsByTimeRange(params: {
  db: Db;
  prefix: string;
  agentId: string;
  start: Date;
  end: Date;
  scope?: MemoryScope;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, start, end, scope, limit } = params;
  const collection = eventsCollection(db, prefix);
  const filter: Document = {
    agentId,
    timestamp: { $gte: start, $lte: end },
  };
  if (scope) {
    filter.scope = scope;
  }

  return (await collection
    .find(filter)
    .toSorted({ timestamp: 1 })
    .limit(limit ?? 1000)
    .toArray()) as unknown as CanonicalEvent[];
}

export async function getEventsBySession(params: {
  db: Db;
  prefix: string;
  agentId: string;
  sessionId: string;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, sessionId, limit } = params;
  const collection = eventsCollection(db, prefix);
  return (await collection
    .find({ agentId, sessionId })
    .toSorted({ timestamp: 1 })
    .limit(limit ?? 1000)
    .toArray()) as unknown as CanonicalEvent[];
}

export async function getUnprojectedEvents(params: {
  db: Db;
  prefix: string;
  agentId: string;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, limit } = params;
  const collection = eventsCollection(db, prefix);
  return (await collection
    .find({ agentId, projectedAt: { $exists: false } })
    .toSorted({ timestamp: 1 })
    .limit(limit ?? 500)
    .toArray()) as unknown as CanonicalEvent[];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export async function markEventsProjected(params: {
  db: Db;
  prefix: string;
  eventIds: string[];
}): Promise<number> {
  const { db, prefix, eventIds } = params;
  if (eventIds.length === 0) {
    return 0;
  }
  const collection = eventsCollection(db, prefix);
  const result = await collection.updateMany(
    { eventId: { $in: eventIds } },
    { $set: { projectedAt: new Date() } },
  );
  return result.modifiedCount;
}

/**
 * Project unprojected events into the chunks collection.
 * Each event becomes a chunk with path `events/{eventId}`, source `"conversation"`,
 * and a SHA-256 content hash of the body.
 */
export async function projectChunksFromEvents(params: {
  db: Db;
  prefix: string;
  agentId: string;
  batchSize?: number;
}): Promise<{ eventsProcessed: number; chunksCreated: number }> {
  const { db, prefix, agentId, batchSize } = params;

  const events = await getUnprojectedEvents({ db, prefix, agentId, limit: batchSize });
  if (events.length === 0) {
    return { eventsProcessed: 0, chunksCreated: 0 };
  }

  const chunks = chunksCollection(db, prefix);
  let chunksCreated = 0;

  try {
    for (const event of events) {
      const path = `events/${event.eventId}`;
      const hash = createHash("sha256").update(event.body).digest("hex");

      const result = await chunks.updateOne(
        { path },
        {
          $setOnInsert: {
            path,
            text: event.body,
            hash,
            source: "conversation",
            agentId: event.agentId,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) {
        chunksCreated++;
      }
    }

    const eventIds = events.map((e) => e.eventId);
    await markEventsProjected({ db, prefix, eventIds });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `projection failed after ${chunksCreated} chunks created from ${events.length} events for agent=${agentId}: ${msg}`,
    );
    throw err;
  }

  log.info(`projected ${chunksCreated} chunks from ${events.length} events for agent=${agentId}`);
  return { eventsProcessed: events.length, chunksCreated };
}
