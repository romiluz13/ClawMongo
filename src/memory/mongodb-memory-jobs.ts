import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { memoryJobsCollection } from "./mongodb-schema.js";
import type { MemoryJob, MemoryJobStatus, MemoryJobType } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:memory-jobs");
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function clampListLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? DEFAULT_LIST_LIMIT)));
}

function allowedPreviousStatuses(status: MemoryJobStatus): MemoryJobStatus[] {
  switch (status) {
    case "pending":
      return ["pending"];
    case "running":
      return ["pending", "running"];
    case "completed":
      return ["pending", "running", "completed"];
    case "failed":
      return ["pending", "running", "failed"];
    case "cancelled":
      return ["pending", "running", "cancelled"];
  }
  throw new Error(`unsupported memory job status: ${String(status)}`);
}

export async function createMemoryJob(params: {
  db: Db;
  prefix: string;
  job: Omit<MemoryJob, "createdAt">;
}): Promise<string> {
  const doc: MemoryJob = {
    ...params.job,
    createdAt: new Date(),
  };
  await memoryJobsCollection(params.db, params.prefix).insertOne(doc);
  return doc.jobId;
}

export async function updateMemoryJob(params: {
  db: Db;
  prefix: string;
  jobId: string;
  agentId?: string;
  status: MemoryJobStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  inputCount?: number;
  outputCount?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const update: Record<string, unknown> = { status: params.status };
  for (const key of [
    "startedAt",
    "completedAt",
    "error",
    "inputCount",
    "outputCount",
    "durationMs",
    "metadata",
  ] as const) {
    if (params[key] !== undefined) {
      update[key] = params[key];
    }
  }
  const result = await memoryJobsCollection(params.db, params.prefix).updateOne(
    {
      jobId: params.jobId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      status: { $in: allowedPreviousStatuses(params.status) },
    },
    { $set: update },
  );
  if (result.matchedCount === 0) {
    log.warn(`memory job update skipped: jobId=${params.jobId} status=${params.status}`);
  }
}

export async function listMemoryJobs(params: {
  db: Db;
  prefix: string;
  agentId: string;
  status?: MemoryJobStatus;
  limit?: number;
  jobType?: MemoryJobType;
}): Promise<MemoryJob[]> {
  const docs = await memoryJobsCollection(params.db, params.prefix)
    .find({
      agentId: params.agentId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.jobType ? { jobType: params.jobType } : {}),
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
    .sort({ createdAt: -1 })
    .limit(clampListLimit(params.limit))
    .toArray();
  return docs as unknown as MemoryJob[];
}

export async function getMemoryJob(params: {
  db: Db;
  prefix: string;
  jobId: string;
  agentId?: string;
}): Promise<MemoryJob | null> {
  const doc = await memoryJobsCollection(params.db, params.prefix).findOne({
    jobId: params.jobId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  return (doc as MemoryJob | null) ?? null;
}
