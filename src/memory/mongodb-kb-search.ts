import type { Collection, Document } from "mongodb";
import type { MemoryMongoDBEmbeddingMode } from "../config/types.memory.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import type { MemorySearchResult } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:kb-search");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toKBSearchResult(doc: Document): MemorySearchResult {
  return {
    path: typeof doc.path === "string" ? doc.path : "",
    startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
    endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
    source: "kb",
  };
}

// ---------------------------------------------------------------------------
// KB Search
// ---------------------------------------------------------------------------

export async function searchKB(
  kbChunks: Collection,
  query: string,
  queryVector: number[] | null,
  opts: {
    maxResults: number;
    minScore: number;
    filter?: { tags?: string[]; category?: string; source?: string };
    vectorIndexName: string;
    textIndexName: string;
    capabilities: DetectedCapabilities;
    embeddingMode: MemoryMongoDBEmbeddingMode;
    numCandidates?: number;
  },
): Promise<MemorySearchResult[]> {
  const canVector =
    opts.embeddingMode === "automated"
      ? opts.capabilities.vectorSearch
      : queryVector != null && opts.capabilities.vectorSearch;

  // Try vector search first
  if (canVector) {
    try {
      const vsStage: Document = {
        index: opts.vectorIndexName,
        numCandidates: opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
        limit: opts.maxResults,
      };

      if (opts.embeddingMode === "automated") {
        vsStage.query = { text: query };
        vsStage.path = "text";
      } else if (queryVector) {
        vsStage.queryVector = queryVector;
        vsStage.path = "embedding";
      }

      const pipeline: Document[] = [
        { $vectorSearch: vsStage },
        {
          $project: {
            _id: 0,
            path: 1,
            startLine: 1,
            endLine: 1,
            text: 1,
            docId: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ];

      const docs = await kbChunks.aggregate(pipeline).toArray();
      const results = docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore);
      if (results.length > 0) {
        return results;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB vector search failed: ${msg}`);
    }
  }

  // Keyword search fallback using $search
  if (opts.capabilities.textSearch) {
    try {
      const pipeline: Document[] = [
        {
          $search: {
            index: opts.textIndexName,
            compound: {
              must: [{ text: { query, path: "text" } }],
            },
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
            docId: 1,
            score: { $meta: "searchScore" },
          },
        },
      ];

      const docs = await kbChunks.aggregate(pipeline).toArray();
      return docs
        .map(toKBSearchResult)
        .filter((r) => r.score >= opts.minScore)
        .slice(0, opts.maxResults);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB keyword search failed: ${msg}`);
    }
  }

  // Last resort: basic $text index search
  try {
    const filter: Document = { $text: { $search: query } };
    const docs = await kbChunks
      .aggregate([
        { $match: filter },
        {
          $project: {
            _id: 0,
            path: 1,
            startLine: 1,
            endLine: 1,
            text: 1,
            docId: 1,
            score: { $meta: "textScore" },
          },
        },
        { $sort: { score: { $meta: "textScore" } } },
        { $limit: opts.maxResults },
      ])
      .toArray();
    return docs.map(toKBSearchResult).filter((r) => r.score >= opts.minScore);
  } catch {
    log.warn("KB $text search fallback also failed; returning empty results");
    return [];
  }
}
