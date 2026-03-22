import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { telemetryCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:telemetry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetryOperation =
  | "search"
  | "event-write"
  | "projection-run"
  | "cache-check"
  | "graph-expansion";

export type TelemetryMeta = {
  agentId: string;
  operation: TelemetryOperation;
};

export type TelemetryDocument = {
  ts: Date;
  meta: TelemetryMeta;
  durationMs: number;
  ok: boolean;
  pathUsed?: string;
  resultCount?: number;
  topScore?: number;
  fusionMethod?: string;
  cacheHit?: boolean;
  latencySavedMs?: number;
  itemCount?: number;
  eventType?: string;
  projectionTriggered?: boolean;
};

// ---------------------------------------------------------------------------
// Emit (fire-and-forget, error-swallowing, non-blocking)
// ---------------------------------------------------------------------------

/**
 * Emit a telemetry document to the memory_telemetry time series collection.
 * Fire-and-forget: never blocks the caller, never throws.
 * Uses insertOne with .catch() for error-swallowing.
 */
export function emitTelemetry(db: Db, prefix: string, doc: Omit<TelemetryDocument, "ts">): void {
  const entry: TelemetryDocument = { ...doc, ts: new Date() };
  telemetryCollection(db, prefix)
    .insertOne(entry)
    .catch((err) => {
      log.warn("telemetry emit failed", { operation: doc.meta.operation, error: err });
    });
}

// ---------------------------------------------------------------------------
// Aggregation helpers (dashboard metrics)
// ---------------------------------------------------------------------------

/** Get P50/P95/P99 latency stats for a given operation over a time window. */
export async function getLatencyStats(params: {
  db: Db;
  prefix: string;
  agentId: string;
  operation?: TelemetryOperation;
  windowMs?: number;
}): Promise<{ p50: number; p95: number; p99: number; count: number }> {
  const { db, prefix, agentId, operation, windowMs = 3600000 } = params;
  const since = new Date(Date.now() - windowMs);
  const matchStage: Record<string, unknown> = {
    "meta.agentId": agentId,
    ts: { $gte: since },
  };
  if (operation) {
    matchStage["meta.operation"] = operation;
  }

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: null,
        durations: { $push: "$durationMs" },
        count: { $sum: 1 },
      },
    },
  ];

  const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
  if (results.length === 0 || results[0].count === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }

  const sorted = (results[0].durations as number[]).toSorted((a, b) => a - b);
  const n = sorted.length;
  return {
    p50: sorted[Math.floor(n * 0.5)] ?? 0,
    p95: sorted[Math.floor(n * 0.95)] ?? 0,
    p99: sorted[Math.floor(n * 0.99)] ?? 0,
    count: n,
  };
}

/** Get cache hit rate over a time window. */
export async function getCacheHitRate(params: {
  db: Db;
  prefix: string;
  agentId: string;
  windowMs?: number;
}): Promise<{ hitRate: number; hits: number; misses: number; total: number }> {
  const { db, prefix, agentId, windowMs = 3600000 } = params;
  const since = new Date(Date.now() - windowMs);

  const pipeline = [
    {
      $match: {
        "meta.agentId": agentId,
        "meta.operation": "cache-check",
        ts: { $gte: since },
      },
    },
    {
      $group: {
        _id: "$cacheHit",
        count: { $sum: 1 },
      },
    },
  ];

  const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
  let hits = 0;
  let misses = 0;
  for (const r of results) {
    if (r._id === true) {
      hits = r.count as number;
    } else {
      misses += r.count as number;
    }
  }
  const total = hits + misses;
  return { hitRate: total > 0 ? hits / total : 0, hits, misses, total };
}

/** Get operation distribution over a time window. */
export async function getOperationDistribution(params: {
  db: Db;
  prefix: string;
  agentId: string;
  windowMs?: number;
}): Promise<Array<{ operation: TelemetryOperation; count: number; avgDurationMs: number }>> {
  const { db, prefix, agentId, windowMs = 3600000 } = params;
  const since = new Date(Date.now() - windowMs);

  const pipeline = [
    {
      $match: {
        "meta.agentId": agentId,
        ts: { $gte: since },
      },
    },
    {
      $group: {
        _id: "$meta.operation",
        count: { $sum: 1 },
        avgDurationMs: { $avg: "$durationMs" },
      },
    },
    { $sort: { count: -1 } },
  ];

  const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
  return results.map((r) => ({
    operation: r._id as TelemetryOperation,
    count: r.count as number,
    avgDurationMs: Math.round(r.avgDurationMs as number),
  }));
}
