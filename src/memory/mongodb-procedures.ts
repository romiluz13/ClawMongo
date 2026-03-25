import type { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";
import type { MemoryMongoDBEmbeddingMode, MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { summarizeExplain } from "./mongodb-relevance.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import { procedureRevisionsCollection, proceduresCollection } from "./mongodb-schema.js";
import { resolveScopeRef } from "./mongodb-scope.js";
import {
  buildVectorSearchStage,
  MONGODB_MAX_NUM_CANDIDATES,
  type SearchExplainOptions,
} from "./mongodb-search.js";
import type { MemorySearchResult } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:procedures");

export type ProcedureState = "active" | "invalidated" | "conflicted";

export type ProcedureEntry = {
  procedureId: string;
  name: string;
  intentTags?: string[];
  triggerQueries?: string[];
  steps: string[];
  successSignals?: string[];
  confidence?: number;
  state?: ProcedureState;
  provenance?: Record<string, unknown>;
  sourceEventIds?: string[];
  agentId: string;
  scope?: MemoryScope;
  scopeRef?: string;
  workspaceDir?: string;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
};

type ProcedureRevision = ProcedureEntry & {
  scope: MemoryScope;
  scopeRef: string;
  state: ProcedureState;
  revision: number;
  searchText: string;
  validFrom: Date;
  validTo: Date;
  supersededAt: Date;
  updatedAt: Date;
};

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildSearchText(entry: ProcedureEntry): string {
  return [
    entry.name,
    ...(entry.intentTags ?? []),
    ...(entry.triggerQueries ?? []),
    ...entry.steps,
    ...(entry.successSignals ?? []),
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
}

function hasProcedureChanged(
  existing: Document,
  entry: ProcedureEntry,
  searchText: string,
): boolean {
  return (
    String(existing.name ?? "") !== entry.name ||
    !arraysEqual(
      Array.isArray(existing.intentTags)
        ? existing.intentTags.map((tag) => String(tag))
        : undefined,
      entry.intentTags,
    ) ||
    !arraysEqual(
      Array.isArray(existing.triggerQueries)
        ? existing.triggerQueries.map((value) => String(value))
        : undefined,
      entry.triggerQueries,
    ) ||
    !arraysEqual(
      Array.isArray(existing.steps) ? existing.steps.map((value) => String(value)) : undefined,
      entry.steps,
    ) ||
    !arraysEqual(
      Array.isArray(existing.successSignals)
        ? existing.successSignals.map((value) => String(value))
        : undefined,
      entry.successSignals,
    ) ||
    (typeof existing.confidence === "number" ? existing.confidence : undefined) !==
      entry.confidence ||
    (typeof existing.state === "string" ? existing.state : "active") !==
      (entry.state ?? "active") ||
    JSON.stringify(existing.provenance ?? null) !== JSON.stringify(entry.provenance ?? null) ||
    !arraysEqual(
      Array.isArray(existing.sourceEventIds)
        ? existing.sourceEventIds.map((value) => String(value))
        : undefined,
      entry.sourceEventIds,
    ) ||
    String(existing.searchText ?? "") !== searchText
  );
}

function buildRevisionDoc(params: {
  existing: Document;
  now: Date;
  scope: MemoryScope;
  scopeRef: string;
}): ProcedureRevision {
  const revision =
    typeof params.existing.revision === "number" && Number.isFinite(params.existing.revision)
      ? params.existing.revision
      : 1;
  const validFrom =
    params.existing.validFrom instanceof Date
      ? params.existing.validFrom
      : params.existing.createdAt instanceof Date
        ? params.existing.createdAt
        : params.existing.updatedAt instanceof Date
          ? params.existing.updatedAt
          : params.now;

  return {
    procedureId: String(params.existing.procedureId ?? ""),
    name: String(params.existing.name ?? ""),
    agentId: String(params.existing.agentId ?? ""),
    scope: params.scope,
    scopeRef: params.scopeRef,
    steps: Array.isArray(params.existing.steps)
      ? params.existing.steps.map((value) => String(value))
      : [],
    state:
      typeof params.existing.state === "string"
        ? (params.existing.state as ProcedureState)
        : "active",
    revision,
    searchText: String(params.existing.searchText ?? ""),
    validFrom,
    validTo: params.now,
    supersededAt: params.now,
    updatedAt: params.existing.updatedAt instanceof Date ? params.existing.updatedAt : params.now,
    ...(Array.isArray(params.existing.intentTags)
      ? { intentTags: params.existing.intentTags.map((value) => String(value)) }
      : {}),
    ...(Array.isArray(params.existing.triggerQueries)
      ? { triggerQueries: params.existing.triggerQueries.map((value) => String(value)) }
      : {}),
    ...(Array.isArray(params.existing.successSignals)
      ? { successSignals: params.existing.successSignals.map((value) => String(value)) }
      : {}),
    ...(typeof params.existing.confidence === "number"
      ? { confidence: params.existing.confidence }
      : {}),
    ...(params.existing.provenance && typeof params.existing.provenance === "object"
      ? { provenance: params.existing.provenance as Record<string, unknown> }
      : {}),
    ...(Array.isArray(params.existing.sourceEventIds)
      ? { sourceEventIds: params.existing.sourceEventIds.map((value) => String(value)) }
      : {}),
    ...(params.existing.createdAt instanceof Date ? { createdAt: params.existing.createdAt } : {}),
  };
}

export async function writeProcedure(params: {
  db: Db;
  prefix: string;
  entry: ProcedureEntry;
  embeddingMode: MemoryMongoDBEmbeddingMode;
  client?: MongoClient;
}): Promise<{ upserted: boolean; id: string }> {
  const { db, prefix, entry } = params;
  void params.embeddingMode;
  const collection = proceduresCollection(db, prefix);
  const revisions = procedureRevisionsCollection(db, prefix);
  const now = new Date();
  const scope = entry.scope ?? "agent";
  const scopeRef = resolveScopeRef({
    scope,
    scopeRef: entry.scopeRef,
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    workspaceDir: entry.workspaceDir,
    userId: entry.userId,
    tenantId: entry.tenantId,
  });
  const searchText = buildSearchText(entry);
  const state = entry.state ?? "active";
  const identityFilter = {
    procedureId: entry.procedureId,
    agentId: entry.agentId,
    scope,
    scopeRef,
  };
  const setDoc: Document = {
    procedureId: entry.procedureId,
    name: entry.name,
    agentId: entry.agentId,
    scope,
    scopeRef,
    steps: entry.steps,
    state,
    searchText,
    updatedAt: now,
  };
  if (entry.intentTags !== undefined) {
    setDoc.intentTags = entry.intentTags;
  }
  if (entry.triggerQueries !== undefined) {
    setDoc.triggerQueries = entry.triggerQueries;
  }
  if (entry.successSignals !== undefined) {
    setDoc.successSignals = entry.successSignals;
  }
  if (entry.confidence !== undefined) {
    setDoc.confidence = entry.confidence;
  }
  if (entry.provenance !== undefined) {
    setDoc.provenance = entry.provenance;
  }
  if (entry.sourceEventIds !== undefined) {
    setDoc.sourceEventIds = entry.sourceEventIds;
  }

  const persist = async (
    session?: ClientSession,
  ): Promise<{ upserted: boolean; id: string; revision: number }> => {
    const existing = await collection.findOne(identityFilter, session ? { session } : undefined);
    if (!existing) {
      const result = await collection.updateOne(
        identityFilter,
        {
          $set: { ...setDoc, revision: 1, validFrom: now },
          $setOnInsert: {
            createdAt: now,
            openedCount: 0,
            version: 1,
            successCount: 0,
            failCount: 0,
            evolutionHistory: [],
          },
        },
        { upsert: true, ...(session ? { session } : {}) },
      );
      return {
        upserted: result.upsertedCount > 0,
        id: entry.procedureId,
        revision: 1,
      };
    }

    const currentRevision =
      typeof existing.revision === "number" && Number.isFinite(existing.revision)
        ? existing.revision
        : 1;
    const currentValidFrom =
      existing.validFrom instanceof Date
        ? existing.validFrom
        : existing.createdAt instanceof Date
          ? existing.createdAt
          : existing.updatedAt instanceof Date
            ? existing.updatedAt
            : now;

    if (!hasProcedureChanged(existing, entry, searchText)) {
      await collection.updateOne(
        identityFilter,
        { $set: { ...setDoc, revision: currentRevision, validFrom: currentValidFrom } },
        session ? { session } : {},
      );
      return { upserted: false, id: entry.procedureId, revision: currentRevision };
    }

    await revisions.insertOne(
      buildRevisionDoc({ existing, now, scope, scopeRef }),
      session ? { session } : {},
    );
    await collection.updateOne(
      identityFilter,
      {
        $set: {
          ...setDoc,
          revision: currentRevision + 1,
          validFrom: now,
        },
        $setOnInsert: {
          createdAt: existing.createdAt instanceof Date ? existing.createdAt : now,
          openedCount: typeof existing.openedCount === "number" ? existing.openedCount : 0,
        },
      },
      { upsert: true, ...(session ? { session } : {}) },
    );
    return { upserted: false, id: entry.procedureId, revision: currentRevision + 1 };
  };

  const outcome = params.client
    ? await (async () => {
        const session = params.client!.startSession();
        try {
          let result: { upserted: boolean; id: string; revision: number } | undefined;
          await session.withTransaction(async () => {
            result = await persist(session);
          });
          return result ?? { upserted: false, id: entry.procedureId, revision: 1 };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            `procedure transaction unavailable, falling back to sequential writes: ${message}`,
          );
          return await persist();
        } finally {
          await session.endSession();
        }
      })()
    : await persist();

  log.info(
    `procedure ${outcome.upserted ? "created" : "updated"}: id=${entry.procedureId} revision=${outcome.revision}`,
  );
  return { upserted: outcome.upserted, id: outcome.id };
}

// ---------------------------------------------------------------------------
// Procedure evolution (version tracking + outcome recording)
// ---------------------------------------------------------------------------

/**
 * Record a success or failure outcome on an existing procedure.
 * Uses atomic $inc for counters and $set for timestamp.
 * Returns false if procedure not found (no upsert).
 */
export async function recordProcedureOutcome(params: {
  db: Db;
  prefix: string;
  procedureId: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  success: boolean;
}): Promise<boolean> {
  const { db, prefix, procedureId, agentId, scope, scopeRef, success } = params;
  const collection = proceduresCollection(db, prefix);
  const now = new Date();
  const filter: Document = { procedureId, agentId, scope };
  if (scopeRef !== undefined) {
    filter.scopeRef = scopeRef;
  }
  try {
    const update: Document = {
      $inc: success ? { successCount: 1 } : { failCount: 1 },
      $set: success
        ? { lastSuccessAt: now, updatedAt: now }
        : { lastFailureAt: now, updatedAt: now },
    };
    const result = await collection.updateOne(filter, update);
    if (result.matchedCount === 0) {
      log.warn(`recordProcedureOutcome: procedure not found: ${procedureId}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error("recordProcedureOutcome failed", { procedureId, error: err });
    throw err;
  }
}

/**
 * Evolve a procedure: bump version, update steps, and record in
 * bounded evolutionHistory ($push + $slice: -20).
 * Throws if procedure not found.
 */
export async function evolveProcedure(params: {
  db: Db;
  prefix: string;
  procedureId: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  newSteps: string[];
  changeType: string;
  changeDescription: string;
}): Promise<{ newVersion: number }> {
  const {
    db,
    prefix,
    procedureId,
    agentId,
    scope,
    scopeRef,
    newSteps,
    changeType,
    changeDescription,
  } = params;
  const collection = proceduresCollection(db, prefix);
  const now = new Date();
  const filter: Document = { procedureId, agentId, scope };
  if (scopeRef !== undefined) {
    filter.scopeRef = scopeRef;
  }
  try {
    // Read current version to record in history entry
    const existing = await collection.findOne(filter);
    if (!existing) {
      throw new Error(`Procedure not found: ${procedureId}`);
    }
    const currentVersion =
      typeof existing.version === "number" && Number.isFinite(existing.version)
        ? existing.version
        : 1;

    const historyEntry = {
      version: currentVersion,
      changeType,
      changeDescription,
      timestamp: now,
    };

    const update: Document = {
      $inc: { version: 1 },
      $set: { steps: newSteps, updatedAt: now },
      $push: {
        evolutionHistory: {
          $each: [historyEntry],
          $slice: -20,
        },
      },
    };

    await collection.updateOne(filter, update);
    const newVersion = currentVersion + 1;
    log.info(`evolveProcedure: ${procedureId} v${currentVersion} -> v${newVersion}`);
    return { newVersion };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Procedure not found")) {
      throw err;
    }
    log.error("evolveProcedure failed", { procedureId, error: err });
    throw err;
  }
}

function toProcedureResult(doc: Document): MemorySearchResult {
  return {
    path: `procedure:${String(doc.procedureId ?? "")}`,
    startLine: 0,
    endLine: 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.searchText === "string" ? doc.searchText.slice(0, 700) : "",
    source: "structured",
    sourceType: "structured",
    canonicalId: String(doc._id ?? doc.procedureId ?? ""),
  };
}

export async function searchProcedures(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore?: number;
    filter?: {
      agentId?: string;
      scope?: MemoryScope;
      scopeRef?: string;
      state?: ProcedureState;
      intentTags?: string[];
    };
    capabilities: DetectedCapabilities;
    vectorIndexName: string;
    embeddingMode: MemoryMongoDBEmbeddingMode;
    numCandidates?: number;
    explain?: SearchExplainOptions;
  },
): Promise<MemorySearchResult[]> {
  const minScore = opts.minScore ?? 0.1;
  const canVector =
    opts.embeddingMode === "automated"
      ? opts.capabilities.vectorSearch
      : queryVector != null && opts.capabilities.vectorSearch;
  const numCandidates = Math.min(
    opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    MONGODB_MAX_NUM_CANDIDATES,
  );
  const buildFilter = (): Document => {
    const filter: Document = {};
    if (opts.filter?.agentId) {
      filter.agentId = opts.filter.agentId;
    }
    if (opts.filter?.scope) {
      filter.scope = opts.filter.scope;
    }
    if (opts.filter?.scopeRef) {
      filter.scopeRef = opts.filter.scopeRef;
    }
    if (opts.filter?.state) {
      filter.state = opts.filter.state;
    }
    if (opts.filter?.intentTags?.length) {
      filter.intentTags = { $in: opts.filter.intentTags };
    }
    return filter;
  };

  if (canVector) {
    try {
      const vsStage = buildVectorSearchStage({
        queryVector,
        queryText: query,
        embeddingMode: opts.embeddingMode,
        indexName: opts.vectorIndexName,
        numCandidates,
        limit: opts.maxResults,
        filter: Object.keys(buildFilter()).length > 0 ? buildFilter() : undefined,
        textFieldPath: "searchText",
      });
      if (vsStage) {
        const pipeline: Document[] = [
          { $vectorSearch: vsStage },
          { $limit: opts.maxResults },
          {
            $project: {
              _id: 0,
              procedureId: 1,
              searchText: 1,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ];
        if (opts.explain?.enabled) {
          try {
            const cursor = collection.aggregate(pipeline) as unknown as {
              explain?: (verbosity?: string) => Promise<unknown>;
            };
            if (typeof cursor.explain === "function") {
              const explained = await cursor.explain("executionStats");
              opts.explain.onArtifact?.({
                artifactType: "vectorExplain",
                summary: { source: "procedure", ...summarizeExplain(explained) },
                ...(opts.explain.deep ? { rawExplain: explained } : {}),
              });
            }
          } catch {}
        }
        const docs = await collection.aggregate(pipeline).toArray();
        const results = docs.map(toProcedureResult).filter((result) => result.score >= minScore);
        if (results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`procedure vector search failed: ${msg}`);
    }
  }

  try {
    const matchFilter: Document = { $text: { $search: query }, ...buildFilter() };
    const docs = await collection
      .aggregate([
        { $match: matchFilter },
        {
          $project: {
            _id: 0,
            procedureId: 1,
            searchText: 1,
            score: { $meta: "textScore" },
          },
        },
        { $sort: { score: { $meta: "textScore" } } },
        { $limit: opts.maxResults },
      ])
      .toArray();
    if (opts.explain?.enabled) {
      opts.explain.onArtifact?.({
        artifactType: "searchExplain",
        summary: { source: "procedure", method: "$text" },
      });
    }
    return docs.map(toProcedureResult).filter((result) => result.score >= minScore);
  } catch {
    log.warn("procedure $text search fallback failed; returning empty results");
    return [];
  }
}
