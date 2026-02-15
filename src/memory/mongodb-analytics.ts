import type { Db, Document } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { chunksCollection, filesCollection, embeddingCacheCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:analytics");

export type MemorySourceStats = {
  source: string;
  fileCount: number;
  chunkCount: number;
  lastSync: Date | null;
};

export type EmbeddingCoverage = {
  withEmbedding: number;
  withoutEmbedding: number;
  total: number;
  coveragePercent: number;
};

export type MemoryStats = {
  sources: MemorySourceStats[];
  totalFiles: number;
  totalChunks: number;
  embeddingCoverage: EmbeddingCoverage;
  cachedEmbeddings: number;
  staleFiles: string[];
  collectionSizes: {
    files: number;
    chunks: number;
    embeddingCache: number;
  };
};

export async function getMemoryStats(
  db: Db,
  prefix: string,
  validPaths?: Set<string>,
): Promise<MemoryStats> {
  const chunksCol = chunksCollection(db, prefix);
  const filesCol = filesCollection(db, prefix);
  const cacheCol = embeddingCacheCollection(db, prefix);

  // Per-source file breakdown
  const sourceAgg: Document[] = await filesCol
    .aggregate([
      {
        $group: {
          _id: "$source",
          count: { $sum: 1 },
          lastSync: { $max: "$updatedAt" },
        },
      },
    ])
    .toArray();

  const sources: MemorySourceStats[] = sourceAgg.map((doc) => ({
    source: String(doc._id ?? "unknown"),
    fileCount: doc.count as number,
    chunkCount: 0, // filled below
    lastSync: doc.lastSync instanceof Date ? doc.lastSync : null,
  }));

  // Per-source chunk counts
  const chunkSourceAgg: Document[] = await chunksCol
    .aggregate([{ $group: { _id: "$source", count: { $sum: 1 } } }])
    .toArray();

  for (const doc of chunkSourceAgg) {
    const src = sources.find((s) => s.source === String(doc._id));
    if (src) {
      src.chunkCount = doc.count as number;
    }
  }

  // Embedding coverage
  const embeddingAgg: Document[] = await chunksCol
    .aggregate([
      {
        $group: {
          _id: null,
          withEmbedding: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $ifNull: ["$embedding", []] } }, 0] }, 1, 0],
            },
          },
          total: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const embRow = embeddingAgg[0] ?? { withEmbedding: 0, total: 0 };
  const withEmb = embRow.withEmbedding as number;
  const totalChunks = embRow.total as number;
  const embeddingCoverage: EmbeddingCoverage = {
    withEmbedding: withEmb,
    withoutEmbedding: totalChunks - withEmb,
    total: totalChunks,
    coveragePercent: totalChunks > 0 ? Math.round((withEmb / totalChunks) * 100) : 0,
  };

  // Cached embeddings count
  const cachedEmbeddings = await cacheCol.countDocuments();

  // Stale files (in DB but not on disk)
  let staleFiles: string[] = [];
  if (validPaths) {
    const allDbPaths = await filesCol.distinct("_id");
    staleFiles = allDbPaths.map(String).filter((p) => !validPaths.has(p));
  }

  // Collection document counts
  const totalFiles = await filesCol.countDocuments();

  log.info(
    `stats: files=${totalFiles} chunks=${totalChunks} cached=${cachedEmbeddings} stale=${staleFiles.length}`,
  );

  return {
    sources,
    totalFiles,
    totalChunks,
    embeddingCoverage,
    cachedEmbeddings,
    staleFiles,
    collectionSizes: {
      files: totalFiles,
      chunks: totalChunks,
      embeddingCache: cachedEmbeddings,
    },
  };
}
