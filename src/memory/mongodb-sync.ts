import type { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";
import fs from "node:fs/promises";
import type { MemoryMongoDBEmbeddingMode } from "../config/types.memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemorySyncProgressUpdate, MemorySource } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildFileEntry,
  chunkMarkdown,
  listMemoryFiles,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";
import { chunksCollection, filesCollection } from "./mongodb-schema.js";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  type SessionFileEntry,
} from "./session-files.js";

const log = createSubsystemLogger("memory:mongodb:sync");

// Re-export chunk helpers from internal.ts
export { chunkMarkdown };

// ---------------------------------------------------------------------------
// File metadata operations
// ---------------------------------------------------------------------------

async function getStoredFiles(
  files: Collection,
): Promise<Map<string, { hash: string; mtime: number; size: number }>> {
  const docs = await files.find({}).toArray();
  const map = new Map<string, { hash: string; mtime: number; size: number }>();
  for (const doc of docs) {
    map.set(String(doc._id), {
      hash: doc.hash as string,
      mtime: doc.mtime as number,
      size: doc.size as number,
    });
  }
  return map;
}

async function upsertFileMetadata(
  files: Collection,
  entry: MemoryFileEntry,
  source: MemorySource,
  session?: ClientSession,
): Promise<void> {
  const update = {
    $set: {
      source,
      hash: entry.hash,
      mtime: entry.mtimeMs,
      size: entry.size,
      updatedAt: new Date(),
    },
  };
  // String _id — MongoDB accepts any type for _id including strings.
  // Cast filter to satisfy TS's Collection<Document> generic (expects ObjectId by default).
  const filter = { _id: entry.path } as Record<string, unknown>;
  if (session) {
    await files.updateOne(filter, update, { upsert: true, session });
  } else {
    await files.updateOne(filter, update, { upsert: true });
  }
}

// ---------------------------------------------------------------------------
// Chunk operations
// ---------------------------------------------------------------------------

function buildChunkId(path: string, startLine: number, endLine: number): string {
  return `${path}:${startLine}:${endLine}`;
}

async function upsertChunks(
  chunks: Collection,
  path: string,
  source: MemorySource,
  chunkList: MemoryChunk[],
  model: string,
  embeddings: number[][] | null,
  session?: ClientSession,
): Promise<number> {
  if (chunkList.length === 0) {
    return 0;
  }

  const ops = chunkList.map((chunk, index) => {
    const chunkId = buildChunkId(path, chunk.startLine, chunk.endLine);
    const setDoc: Document = {
      path,
      source,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunk.hash,
      model,
      text: chunk.text,
      updatedAt: new Date(),
    };
    // Only include embedding if we have one (managed mode)
    if (embeddings && embeddings[index]) {
      setDoc.embedding = embeddings[index];
    }
    return {
      updateOne: {
        filter: { _id: chunkId } as Record<string, unknown>,
        update: { $set: setDoc },
        upsert: true,
      },
    };
  });

  const result = session
    ? await chunks.bulkWrite(ops, { ordered: false, session })
    : await chunks.bulkWrite(ops, { ordered: false });
  return result.upsertedCount + result.modifiedCount;
}

async function deleteChunksForPath(
  chunks: Collection,
  path: string,
  session?: ClientSession,
): Promise<number> {
  const result = session
    ? await chunks.deleteMany({ path }, { session })
    : await chunks.deleteMany({ path });
  return result.deletedCount;
}

async function deleteStaleChunks(
  chunks: Collection,
  validPaths: Set<string>,
  session?: ClientSession,
): Promise<number> {
  const allPaths = session
    ? await chunks.distinct("path", {}, { session })
    : await chunks.distinct("path");
  const stalePaths = allPaths.filter((p) => !validPaths.has(p));
  if (stalePaths.length === 0) {
    return 0;
  }

  const result = session
    ? await chunks.deleteMany({ path: { $in: stalePaths } }, { session })
    : await chunks.deleteMany({ path: { $in: stalePaths } });
  return result.deletedCount;
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Detect if an error indicates transactions are not supported (standalone topology).
 * Transactions require a replica set or mongos.
 */
function isTransactionNotSupported(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code: number }).code;
    // 20 = IllegalOperation (standalone), 263 = NoSuchTransaction
    if (code === 20 || code === 263) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("Transaction numbers are only allowed on a replica set");
}

/**
 * Run a per-file write operation atomically (delete old chunks + upsert new + update metadata).
 * Uses a MongoDB transaction if `client` is provided and transactions are supported.
 * Falls back to non-transactional writes for standalone topology or when no client is given.
 *
 * Returns the number of chunks upserted and whether transactions should be disabled for
 * subsequent files (standalone detection).
 */
async function syncFileAtomically(params: {
  client: MongoClient | undefined;
  useTransactions: boolean;
  chunksCol: Collection;
  filesCol: Collection;
  file: MemoryFileEntry;
  source: MemorySource;
  chunks: MemoryChunk[];
  model: string;
  embeddings: number[][] | null;
}): Promise<{ upserted: number; disableTransactions: boolean }> {
  const { client, chunksCol, filesCol, file, source, chunks, model, embeddings } = params;

  // Non-transactional path (no client, or standalone detected)
  if (!client || !params.useTransactions) {
    await deleteChunksForPath(chunksCol, file.path);
    const upserted = await upsertChunks(chunksCol, file.path, source, chunks, model, embeddings);
    await upsertFileMetadata(filesCol, file, source);
    return { upserted, disableTransactions: false };
  }

  // Transactional path — per `pattern-withtransaction-vs-core-api`:
  // use withTransaction() callback API for automatic retry handling.
  const session = client.startSession();
  try {
    let upserted = 0;
    await session.withTransaction(
      async () => {
        // Per `fundamental-propagate-session`: pass session to every operation.
        // Per `pattern-idempotent-transaction-body`: all ops are idempotent
        // (upsert + deleteMany are safe under retries).
        await deleteChunksForPath(chunksCol, file.path, session);
        upserted = await upsertChunks(
          chunksCol,
          file.path,
          source,
          chunks,
          model,
          embeddings,
          session,
        );
        await upsertFileMetadata(filesCol, file, source, session);
      },
      // Per `fundamental-commit-write-concern`: majority for durability.
      { writeConcern: { w: "majority" } },
    );
    return { upserted, disableTransactions: false };
  } catch (err) {
    // Graceful fallback for standalone topology (no replica set).
    if (isTransactionNotSupported(err)) {
      log.info("transactions not supported (standalone topology), falling back to direct writes");
      await deleteChunksForPath(chunksCol, file.path);
      const upserted = await upsertChunks(chunksCol, file.path, source, chunks, model, embeddings);
      await upsertFileMetadata(filesCol, file, source);
      return { upserted, disableTransactions: true };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export type SyncResult = {
  filesProcessed: number;
  chunksUpserted: number;
  staleDeleted: number;
  sessionFilesProcessed: number;
  sessionChunksUpserted: number;
};

export async function syncToMongoDB(params: {
  client?: MongoClient;
  db: Db;
  prefix: string;
  agentId?: string;
  workspaceDir: string;
  extraPaths?: string[];
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
  chunking?: { tokens: number; overlap: number };
  model?: string;
  reason?: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<SyncResult> {
  const { db, prefix, workspaceDir, extraPaths, embeddingMode, progress } = params;
  const model = params.model ?? "voyage-4-large";
  const chunking = params.chunking ?? { tokens: 400, overlap: 80 };
  // Track whether transactions are available (disabled on first standalone error)
  let useTransactions = !!params.client;

  const chunksCol = chunksCollection(db, prefix);
  const filesCol = filesCollection(db, prefix);

  // 2. Get stored file metadata from MongoDB
  const storedFiles = await getStoredFiles(filesCol);

  // =========================================================================
  // Phase A: Memory files (source="memory")
  // =========================================================================

  // 1. List memory files on disk (returns absolute paths)
  const diskPaths = await listMemoryFiles(workspaceDir, extraPaths);
  log.info(
    `sync: found ${diskPaths.length} memory files on disk (reason=${params.reason ?? "manual"})`,
  );

  // Build file entries with hash, mtime, size
  const diskFiles: MemoryFileEntry[] = [];
  for (const absPath of diskPaths) {
    try {
      diskFiles.push(await buildFileEntry(absPath, workspaceDir));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sync: failed to read ${absPath}: ${msg}`);
    }
  }

  // Determine which files need re-indexing
  const filesToProcess: MemoryFileEntry[] = [];
  const validPaths = new Set<string>();

  for (const file of diskFiles) {
    validPaths.add(file.path);
    const stored = storedFiles.get(file.path);
    if (params.force || !stored || stored.hash !== file.hash) {
      filesToProcess.push(file);
    }
  }

  log.info(`sync: ${filesToProcess.length}/${diskPaths.length} memory files need re-indexing`);
  progress?.({ completed: 0, total: filesToProcess.length, label: "Syncing memory files" });

  // Process each changed memory file
  let filesProcessed = 0;
  let totalChunksUpserted = 0;

  for (const file of filesToProcess) {
    try {
      // Read file and chunk OUTSIDE the transaction (I/O — keep txn short per
      // `ops-transaction-runtime-limit`).
      const content = await fs.readFile(file.absPath, "utf-8");
      const chunks = chunkMarkdown(content, chunking);

      // Generate embeddings OUTSIDE the transaction (external API call).
      let embeddings: number[][] | null = null;
      if (embeddingMode === "managed" && params.embeddingProvider) {
        try {
          const texts = chunks.map((c: MemoryChunk) => c.text);
          embeddings = await params.embeddingProvider.embedBatch(texts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`embedding generation failed for ${file.path}: ${msg}`);
        }
      }

      // Atomic write: delete old chunks + upsert new + update metadata
      const { upserted, disableTransactions } = await syncFileAtomically({
        client: params.client,
        useTransactions,
        chunksCol,
        filesCol,
        file,
        source: "memory",
        chunks,
        model,
        embeddings,
      });
      totalChunksUpserted += upserted;
      if (disableTransactions) {
        useTransactions = false;
      }

      filesProcessed++;
      progress?.({ completed: filesProcessed, total: filesToProcess.length, label: file.path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sync failed for ${file.path}: ${msg}`);
    }
  }

  // =========================================================================
  // Phase B: Session transcript files (source="sessions")
  // =========================================================================

  let sessionFilesProcessed = 0;
  let sessionChunksUpserted = 0;

  if (params.agentId) {
    try {
      const sessionResult = await syncSessionFiles({
        client: params.client,
        useTransactions,
        agentId: params.agentId,
        chunksCol,
        filesCol,
        storedFiles,
        validPaths,
        embeddingMode,
        embeddingProvider: params.embeddingProvider,
        chunking,
        model,
        force: params.force,
        progress,
      });
      sessionFilesProcessed = sessionResult.filesProcessed;
      sessionChunksUpserted = sessionResult.chunksUpserted;
      // Propagate standalone detection from session sync to stale cleanup
      if (!sessionResult.useTransactions) {
        useTransactions = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`session sync failed: ${msg}`);
    }
  }

  // =========================================================================
  // Phase C: Stale cleanup (covers both memory and session paths)
  // =========================================================================

  // Compute stale paths OUTSIDE any transaction (avoid read pressure inside txn)
  const staleFileIds: string[] = [];
  for (const [storedPath] of storedFiles) {
    if (!validPaths.has(storedPath)) {
      staleFileIds.push(storedPath);
    }
  }

  let staleDeleted = 0;
  if (params.client && useTransactions) {
    let session: ClientSession | undefined;
    try {
      session = params.client.startSession();
      await session.withTransaction(
        async () => {
          staleDeleted = await deleteStaleChunks(chunksCol, validPaths, session);
          if (staleFileIds.length > 0) {
            await filesCol.deleteMany({ _id: { $in: staleFileIds } } as Record<string, unknown>, {
              session,
            });
          }
        },
        { writeConcern: { w: "majority" } },
      );
    } catch (err) {
      if (isTransactionNotSupported(err)) {
        // Fallback: non-transactional stale cleanup
        staleDeleted = await deleteStaleChunks(chunksCol, validPaths);
        if (staleFileIds.length > 0) {
          await filesCol.deleteMany({ _id: { $in: staleFileIds } } as Record<string, unknown>);
        }
      } else {
        throw err;
      }
    } finally {
      await session?.endSession();
    }
  } else {
    staleDeleted = await deleteStaleChunks(chunksCol, validPaths);
    if (staleFileIds.length > 0) {
      await filesCol.deleteMany({ _id: { $in: staleFileIds } } as Record<string, unknown>);
    }
  }

  if (staleDeleted > 0) {
    log.info(`sync: removed ${staleDeleted} stale chunks`);
  }

  log.info(
    `sync complete: memory=${filesProcessed}/${diskPaths.length} sessions=${sessionFilesProcessed} chunks=${totalChunksUpserted + sessionChunksUpserted} stale=${staleDeleted}`,
  );

  return {
    filesProcessed,
    chunksUpserted: totalChunksUpserted,
    staleDeleted,
    sessionFilesProcessed,
    sessionChunksUpserted,
  };
}

// ---------------------------------------------------------------------------
// Session file sync
// ---------------------------------------------------------------------------

async function syncSessionFiles(params: {
  client?: MongoClient;
  useTransactions: boolean;
  agentId: string;
  chunksCol: Collection;
  filesCol: Collection;
  storedFiles: Map<string, { hash: string; mtime: number; size: number }>;
  validPaths: Set<string>;
  embeddingMode: MemoryMongoDBEmbeddingMode;
  embeddingProvider?: EmbeddingProvider;
  chunking: { tokens: number; overlap: number };
  model: string;
  force?: boolean;
  progress?: (update: MemorySyncProgressUpdate) => void;
}): Promise<{ filesProcessed: number; chunksUpserted: number; useTransactions: boolean }> {
  const sessionPaths = await listSessionFilesForAgent(params.agentId);
  if (sessionPaths.length === 0) {
    return { filesProcessed: 0, chunksUpserted: 0, useTransactions: params.useTransactions };
  }

  log.info(`sync: found ${sessionPaths.length} session files`);
  let filesProcessed = 0;
  let chunksUpserted = 0;
  let useTransactions = params.useTransactions;

  for (const absPath of sessionPaths) {
    try {
      const entry = await buildSessionEntry(absPath);
      if (!entry || !entry.content) {
        continue;
      }

      // Track this session path as valid (for stale cleanup)
      params.validPaths.add(entry.path);

      // Check if already indexed with same hash
      const stored = params.storedFiles.get(entry.path);
      if (!params.force && stored?.hash === entry.hash) {
        continue;
      }

      // Chunk the session content (same as memory files)
      const chunks = chunkMarkdown(entry.content, params.chunking);

      // Generate embeddings OUTSIDE transaction (external API call)
      let embeddings: number[][] | null = null;
      if (params.embeddingMode === "managed" && params.embeddingProvider) {
        try {
          const texts = chunks.map((c: MemoryChunk) => c.text);
          embeddings = await params.embeddingProvider.embedBatch(texts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`session embedding failed for ${entry.path}: ${msg}`);
        }
      }

      // Atomic write: delete + upsert + metadata (reuse syncFileAtomically)
      const { upserted, disableTransactions } = await syncSessionFileAtomically({
        client: params.client,
        useTransactions,
        chunksCol: params.chunksCol,
        filesCol: params.filesCol,
        entry,
        chunks,
        model: params.model,
        embeddings,
      });
      chunksUpserted += upserted;
      if (disableTransactions) {
        useTransactions = false;
      }
      filesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`session sync failed for ${absPath}: ${msg}`);
    }
  }

  log.info(`sync: sessions processed=${filesProcessed} chunks=${chunksUpserted}`);
  return { filesProcessed, chunksUpserted, useTransactions };
}

/** Atomic session file sync — same pattern as syncFileAtomically but for SessionFileEntry. */
async function syncSessionFileAtomically(params: {
  client: MongoClient | undefined;
  useTransactions: boolean;
  chunksCol: Collection;
  filesCol: Collection;
  entry: SessionFileEntry;
  chunks: MemoryChunk[];
  model: string;
  embeddings: number[][] | null;
}): Promise<{ upserted: number; disableTransactions: boolean }> {
  const { client, chunksCol, filesCol, entry, chunks, model, embeddings } = params;

  if (!client || !params.useTransactions) {
    await deleteChunksForPath(chunksCol, entry.path);
    const upserted = await upsertChunks(
      chunksCol,
      entry.path,
      "sessions",
      chunks,
      model,
      embeddings,
    );
    await upsertSessionFileMetadata(filesCol, entry);
    return { upserted, disableTransactions: false };
  }

  const session = client.startSession();
  try {
    let upserted = 0;
    await session.withTransaction(
      async () => {
        await deleteChunksForPath(chunksCol, entry.path, session);
        upserted = await upsertChunks(
          chunksCol,
          entry.path,
          "sessions",
          chunks,
          model,
          embeddings,
          session,
        );
        await upsertSessionFileMetadata(filesCol, entry, session);
      },
      { writeConcern: { w: "majority" } },
    );
    return { upserted, disableTransactions: false };
  } catch (err) {
    if (isTransactionNotSupported(err)) {
      log.info("transactions not supported (standalone), falling back for session sync");
      await deleteChunksForPath(chunksCol, entry.path);
      const upserted = await upsertChunks(
        chunksCol,
        entry.path,
        "sessions",
        chunks,
        model,
        embeddings,
      );
      await upsertSessionFileMetadata(filesCol, entry);
      return { upserted, disableTransactions: true };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

async function upsertSessionFileMetadata(
  files: Collection,
  entry: SessionFileEntry,
  session?: ClientSession,
): Promise<void> {
  const update = {
    $set: {
      source: "sessions" as MemorySource,
      hash: entry.hash,
      mtime: entry.mtimeMs,
      size: entry.size,
      updatedAt: new Date(),
    },
  };
  const filter = { _id: entry.path } as Record<string, unknown>;
  if (session) {
    await files.updateOne(filter, update, { upsert: true, session });
  } else {
    await files.updateOne(filter, update, { upsert: true });
  }
}
