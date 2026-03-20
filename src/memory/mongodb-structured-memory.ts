import type { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";
import type { MemoryMongoDBEmbeddingMode, MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { EmbeddingStatus } from "./mongodb-embedding-retry.js";
import { summarizeExplain } from "./mongodb-relevance.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import { structuredMemCollection, structuredMemRevisionsCollection } from "./mongodb-schema.js";
import { resolveScopeRef } from "./mongodb-scope.js";
import {
  buildVectorSearchStage,
  MONGODB_MAX_NUM_CANDIDATES,
  type SearchExplainOptions,
} from "./mongodb-search.js";
import type { MemorySearchResult } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:structured");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StructuredMemoryType =
  | "decision"
  | "preference"
  | "person"
  | "todo"
  | "fact"
  | "project"
  | "architecture"
  | "custom";

export type StructuredMemoryEntry = {
  type: StructuredMemoryType;
  key: string;
  value: string;
  context?: string;
  confidence?: number;
  source?: "agent" | "user" | "session" | "ingestion";
  sessionId?: string;
  agentId: string;
  tags?: string[];
  scope?: MemoryScope;
  scopeRef?: string;
  workspaceDir?: string;
  userId?: string;
  tenantId?: string;
};

type StructuredMemoryRevision = {
  type: StructuredMemoryType;
  key: string;
  value: string;
  context?: string;
  confidence?: number;
  source?: "agent" | "user" | "session" | "ingestion";
  sessionId?: string;
  agentId: string;
  tags?: string[];
  scope: MemoryScope;
  scopeRef: string;
  revision: number;
  validFrom: Date;
  validTo: Date;
  supersededAt: Date;
  createdAt?: Date;
  updatedAt: Date;
};

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasStructuredValueChanged(existing: Document, entry: StructuredMemoryEntry): boolean {
  return (
    existing.value !== entry.value ||
    (typeof existing.context === "string" ? existing.context : undefined) !== entry.context ||
    (typeof existing.confidence === "number" ? existing.confidence : undefined) !==
      entry.confidence ||
    (typeof existing.source === "string" ? existing.source : undefined) !== entry.source ||
    (typeof existing.sessionId === "string" ? existing.sessionId : undefined) !== entry.sessionId ||
    !arraysEqual(
      Array.isArray(existing.tags) ? existing.tags.map((tag) => String(tag)) : undefined,
      entry.tags,
    )
  );
}

function buildRevisionDoc(params: {
  existing: Document;
  scope: MemoryScope;
  scopeRef: string;
  now: Date;
}): StructuredMemoryRevision {
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
    type: params.existing.type as StructuredMemoryType,
    key: String(params.existing.key ?? ""),
    value: String(params.existing.value ?? ""),
    agentId: String(params.existing.agentId ?? ""),
    scope: params.scope,
    scopeRef: params.scopeRef,
    revision,
    validFrom,
    validTo: params.now,
    supersededAt: params.now,
    updatedAt: params.existing.updatedAt instanceof Date ? params.existing.updatedAt : params.now,
    ...(typeof params.existing.context === "string" ? { context: params.existing.context } : {}),
    ...(typeof params.existing.confidence === "number"
      ? { confidence: params.existing.confidence }
      : {}),
    ...(typeof params.existing.source === "string"
      ? { source: params.existing.source as StructuredMemoryEntry["source"] }
      : {}),
    ...(typeof params.existing.sessionId === "string"
      ? { sessionId: params.existing.sessionId }
      : {}),
    ...(Array.isArray(params.existing.tags)
      ? { tags: params.existing.tags.map((tag) => String(tag)) }
      : {}),
    ...(params.existing.createdAt instanceof Date ? { createdAt: params.existing.createdAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Write (upsert)
// ---------------------------------------------------------------------------

export async function writeStructuredMemory(params: {
  db: Db;
  prefix: string;
  entry: StructuredMemoryEntry;
  embeddingMode: MemoryMongoDBEmbeddingMode;
  client?: MongoClient;
}): Promise<{ upserted: boolean; id: string }> {
  const { db, prefix, entry } = params;
  const collection = structuredMemCollection(db, prefix);
  const revisions = structuredMemRevisionsCollection(db, prefix);

  // ClawMongo stores structured memory as text and relies on MongoDB automatic
  // embeddings during vector search instead of precomputing vectors here.
  let embeddingStatus: EmbeddingStatus = "pending";

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
  const setDoc: Document = {
    type: entry.type,
    key: entry.key,
    value: entry.value,
    agentId: entry.agentId,
    scope,
    scopeRef,
    embeddingStatus,
    validFrom: now,
    updatedAt: now,
  };
  if (entry.context !== undefined) {
    setDoc.context = entry.context;
  }
  if (entry.confidence !== undefined) {
    setDoc.confidence = entry.confidence;
  }
  if (entry.source !== undefined) {
    setDoc.source = entry.source;
  }
  if (entry.sessionId !== undefined) {
    setDoc.sessionId = entry.sessionId;
  }
  if (entry.tags !== undefined) {
    setDoc.tags = entry.tags;
  }

  const identityFilter = {
    agentId: entry.agentId,
    scope,
    scopeRef,
    type: entry.type,
    key: entry.key,
  };

  const persist = async (
    session?: ClientSession,
  ): Promise<{ upserted: boolean; id: string; revision: number }> => {
    const existing = await collection.findOne(identityFilter, session ? { session } : undefined);
    if (!existing) {
      const result = await collection.updateOne(
        identityFilter,
        {
          $set: { ...setDoc, revision: 1 },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, ...(session ? { session } : {}) },
      );
      return {
        upserted: result.upsertedCount > 0,
        id: result.upsertedId ? String(result.upsertedId) : entry.key,
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

    if (!hasStructuredValueChanged(existing, entry)) {
      await collection.updateOne(
        identityFilter,
        {
          $set: {
            ...setDoc,
            revision: currentRevision,
            validFrom: currentValidFrom,
          },
        },
        session ? { session } : {},
      );
      return { upserted: false, id: entry.key, revision: currentRevision };
    }

    await revisions.insertOne(
      buildRevisionDoc({ existing, scope, scopeRef, now }),
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
        },
      },
      { upsert: true, ...(session ? { session } : {}) },
    );
    return { upserted: false, id: entry.key, revision: currentRevision + 1 };
  };

  const outcome = params.client
    ? await (async () => {
        const session = params.client!.startSession();
        try {
          let result: { upserted: boolean; id: string; revision: number } | undefined;
          await session.withTransaction(async () => {
            result = await persist(session);
          });
          return result ?? { upserted: false, id: entry.key, revision: 1 };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            `structured memory transaction unavailable, falling back to sequential writes: ${message}`,
          );
          return await persist();
        } finally {
          await session.endSession();
        }
      })()
    : await persist();

  log.info(
    `structured memory ${outcome.upserted ? "created" : "updated"}: type=${entry.type} key=${entry.key} revision=${outcome.revision}`,
  );
  return { upserted: outcome.upserted, id: outcome.id };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function toStructuredResult(doc: Document): MemorySearchResult {
  const params = new URLSearchParams();
  if (typeof doc.scope === "string") {
    params.set("scope", doc.scope);
  }
  if (typeof doc.scopeRef === "string") {
    params.set("scopeRef", doc.scopeRef);
  }
  const locator = `structured:${doc.type ?? "unknown"}:${doc.key ?? ""}${
    params.size > 0 ? `?${params.toString()}` : ""
  }`;
  return {
    path: locator,
    startLine: 0,
    endLine: 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.value === "string" ? doc.value.slice(0, 700) : "",
    source: "structured",
    sourceType: "structured",
  };
}

export async function searchStructuredMemory(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore?: number;
    filter?: {
      type?: string;
      tags?: string[];
      agentId?: string;
      scope?: MemoryScope;
      scopeRef?: string;
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

  // Try vector search (F5: uses shared buildVectorSearchStage)
  if (canVector) {
    try {
      const filter: Document = {};
      if (opts.filter?.type) {
        filter.type = opts.filter.type;
      }
      if (opts.filter?.tags?.length) {
        filter.tags = { $in: opts.filter.tags };
      }
      if (opts.filter?.agentId) {
        filter.agentId = opts.filter.agentId;
      }
      if (opts.filter?.scope) {
        filter.scope = opts.filter.scope;
      }
      if (opts.filter?.scopeRef) {
        filter.scopeRef = opts.filter.scopeRef;
      }

      const vsStage = buildVectorSearchStage({
        queryVector,
        queryText: query,
        embeddingMode: opts.embeddingMode,
        indexName: opts.vectorIndexName,
        numCandidates,
        limit: opts.maxResults,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        textFieldPath: "value", // structured memory stores text in "value" field
      });

      if (vsStage) {
        const pipeline: Document[] = [
          { $vectorSearch: vsStage },
          { $limit: opts.maxResults },
          {
            $project: {
              _id: 0,
              type: 1,
              key: 1,
              value: 1,
              context: 1,
              confidence: 1,
              tags: 1,
              scope: 1,
              scopeRef: 1,
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
                summary: { source: "structured", ...summarizeExplain(explained) },
                ...(opts.explain.deep ? { rawExplain: explained } : {}),
              });
            }
          } catch {}
        }

        const docs = await collection.aggregate(pipeline).toArray();
        const results = docs.map(toStructuredResult).filter((r) => r.score >= minScore);
        if (results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`structured memory vector search failed: ${msg}`);
    }
  }

  // $text fallback
  try {
    const matchFilter: Document = { $text: { $search: query } };
    if (opts.filter?.type) {
      matchFilter.type = opts.filter.type;
    }
    if (opts.filter?.tags?.length) {
      matchFilter.tags = { $in: opts.filter.tags };
    }
    if (opts.filter?.agentId) {
      matchFilter.agentId = opts.filter.agentId;
    }
    if (opts.filter?.scope) {
      matchFilter.scope = opts.filter.scope;
    }
    if (opts.filter?.scopeRef) {
      matchFilter.scopeRef = opts.filter.scopeRef;
    }

    const docs = await collection
      .aggregate([
        { $match: matchFilter },
        {
          $project: {
            _id: 0,
            type: 1,
            key: 1,
            value: 1,
            context: 1,
            confidence: 1,
            tags: 1,
            scope: 1,
            scopeRef: 1,
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
        summary: { source: "structured", method: "$text" },
      });
    }
    return docs.map(toStructuredResult).filter((r) => r.score >= minScore);
  } catch {
    log.warn("structured memory $text search fallback failed; returning empty results");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Query by type
// ---------------------------------------------------------------------------

export async function getStructuredMemoryByType(
  db: Db,
  prefix: string,
  type: string,
  agentId?: string,
  limit?: number,
): Promise<
  Array<{
    type: string;
    key: string;
    value: string;
    confidence: number;
    updatedAt: Date;
  }>
> {
  const collection = structuredMemCollection(db, prefix);
  const filter: Document = { type };
  if (agentId) {
    filter.agentId = agentId;
  }
  const docs = await collection
    .find(filter, { sort: { updatedAt: -1 }, limit: limit ?? 50 })
    .toArray();

  return docs.map((doc: Record<string, unknown>) => ({
    type: doc.type as string,
    key: doc.key as string,
    value: doc.value as string,
    confidence: (doc.confidence as number) ?? 0.8,
    updatedAt: doc.updatedAt as Date,
  }));
}
