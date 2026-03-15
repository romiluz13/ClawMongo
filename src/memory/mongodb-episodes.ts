import { randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getEventsByTimeRange } from "./mongodb-events.js";
import { episodesCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:episodes");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpisodeType = "daily" | "weekly" | "thread" | "topic" | "decision";

export type Episode = {
  episodeId: string;
  type: EpisodeType;
  title: string;
  summary: string;
  agentId: string;
  scope: MemoryScope;
  timeRange: { start: Date; end: Date };
  sourceEventCount: number;
  sourceEventIds?: string[];
  tags?: string[];
  updatedAt: Date;
};

/**
 * Summarizer function type -- allows injection of LLM or mock summarizer.
 * In tests, use a mock that returns a fixed {title, summary, tags}.
 * In production, wire to the agent's LLM call.
 */
export type EpisodeSummarizer = (
  events: Array<{ role: string; body: string; timestamp: Date }>,
) => Promise<{
  title: string;
  summary: string;
  tags?: string[];
}>;

// ---------------------------------------------------------------------------
// Materialize episode from raw events
// ---------------------------------------------------------------------------

export async function materializeEpisode(params: {
  db: Db;
  prefix: string;
  agentId: string;
  type: EpisodeType;
  timeRange: { start: Date; end: Date };
  scope?: MemoryScope;
  summarizer: EpisodeSummarizer;
}): Promise<Episode | null> {
  const { db, prefix, agentId, type, timeRange, scope, summarizer } = params;
  try {
    // 1. Read raw events for the time range
    const events = await getEventsByTimeRange({
      db,
      prefix,
      agentId,
      start: timeRange.start,
      end: timeRange.end,
      scope,
    });

    // 2. If fewer than 2 events, return null (not enough content for an episode)
    if (events.length < 2) {
      log.info(
        `skipping episode materialization: only ${events.length} events in range for agent=${agentId}`,
      );
      return null;
    }

    // 3. Call summarizer with ordered events
    const summarizerInput = events.map((e) => ({
      role: e.role,
      body: e.body,
      timestamp: e.timestamp,
    }));
    const { title, summary, tags } = await summarizer(summarizerInput);

    // 3b. Validate summarizer output
    if (!title || typeof title !== "string" || !title.trim()) {
      throw new Error("Summarizer returned empty or invalid title");
    }
    if (!summary || typeof summary !== "string" || !summary.trim()) {
      throw new Error("Summarizer returned empty or invalid summary");
    }

    // 4. Build episode document
    const episodeId = randomUUID();
    const now = new Date();
    const sourceEventIds = events.map((e) => e.eventId);

    const setDoc: Document = {
      type,
      title,
      summary,
      agentId,
      scope: scope ?? "agent",
      timeRange: { start: timeRange.start, end: timeRange.end },
      sourceEventCount: events.length,
      sourceEventIds,
      updatedAt: now,
    };
    if (tags !== undefined) {
      setDoc.tags = tags;
    }

    // 5. Idempotent upsert: filter on {agentId, type, timeRange.start, timeRange.end}
    //    episodeId goes in $setOnInsert so it is stable across re-materializations
    const col = episodesCollection(db, prefix);
    await col.updateOne(
      {
        agentId,
        type,
        "timeRange.start": timeRange.start,
        "timeRange.end": timeRange.end,
      },
      { $set: setDoc, $setOnInsert: { episodeId, createdAt: now } },
      { upsert: true },
    );

    const episode: Episode = {
      episodeId,
      type,
      title,
      summary,
      agentId,
      scope: scope ?? "agent",
      timeRange: { start: timeRange.start, end: timeRange.end },
      sourceEventCount: events.length,
      sourceEventIds,
      updatedAt: now,
      ...(tags !== undefined && { tags }),
    };

    log.info(
      `episode materialized: ${episodeId} type=${type} events=${events.length} agent=${agentId}`,
    );
    return episode;
  } catch (err) {
    log.error(`materializeEpisode failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Get episodes by time range (overlap query)
// ---------------------------------------------------------------------------

export async function getEpisodesByTimeRange(params: {
  db: Db;
  prefix: string;
  agentId: string;
  start: Date;
  end: Date;
  type?: EpisodeType;
}): Promise<Episode[]> {
  const { db, prefix, agentId, start, end, type } = params;
  try {
    const col = episodesCollection(db, prefix);

    // Overlap condition: episode.timeRange.start <= query.end AND episode.timeRange.end >= query.start
    const filter: Document = {
      agentId,
      "timeRange.start": { $lte: end },
      "timeRange.end": { $gte: start },
    };
    if (type) {
      filter.type = type;
    }

    const docs = await col.find(filter).toSorted({ "timeRange.start": -1 }).limit(100).toArray();

    return docs as unknown as Episode[];
  } catch (err) {
    log.error(`getEpisodesByTimeRange failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Get episodes by type
// ---------------------------------------------------------------------------

export async function getEpisodesByType(params: {
  db: Db;
  prefix: string;
  agentId: string;
  type: EpisodeType;
  limit?: number;
}): Promise<Episode[]> {
  const { db, prefix, agentId, type, limit } = params;
  try {
    const col = episodesCollection(db, prefix);

    const docs = await col
      .find({ agentId, type })
      .toSorted({ updatedAt: -1 })
      .limit(limit ?? 50)
      .toArray();

    return docs as unknown as Episode[];
  } catch (err) {
    log.error(`getEpisodesByType failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Search episodes by regex on summary/title
// ---------------------------------------------------------------------------

export async function searchEpisodes(params: {
  db: Db;
  prefix: string;
  query: string;
  agentId: string;
  limit?: number;
}): Promise<Episode[]> {
  const { db, prefix, query, agentId, limit } = params;

  // Guard: empty/whitespace-only query would produce a match-all regex
  if (!query.trim()) {
    return [];
  }

  try {
    const col = episodesCollection(db, prefix);

    // Case-insensitive regex search on title and summary
    // Using $regex (same pattern as findEntitiesByName in mongodb-graph.ts)
    // Text index not assumed yet
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedQuery, "i");

    const filter: Document = {
      agentId,
      $or: [{ title: { $regex: regex } }, { summary: { $regex: regex } }],
    };

    const docs = await col
      .find(filter)
      .toSorted({ updatedAt: -1 })
      .limit(limit ?? 50)
      .toArray();

    return docs as unknown as Episode[];
  } catch (err) {
    log.error(`searchEpisodes failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
