/**
 * Surprisal-Based Novelty Detection — identifies the most novel/anomalous
 * stored observations using Atlas Vector Search kNN distance scoring.
 *
 * Strategy (centroid approach):
 *  1. Fetch recent events with embeddings for the agent
 *  2. Compute average embedding (centroid) from those events
 *  3. Run one `$vectorSearch` with centroid as query vector
 *  4. Events with the lowest scores (furthest from centroid) are most novel
 *  5. If no embeddings or `$vectorSearch` fails: return empty degraded report
 *
 * CRITICAL: Graceful degradation when mongot is unavailable.
 *
 * @module mongodb-novelty
 */

import type { Db, Document } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sortMongoCursor } from "./mongodb-cursor.js";
import type { NoveltyEvent, NoveltyOptions, NoveltyReport } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:novelty");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;
const DEFAULT_K_NEIGHBORS = 5;
/** Maximum number of recent events to fetch for centroid computation. */
const MAX_RECENT_EVENTS = 200;
/** Vector search index name on events collection. */
const EVENTS_VECTOR_INDEX = "idx_events_vector";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the element-wise average of a list of embedding vectors.
 * All vectors must have the same dimensionality.
 */
function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    return [];
  }
  const dim = embeddings[0].length;
  const sum = new Float64Array(dim);
  for (const vec of embeddings) {
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
  }
  const count = embeddings.length;
  return Array.from(sum, (v) => v / count);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan for the most novel/surprising events stored for a given agent.
 *
 * Returns events ranked by novelty descending (most novel first).
 * Gracefully degrades when mongot/Atlas Vector Search is unavailable:
 * returns `{ events: [], scannedCount: 0, error: "mongot_unavailable" }`.
 */
export async function scanNovelty(params: {
  db: Db;
  prefix: string;
  agentId: string;
  options?: NoveltyOptions;
}): Promise<NoveltyReport> {
  const { db, prefix, agentId, options } = params;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const kNeighbors = options?.kNeighbors ?? DEFAULT_K_NEIGHBORS;

  const emptyReport: NoveltyReport = {
    events: [],
    scannedCount: 0,
    agentId,
  };

  // 1. Build filter for fetching recent events
  const filter: Document = {
    agentId,
    embedding: { $exists: true, $ne: null },
  };
  if (options?.scope) {
    filter.scope = options.scope;
  }
  if (options?.timeRange) {
    filter.timestamp = {
      $gte: options.timeRange.start,
      $lte: options.timeRange.end,
    };
  }

  // 2. Fetch recent events with embeddings
  const eventsCol = db.collection(`${prefix}events`);
  const recentEvents = await sortMongoCursor(eventsCol.find(filter), { timestamp: -1 })
    .limit(MAX_RECENT_EVENTS)
    .toArray();

  // Filter to only events that actually have valid embedding arrays
  const eventsWithEmbeddings = recentEvents.filter(
    (e) => Array.isArray(e.embedding) && e.embedding.length > 0,
  );

  if (eventsWithEmbeddings.length === 0) {
    return emptyReport;
  }

  // 3. Compute centroid of all embeddings
  const embeddings = eventsWithEmbeddings.map((e) => e.embedding as number[]);
  const centroid = computeCentroid(embeddings);
  if (centroid.length === 0) {
    return emptyReport;
  }

  // 4. Run $vectorSearch with centroid — results ordered by similarity (closest first)
  //    Events that are LEAST similar to the centroid are the most novel.
  const numCandidates = Math.max(kNeighbors * 10, eventsWithEmbeddings.length);
  const searchLimit = eventsWithEmbeddings.length; // fetch all so we can rank

  try {
    const pipeline: Document[] = [
      {
        $vectorSearch: {
          index: EVENTS_VECTOR_INDEX,
          path: "embedding",
          queryVector: centroid,
          numCandidates,
          limit: searchLimit,
          filter: { agentId },
        },
      },
      {
        $project: {
          eventId: 1,
          body: 1,
          role: 1,
          timestamp: 1,
          __vectorSearchScore: { $meta: "vectorSearchScore" },
        },
      },
    ];

    const searchResults = await eventsCol.aggregate(pipeline).toArray();

    if (searchResults.length === 0) {
      return emptyReport;
    }

    // 5. Convert similarity scores to novelty scores.
    //    vectorSearchScore is 0-1 where 1 = most similar to centroid.
    //    Novelty = 1 - similarity (higher = more novel / further from centroid).
    const scoredEvents: NoveltyEvent[] = searchResults.map((doc) => {
      const similarity = (doc.__vectorSearchScore as number) ?? 0;
      return {
        eventId: doc.eventId as string,
        body: (doc.body as string) ?? "",
        noveltyScore: 1 - similarity,
        timestamp: doc.timestamp instanceof Date ? doc.timestamp : new Date(0),
        role: (doc.role as string) ?? "unknown",
        nearestNeighborDistance: 1 - similarity,
      };
    });

    // Sort by novelty descending (most novel first)
    scoredEvents.sort((a, b) => b.noveltyScore - a.noveltyScore);

    // Apply limit
    const trimmed = scoredEvents.slice(0, limit);

    return {
      events: trimmed,
      scannedCount: eventsWithEmbeddings.length,
      agentId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`novelty scan failed (mongot likely unavailable): ${msg}`);
    return {
      events: [],
      scannedCount: 0,
      error: "mongot_unavailable",
      agentId,
    };
  }
}
