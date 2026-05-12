/**
 * Consolidation Agent (Dreamer) — offline pipeline that reads
 * un-dreamer-processed events, scores them using novelty + importance +
 * access patterns, deduces structured facts via conservative pattern matching,
 * and records the consolidation run.
 *
 * The Dreamer writes promoted facts to `structured_memory` via the existing
 * `writeStructuredMemory()` function and marks processed events with
 * `dreamerProcessedAt` + `dreamerRunId`.
 *
 * This module does NOT use `markEventsConsolidated()` (which requires an
 * `episodeId` for episode consolidation) — it has its own
 * `markEventsDreamerProcessed()` that sets dreamer-specific fields.
 *
 * @module mongodb-consolidator
 */

import { randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sortMongoCursor } from "./mongodb-cursor.js";
import { scanNovelty } from "./mongodb-novelty.js";
import { traceReasoningChain } from "./mongodb-reasoning-chain.js";
import { computeImportanceDecay, computeResultTrust } from "./mongodb-result-trust.js";
import { eventsCollection, consolidationRunsCollection } from "./mongodb-schema.js";
import { writeStructuredMemory } from "./mongodb-structured-memory.js";
import type { ConsolidationCandidate, ConsolidationOptions, ConsolidationResult } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:consolidator");

// ---------------------------------------------------------------------------
// Constants / Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_MIN_COMBINED_SCORE = 0; // Pattern matching is the primary gate, scoring is informational
const DEFAULT_MIN_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_NOVELTY_WEIGHT = 0.4;
const DEFAULT_IMPORTANCE_WEIGHT = 0.3;
const DEFAULT_ACCESS_WEIGHT = 0.3;

// ---------------------------------------------------------------------------
// Rule-based pattern matching (conservative: false negatives OK,
// false positives NOT OK)
// ---------------------------------------------------------------------------

const PREFERENCE_PATTERN = /\b(?:I\s+(?:prefer|like|want|always use|love))\s+(.+)/i;
const DECISION_PATTERN = /\b(?:I\s+(?:decided|chose|picked|selected|went with))\s+(.+)/i;

type PatternMatch = {
  type: "preference" | "decision";
  key: string;
  value: string;
};

/**
 * Attempt to extract a deducible fact from event body text.
 * Returns null if no high-confidence pattern matches.
 */
function matchPatterns(body: string): PatternMatch | null {
  const prefMatch = PREFERENCE_PATTERN.exec(body);
  if (prefMatch?.[1]) {
    const extracted = prefMatch[1].trim();
    // Truncate long extractions to a reasonable key length
    const key = extracted.length > 120 ? extracted.slice(0, 120) : extracted;
    return { type: "preference", key, value: body };
  }

  const decMatch = DECISION_PATTERN.exec(body);
  if (decMatch?.[1]) {
    const extracted = decMatch[1].trim();
    const key = extracted.length > 120 ? extracted.slice(0, 120) : extracted;
    return { type: "decision", key, value: body };
  }

  return null;
}

// ---------------------------------------------------------------------------
// markEventsDreamerProcessed — sets dreamerProcessedAt + dreamerRunId
// on processed events. Distinct from markEventsConsolidated (which
// requires an episodeId for episode consolidation).
// ---------------------------------------------------------------------------

export async function markEventsDreamerProcessed(params: {
  db: Db;
  prefix: string;
  eventIds: string[];
  runId: string;
}): Promise<number> {
  const { db, prefix, eventIds, runId } = params;
  if (eventIds.length === 0) {
    return 0;
  }
  const collection = eventsCollection(db, prefix);
  const result = await collection.updateMany(
    { eventId: { $in: eventIds } },
    {
      $set: {
        dreamerProcessedAt: new Date(),
        dreamerRunId: runId,
      },
    },
  );
  log.info(`marked ${result.modifiedCount} events as dreamer-processed (runId=${runId})`);
  return result.modifiedCount;
}

// ---------------------------------------------------------------------------
// Conflict detection helper
// ---------------------------------------------------------------------------

/**
 * Check whether promoting a fact with the given key would conflict with
 * an existing structured memory entry. Uses computeResultTrust's contradiction
 * dimension as the conflict signal.
 *
 * Returns true if a conflict is detected (promotion should be skipped).
 */
async function hasConflict(params: {
  db: Db;
  prefix: string;
  agentId: string;
  type: string;
  key: string;
}): Promise<boolean> {
  const { db, prefix, agentId, type, key } = params;
  const structuredCol = db.collection(`${prefix}structured_mem`);
  const existing = await structuredCol.findOne({
    agentId,
    type,
    key,
    state: { $ne: "invalidated" },
  });

  if (!existing) {
    return false;
  }

  // Build a minimal search result to check contradiction via trust scoring
  const trustResult = computeResultTrust({
    path: `structured:${type}/${key}`,
    startLine: 0,
    endLine: 0,
    score: 0.5,
    snippet: (existing.value as string) ?? "",
    source: "structured",
    signals: {
      state: (existing.state as "active" | "invalidated" | "conflicted") ?? "active",
      conflictCount: (existing.conflictCount as number) ?? 0,
    },
  });

  // A contradiction score below 0.5 indicates conflict
  return trustResult.contradiction < 0.5;
}

// ---------------------------------------------------------------------------
// Main consolidation pipeline
// ---------------------------------------------------------------------------

export async function consolidateMemory(params: {
  db: Db;
  prefix: string;
  agentId: string;
  options?: ConsolidationOptions;
}): Promise<ConsolidationResult> {
  const { db, prefix, agentId, options } = params;
  const startMs = Date.now();
  const runId = randomUUID();

  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
  const minCombinedScore = options?.minCombinedScore ?? DEFAULT_MIN_COMBINED_SCORE;
  const minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const noveltyWeight = options?.noveltyWeight ?? DEFAULT_NOVELTY_WEIGHT;
  const importanceWeight = options?.importanceWeight ?? DEFAULT_IMPORTANCE_WEIGHT;
  const accessWeight = options?.accessWeight ?? DEFAULT_ACCESS_WEIGHT;

  const emptyResult: ConsolidationResult = {
    runId,
    agentId,
    eventsProcessed: 0,
    factsPromoted: 0,
    factsPruned: 0,
    conflictsResolved: 0,
    durationMs: 0,
    candidates: [],
  };

  // -----------------------------------------------------------------------
  // Step 1: Rate limit — check last run time
  // -----------------------------------------------------------------------

  const consolidationRuns = consolidationRunsCollection(db, prefix);
  const lastRun = await consolidationRuns.findOne(
    { agentId, status: { $in: ["completed", "running"] } },
    { sort: { startedAt: -1 } },
  );

  if (lastRun?.startedAt instanceof Date) {
    const elapsed = Date.now() - lastRun.startedAt.getTime();
    if (elapsed < minIntervalMs) {
      log.info(
        `consolidation rate-limited for agent=${agentId} (${elapsed}ms < ${minIntervalMs}ms)`,
      );
      emptyResult.durationMs = Date.now() - startMs;
      return emptyResult;
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Record run start
  // -----------------------------------------------------------------------

  await consolidationRuns.insertOne({
    runId,
    agentId,
    startedAt: new Date(),
    status: "running",
  });

  // -----------------------------------------------------------------------
  // Step 3: Query un-dreamer-processed events
  // -----------------------------------------------------------------------

  const eventsCol = eventsCollection(db, prefix);
  const filter: Document = {
    agentId,
    dreamerProcessedAt: { $exists: false },
  };
  if (options?.scope) {
    filter.scope = options.scope;
  }

  const events = await sortMongoCursor(eventsCol.find(filter), { timestamp: -1 })
    .limit(maxEvents)
    .toArray();

  if (events.length === 0) {
    const durationMs = Date.now() - startMs;
    await consolidationRuns.updateOne(
      { runId },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          eventsProcessed: 0,
          factsPromoted: 0,
          factsPruned: 0,
          conflictsResolved: 0,
          durationMs,
        },
      },
    );
    return { ...emptyResult, durationMs };
  }

  // -----------------------------------------------------------------------
  // Step 4: Score each event
  // -----------------------------------------------------------------------

  // Get novelty scores (graceful degradation if mongot unavailable)
  const noveltyReport = await scanNovelty({ db, prefix, agentId, options });
  const noveltyByEventId = new Map<string, number>();
  for (const ne of noveltyReport.events) {
    noveltyByEventId.set(ne.eventId, ne.noveltyScore);
  }

  // Compute max access count for normalization
  const maxAccessCount = Math.max(
    1,
    ...events.map((e) => (typeof e.accessCount === "number" ? e.accessCount : 0)),
  );

  const allCandidates: ConsolidationCandidate[] = events.map((event) => {
    const noveltyScore = noveltyByEventId.get(event.eventId as string) ?? 0;
    const impDecay = computeImportanceDecay(
      event.importance as number | undefined,
      event.timestamp instanceof Date ? event.timestamp : undefined,
    );
    const rawAccess = typeof event.accessCount === "number" ? event.accessCount : 0;
    const normalizedAccess = rawAccess / maxAccessCount;

    const combinedScore =
      noveltyWeight * noveltyScore + importanceWeight * impDecay + accessWeight * normalizedAccess;

    return {
      eventId: event.eventId as string,
      body: (event.body as string) ?? "",
      timestamp: event.timestamp instanceof Date ? event.timestamp : new Date(0),
      noveltyScore,
      importanceDecay: impDecay,
      accessCount: rawAccess,
      combinedScore,
    };
  });

  // -----------------------------------------------------------------------
  // Step 5: Filter by minCombinedScore and sort descending
  // -----------------------------------------------------------------------

  const filteredCandidates = allCandidates
    .filter((c) => c.combinedScore >= minCombinedScore)
    .toSorted((a, b) => b.combinedScore - a.combinedScore);

  // -----------------------------------------------------------------------
  // Step 6: For each candidate — pattern-match, check conflicts, promote
  // -----------------------------------------------------------------------

  let factsPromoted = 0;
  let conflictsResolved = 0;

  for (const candidate of filteredCandidates) {
    try {
      const match = matchPatterns(candidate.body);
      if (!match) {
        continue;
      }

      // Walk reasoning chain for provenance context (fire-and-forget logging)
      traceReasoningChain({
        db,
        prefix,
        agentId,
        factId: candidate.eventId,
        collection: "events",
      }).catch((err) => {
        log.warn(`reasoning chain trace failed for event=${candidate.eventId}: ${String(err)}`);
      });

      // Check for conflicts with existing structured memory
      const conflicted = await hasConflict({
        db,
        prefix,
        agentId,
        type: match.type,
        key: match.key,
      });

      if (conflicted) {
        log.warn(
          `conflict detected for ${match.type}/${match.key} from event=${candidate.eventId}, skipping promotion`,
        );
        continue;
      }

      // Promote to structured memory
      await writeStructuredMemory({
        db,
        prefix,
        entry: {
          type: match.type,
          key: match.key,
          value: match.value,
          agentId,
          source: "agent",
          sourceEventIds: [candidate.eventId],
        },
        embeddingMode: "automated",
      });

      factsPromoted++;
    } catch (err) {
      log.warn(
        `candidate processing failed for event=${candidate.eventId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Mark ALL processed events as dreamer-processed
  // -----------------------------------------------------------------------

  const allEventIds = events.map((e) => e.eventId as string);
  await markEventsDreamerProcessed({
    db,
    prefix,
    eventIds: allEventIds,
    runId,
  });

  // -----------------------------------------------------------------------
  // Step 8: Record run completion
  // -----------------------------------------------------------------------

  const durationMs = Date.now() - startMs;

  await consolidationRuns.updateOne(
    { runId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        eventsProcessed: events.length,
        factsPromoted,
        factsPruned: 0,
        conflictsResolved,
        durationMs,
      },
    },
  );

  log.info(
    `consolidation run=${runId} completed: ${events.length} events processed, ${factsPromoted} facts promoted, ${durationMs}ms`,
  );

  // -----------------------------------------------------------------------
  // Step 9: Return result
  // -----------------------------------------------------------------------

  return {
    runId,
    agentId,
    eventsProcessed: events.length,
    factsPromoted,
    factsPruned: 0,
    conflictsResolved,
    durationMs,
    candidates: filteredCandidates,
  };
}
