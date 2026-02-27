import type { Collection, Document } from "mongodb";
import type { MemoryMongoDBFusionMethod } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mergeHybridResultsMongoDB } from "./mongodb-hybrid.js";
import { summarizeExplain } from "./mongodb-relevance.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import type { MemorySearchResult, MemorySource } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:search");

export type SearchExplainTraceArtifact = {
  artifactType: "searchExplain" | "vectorExplain" | "fusionExplain" | "scoreDetails" | "trace";
  summary: Record<string, unknown>;
  rawExplain?: unknown;
};

export type SearchExplainOptions = {
  enabled: boolean;
  deep?: boolean;
  includeScoreDetails?: boolean;
  onArtifact?: (artifact: SearchExplainTraceArtifact) => void;
};

export type SearchTraceEvent = {
  event: "method";
  method: "scoreFusion" | "rankFusion" | "js-merge" | "vector" | "keyword" | "$text";
  ok: boolean;
  message?: string;
};

async function captureAggregateExplain(
  collection: Collection,
  pipeline: Document[],
): Promise<unknown> {
  try {
    const cursor = collection.aggregate(pipeline) as unknown as {
      explain?: (verbosity?: string) => Promise<unknown>;
    };
    if (typeof cursor.explain !== "function") {
      return null;
    }
    return await cursor.explain("executionStats");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`aggregate explain capture failed: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toSearchResult(doc: Document, source: MemorySource): MemorySearchResult {
  return {
    path: typeof doc.path === "string" ? doc.path : "",
    startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
    endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
    source: (doc.source as MemorySource) ?? source,
  };
}

function filterByScore(results: MemorySearchResult[], minScore: number): MemorySearchResult[] {
  return results.filter((r) => r.score >= minScore);
}

function resolveLegacySourceFilter(sessionKey?: string): MemorySource | undefined {
  const normalized = sessionKey?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "__memory__") {
    return "memory";
  }
  if (normalized === "__sessions__") {
    return "sessions";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// $vectorSearch stage builder
// ---------------------------------------------------------------------------
// In automated mode (autoEmbed), MongoDB generates query embeddings from text
// using Voyage AI. Use `query: { text }` and `path` to the source text field.
// In managed mode, the application provides pre-computed embeddings.
// Use `queryVector` and `path` to the embedding field.
// ---------------------------------------------------------------------------

/** Hard maximum for numCandidates — MongoDB server rejects values above 10,000. */
export const MONGODB_MAX_NUM_CANDIDATES = 10_000;

export function buildVectorSearchStage(input: {
  queryVector: number[] | null;
  queryText: string | null;
  embeddingMode: "automated" | "managed";
  indexName: string;
  numCandidates: number;
  limit: number;
  filter?: Document;
  textFieldPath?: string;
}): Document | null {
  const base: Document = {
    index: input.indexName,
    numCandidates: Math.min(input.numCandidates, MONGODB_MAX_NUM_CANDIDATES),
    limit: input.limit,
  };
  if (input.filter && Object.keys(input.filter).length > 0) {
    base.filter = input.filter;
  }

  if (input.embeddingMode === "automated" && input.queryText) {
    // Automated: MongoDB generates the query embedding via Voyage AI
    base.query = { text: input.queryText };
    base.path = input.textFieldPath ?? "text";
  } else if (input.queryVector) {
    // Managed: application provides pre-computed query embedding
    base.queryVector = input.queryVector;
    base.path = "embedding";
  } else {
    return null;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Vector Search (native $vectorSearch)
// ---------------------------------------------------------------------------

export async function vectorSearch(
  collection: Collection,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    indexName: string;
    queryText?: string;
    embeddingMode?: "automated" | "managed";
    numCandidates?: number;
    explain?: SearchExplainOptions;
  },
): Promise<MemorySearchResult[]> {
  const filter: Document = {};
  const sourceFilter = resolveLegacySourceFilter(opts.sessionKey);
  if (sourceFilter) {
    filter.source = sourceFilter;
  }

  const vsStage = buildVectorSearchStage({
    queryVector,
    queryText: opts.queryText ?? null,
    embeddingMode: opts.embeddingMode ?? "managed",
    indexName: opts.indexName,
    numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    limit: opts.maxResults,
    filter,
  });

  if (!vsStage) {
    return [];
  }

  const pipeline: Document[] = [
    { $vectorSearch: vsStage },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  if (opts.explain?.enabled) {
    const explained = await captureAggregateExplain(collection, pipeline);
    if (explained) {
      opts.explain.onArtifact?.({
        artifactType: "vectorExplain",
        summary: summarizeExplain(explained),
        ...(opts.explain.deep ? { rawExplain: explained } : {}),
      });
    }
  }

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory"));
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// Keyword Search (native $search)
// ---------------------------------------------------------------------------

export async function keywordSearch(
  collection: Collection,
  query: string,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    indexName: string;
    explain?: SearchExplainOptions;
  },
): Promise<MemorySearchResult[]> {
  const filterClauses: Document[] = [];
  const sourceFilter = resolveLegacySourceFilter(opts.sessionKey);
  if (sourceFilter) {
    filterClauses.push({ equals: { path: "source", value: sourceFilter } });
  }

  const pipeline: Document[] = [
    {
      $search: {
        index: opts.indexName,
        compound: {
          must: [{ text: { query, path: "text" } }],
          ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
        },
        ...(opts.explain?.includeScoreDetails ? { scoreDetails: true } : {}),
      },
    },
    { $limit: opts.maxResults * 4 },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
        ...(opts.explain?.includeScoreDetails
          ? { scoreDetails: { $meta: "searchScoreDetails" } }
          : {}),
      },
    },
  ];

  if (opts.explain?.enabled) {
    const explained = await captureAggregateExplain(collection, pipeline);
    if (explained) {
      opts.explain.onArtifact?.({
        artifactType: "searchExplain",
        summary: summarizeExplain(explained),
        ...(opts.explain.deep ? { rawExplain: explained } : {}),
      });
    }
  }

  const docs = await collection.aggregate(pipeline).toArray();
  if (opts.explain?.enabled && opts.explain.includeScoreDetails) {
    const scoreDetailSample = docs.find((doc) => doc.scoreDetails != null)?.scoreDetails;
    if (scoreDetailSample) {
      opts.explain.onArtifact?.({
        artifactType: "scoreDetails",
        summary: { available: true },
        ...(opts.explain.deep ? { rawExplain: scoreDetailSample } : {}),
      });
    }
  }
  const results = docs.map((doc) => toSearchResult(doc, "memory")).slice(0, opts.maxResults);
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// Hybrid Search with $scoreFusion (MongoDB 8.2+)
// ---------------------------------------------------------------------------

export async function hybridSearchScoreFusion(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight: number;
    textWeight: number;
    embeddingMode?: "automated" | "managed";
    numCandidates?: number;
    explain?: SearchExplainOptions;
  },
): Promise<MemorySearchResult[]> {
  const sourceFilter: Document = {};
  const source = resolveLegacySourceFilter(opts.sessionKey);
  if (source) {
    sourceFilter.source = source;
  }

  const textFilterClauses: Document[] = [];
  if (source) {
    textFilterClauses.push({ equals: { path: "source", value: source } });
  }

  const vsStage = buildVectorSearchStage({
    queryVector,
    queryText: query,
    embeddingMode: opts.embeddingMode ?? "managed",
    indexName: opts.vectorIndexName,
    numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    limit: opts.maxResults * 4,
    filter: sourceFilter,
  });

  if (!vsStage) {
    return [];
  }

  const pipeline: Document[] = [
    {
      $scoreFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vsStage }],
            text: [
              {
                $search: {
                  index: opts.textIndexName,
                  compound: {
                    must: [{ text: { query, path: "text" } }],
                    ...(textFilterClauses.length > 0 ? { filter: textFilterClauses } : {}),
                  },
                },
              },
              { $limit: opts.maxResults * 4 },
            ],
          },
          normalization: "sigmoid",
        },
        combination: {
          weights: {
            vector: opts.vectorWeight,
            text: opts.textWeight,
          },
          method: "avg",
        },
      },
    },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  if (opts.explain?.enabled) {
    const explained = await captureAggregateExplain(collection, pipeline);
    if (explained) {
      opts.explain.onArtifact?.({
        artifactType: "fusionExplain",
        summary: { method: "scoreFusion", ...summarizeExplain(explained) },
        ...(opts.explain.deep ? { rawExplain: explained } : {}),
      });
    }
  }

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory"));
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// Hybrid Search with $rankFusion (MongoDB 8.0+)
// ---------------------------------------------------------------------------

export async function hybridSearchRankFusion(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    sessionKey?: string;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight: number;
    textWeight: number;
    embeddingMode?: "automated" | "managed";
    numCandidates?: number;
    explain?: SearchExplainOptions;
  },
): Promise<MemorySearchResult[]> {
  const sourceFilter: Document = {};
  const source = resolveLegacySourceFilter(opts.sessionKey);
  if (source) {
    sourceFilter.source = source;
  }

  const textFilterClauses: Document[] = [];
  if (source) {
    textFilterClauses.push({ equals: { path: "source", value: source } });
  }

  const vsStage = buildVectorSearchStage({
    queryVector,
    queryText: query,
    embeddingMode: opts.embeddingMode ?? "managed",
    indexName: opts.vectorIndexName,
    numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
    limit: opts.maxResults * 4,
    filter: sourceFilter,
  });

  if (!vsStage) {
    return [];
  }

  const pipeline: Document[] = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vsStage }],
            text: [
              {
                $search: {
                  index: opts.textIndexName,
                  compound: {
                    must: [{ text: { query, path: "text" } }],
                    ...(textFilterClauses.length > 0 ? { filter: textFilterClauses } : {}),
                  },
                },
              },
              { $limit: opts.maxResults * 4 },
            ],
          },
        },
        combination: {
          weights: {
            vector: opts.vectorWeight,
            text: opts.textWeight,
          },
        },
      },
    },
    { $limit: opts.maxResults },
    {
      $project: {
        _id: 0,
        path: 1,
        startLine: 1,
        endLine: 1,
        text: 1,
        source: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  if (opts.explain?.enabled) {
    const explained = await captureAggregateExplain(collection, pipeline);
    if (explained) {
      opts.explain.onArtifact?.({
        artifactType: "fusionExplain",
        summary: { method: "rankFusion", ...summarizeExplain(explained) },
        ...(opts.explain.deep ? { rawExplain: explained } : {}),
      });
    }
  }

  const docs = await collection.aggregate(pipeline).toArray();
  const results = docs.map((doc) => toSearchResult(doc, "memory"));
  return filterByScore(results, opts.minScore);
}

// ---------------------------------------------------------------------------
// JS fallback merge (for Community without mongot)
// ---------------------------------------------------------------------------

export function hybridSearchJSFallback(
  vectorResults: MemorySearchResult[],
  keywordResults: MemorySearchResult[],
  opts: { maxResults: number; vectorWeight: number; textWeight: number },
): MemorySearchResult[] {
  // Use our RRF-based merge instead of upstream's broken weighted-average merge.
  // RRF does not penalize results appearing in only one list and handles
  // incompatible score scales (cosine [0,1] vs BM25 [0,inf)) naturally.
  return mergeHybridResultsMongoDB({
    vector: vectorResults,
    keyword: keywordResults,
    maxResults: opts.maxResults,
  });
}

// ---------------------------------------------------------------------------
// Main search dispatcher
// ---------------------------------------------------------------------------

export async function mongoSearch(
  collection: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    numCandidates?: number;
    sessionKey?: string;
    fusionMethod: MemoryMongoDBFusionMethod;
    capabilities: DetectedCapabilities;
    vectorIndexName: string;
    textIndexName: string;
    vectorWeight?: number;
    textWeight?: number;
    embeddingMode?: "automated" | "managed";
    explain?: SearchExplainOptions;
    onTrace?: (event: SearchTraceEvent) => void;
  },
): Promise<MemorySearchResult[]> {
  const vectorWeight = opts.vectorWeight ?? 0.7;
  const textWeight = opts.textWeight ?? 0.3;
  const embeddingMode = opts.embeddingMode ?? "managed";

  // In automated mode, MongoDB generates query embeddings via Voyage AI —
  // no queryVector needed from the application. In managed mode, we require
  // a pre-computed queryVector.
  const canVector =
    embeddingMode === "automated"
      ? opts.capabilities.vectorSearch
      : queryVector != null && opts.capabilities.vectorSearch;

  const searchOpts = {
    ...opts,
    vectorWeight,
    textWeight,
    embeddingMode,
  };

  // Attempt hybrid search first (best quality).
  // Respect the user's fusionMethod preference:
  //   "scoreFusion" → try $scoreFusion, fall back to $rankFusion, then JS merge
  //   "rankFusion"  → try $rankFusion directly, fall back to JS merge
  //   "js-merge"    → skip server-side fusion entirely, go straight to JS merge
  if (canVector && opts.capabilities.textSearch) {
    // Try $scoreFusion (only if user wants it and server supports it)
    if (opts.fusionMethod === "scoreFusion" && opts.capabilities.scoreFusion) {
      try {
        const results = await hybridSearchScoreFusion(collection, query, queryVector, searchOpts);
        opts.onTrace?.({ event: "method", method: "scoreFusion", ok: true });
        return results;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.onTrace?.({ event: "method", method: "scoreFusion", ok: false, message: msg });
        log.warn(`$scoreFusion failed, trying $rankFusion fallback: ${msg}`);
      }
    }

    // Try $rankFusion (if user wants it, or as fallback from scoreFusion)
    if (opts.fusionMethod !== "js-merge" && opts.capabilities.rankFusion) {
      try {
        const results = await hybridSearchRankFusion(collection, query, queryVector, searchOpts);
        opts.onTrace?.({ event: "method", method: "rankFusion", ok: true });
        return results;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.onTrace?.({ event: "method", method: "rankFusion", ok: false, message: msg });
        log.warn(`$rankFusion failed, trying separate queries + JS merge: ${msg}`);
      }
    }

    // JS merge fallback: run vector + keyword separately
    try {
      const [vResults, kResults] = await Promise.all([
        vectorSearch(collection, queryVector, {
          ...searchOpts,
          indexName: opts.vectorIndexName,
          queryText: query,
        }),
        keywordSearch(collection, query, { ...searchOpts, indexName: opts.textIndexName }),
      ]);
      opts.onTrace?.({ event: "method", method: "js-merge", ok: true });
      return hybridSearchJSFallback(vResults, kResults, {
        maxResults: opts.maxResults,
        vectorWeight,
        textWeight,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onTrace?.({ event: "method", method: "js-merge", ok: false, message: msg });
      log.warn(`hybrid JS merge failed: ${msg}`);
    }
  }

  // Vector-only fallback
  if (canVector) {
    try {
      const results = await vectorSearch(collection, queryVector, {
        ...searchOpts,
        indexName: opts.vectorIndexName,
        queryText: query,
      });
      opts.onTrace?.({ event: "method", method: "vector", ok: true });
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onTrace?.({ event: "method", method: "vector", ok: false, message: msg });
      log.warn(`vector search failed: ${msg}`);
    }
  }

  // Keyword-only fallback
  if (opts.capabilities.textSearch) {
    try {
      const results = await keywordSearch(collection, query, {
        ...searchOpts,
        indexName: opts.textIndexName,
      });
      opts.onTrace?.({ event: "method", method: "keyword", ok: true });
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onTrace?.({ event: "method", method: "keyword", ok: false, message: msg });
      log.warn(`keyword search failed: ${msg}`);
    }
  }

  // Last resort: basic $text index search (Community without mongot)
  try {
    const filter: Document = { $text: { $search: query } };
    const sourceFilter = resolveLegacySourceFilter(opts.sessionKey);
    if (sourceFilter) {
      filter.source = sourceFilter;
    }
    const docs = await collection
      .aggregate([
        { $match: filter },
        {
          $project: {
            _id: 0,
            path: 1,
            startLine: 1,
            endLine: 1,
            text: 1,
            source: 1,
            score: { $meta: "textScore" },
          },
        },
        { $sort: { score: { $meta: "textScore" } } },
        { $limit: opts.maxResults },
      ])
      .toArray();
    opts.onTrace?.({ event: "method", method: "$text", ok: true });
    return docs
      .map((doc: Document) => toSearchResult(doc, "memory"))
      .filter((r: MemorySearchResult) => r.score >= opts.minScore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onTrace?.({ event: "method", method: "$text", ok: false, message });
    log.warn("$text search fallback also failed; returning empty results");
    return [];
  }
}
