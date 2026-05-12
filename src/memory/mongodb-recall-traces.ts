import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { recallTracesCollection } from "./mongodb-schema.js";
import type { RecallTrace } from "./types.js";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function clampListLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? DEFAULT_LIST_LIMIT)));
}

export async function recordRecallTrace(params: {
  db: Db;
  prefix: string;
  trace: Omit<RecallTrace, "traceId" | "timestamp"> & {
    traceId?: string;
    timestamp?: Date;
  };
}): Promise<string> {
  const traceId = params.trace.traceId ?? randomUUID();
  const doc: RecallTrace = {
    ...params.trace,
    traceId,
    timestamp: params.trace.timestamp ?? new Date(),
  };
  await recallTracesCollection(params.db, params.prefix).insertOne(doc);
  return traceId;
}

export async function listRecallTraces(params: {
  db: Db;
  prefix: string;
  agentId: string;
  limit?: number;
}): Promise<RecallTrace[]> {
  const docs = await recallTracesCollection(params.db, params.prefix)
    .find({ agentId: params.agentId })
    // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
    .sort({ timestamp: -1 })
    .limit(clampListLimit(params.limit))
    .toArray();
  return docs as unknown as RecallTrace[];
}

export async function getRecallTrace(params: {
  db: Db;
  prefix: string;
  traceId: string;
  agentId?: string;
}): Promise<RecallTrace | null> {
  const doc = await recallTracesCollection(params.db, params.prefix).findOne({
    traceId: params.traceId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  return (doc as RecallTrace | null) ?? null;
}
