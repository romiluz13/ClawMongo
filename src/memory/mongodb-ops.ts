import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ingestRunsCollection, projectionRunsCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:ops");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IngestSource = "file-sync" | "session-sync" | "kb-import" | "manual" | "event-write";
export type RunStatus = "ok" | "partial" | "failed";
export type ProjectionType = "chunks" | "entities" | "relations" | "episodes";

export type IngestRun = {
  runId: string;
  agentId: string;
  source: IngestSource;
  status: RunStatus;
  itemsProcessed: number;
  itemsFailed: number;
  durationMs: number;
  ts: Date;
};

export type ProjectionRun = {
  runId: string;
  agentId: string;
  projectionType: ProjectionType;
  status: RunStatus;
  lag?: number;
  itemsProjected: number;
  durationMs: number;
  ts: Date;
};

// ---------------------------------------------------------------------------
// Record functions
// ---------------------------------------------------------------------------

export async function recordIngestRun(params: {
  db: Db;
  prefix: string;
  run: Omit<IngestRun, "runId" | "ts">;
}): Promise<string> {
  const { db, prefix, run } = params;
  const runId = randomUUID();
  const doc: IngestRun = { ...run, runId, ts: new Date() };
  try {
    await ingestRunsCollection(db, prefix).insertOne(doc);
    return runId;
  } catch (err) {
    log.error("recordIngestRun failed", { runId, error: err });
    throw err;
  }
}

export async function recordProjectionRun(params: {
  db: Db;
  prefix: string;
  run: Omit<ProjectionRun, "runId" | "ts">;
}): Promise<string> {
  const { db, prefix, run } = params;
  const runId = randomUUID();
  const doc: ProjectionRun = { ...run, runId, ts: new Date() };
  try {
    await projectionRunsCollection(db, prefix).insertOne(doc);
    return runId;
  } catch (err) {
    log.error("recordProjectionRun failed", { runId, error: err });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function getRecentIngestRuns(params: {
  db: Db;
  prefix: string;
  agentId: string;
  limit?: number;
}): Promise<IngestRun[]> {
  const { db, prefix, agentId, limit = 20 } = params;
  try {
    const docs = await ingestRunsCollection(db, prefix)
      .find({ agentId })
      .toSorted({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs as unknown as IngestRun[];
  } catch (err) {
    log.error("getRecentIngestRuns failed", { agentId, error: err });
    throw err;
  }
}

export async function getRecentProjectionRuns(params: {
  db: Db;
  prefix: string;
  agentId: string;
  projectionType?: ProjectionType;
  limit?: number;
}): Promise<ProjectionRun[]> {
  const { db, prefix, agentId, projectionType, limit = 20 } = params;
  try {
    const filter: Record<string, unknown> = { agentId };
    if (projectionType) {
      filter.projectionType = projectionType;
    }
    const docs = await projectionRunsCollection(db, prefix)
      .find(filter)
      .toSorted({ ts: -1 })
      .limit(limit)
      .toArray();
    return docs as unknown as ProjectionRun[];
  } catch (err) {
    log.error("getRecentProjectionRuns failed", { agentId, projectionType, error: err });
    throw err;
  }
}

export async function getProjectionLag(params: {
  db: Db;
  prefix: string;
  agentId: string;
  projectionType: ProjectionType;
}): Promise<number | null> {
  const { db, prefix, agentId, projectionType } = params;
  try {
    const doc = await projectionRunsCollection(db, prefix).findOne(
      { agentId, projectionType, status: "ok" },
      { sort: { ts: -1 } },
    );
    if (!doc) {
      return null;
    }
    const ts = doc.ts as Date;
    return Math.floor((Date.now() - ts.getTime()) / 1000);
  } catch (err) {
    log.error("getProjectionLag failed", { agentId, projectionType, error: err });
    throw err;
  }
}
