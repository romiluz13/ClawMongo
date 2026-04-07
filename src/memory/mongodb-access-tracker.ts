/**
 * AccessTracker — Approximation Pattern for batched access-count writes.
 *
 * Instead of issuing a `$inc` on every memory retrieval hit, the tracker
 * accumulates access counts in an in-memory buffer and flushes them to
 * MongoDB in batches. Flush triggers:
 *   1. Buffer size reaches `flushThreshold` (default 10).
 *   2. A periodic timer fires every `flushIntervalMs` (default 60 000 ms).
 *   3. `close()` is called (cleanup).
 *
 * Each flush performs one `updateOne` per unique (id, collection) pair
 * with `$inc: { accessCount: N }` and `$set: { lastAccessedAt: now }`.
 *
 * @module mongodb-access-tracker
 */

import type { Db, Collection } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:access-tracker");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessTrackerConfig = {
  /** Flush after this many buffered accesses. Default 10. */
  flushThreshold?: number;
  /** Flush every N ms. Default 60 000. */
  flushIntervalMs?: number;
};

// ---------------------------------------------------------------------------
// ID field mapping — matches collection to its primary identifier
// ---------------------------------------------------------------------------

const COLLECTION_ID_FIELDS: Record<string, string> = {
  events: "eventId",
  episodes: "episodeId",
  structured_mem: "key",
  entities: "entityId",
  procedures: "procedureId",
  chunks: "path",
};

// ---------------------------------------------------------------------------
// AccessTracker
// ---------------------------------------------------------------------------

export class AccessTracker {
  private buffer: Map<string, { collection: string; count: number }>;
  private readonly config: Required<AccessTrackerConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private totalBuffered = 0;
  // pendingFlush tracks in-flight flush to prevent race conditions

  constructor(
    private readonly db: Db,
    private readonly prefix: string,
    config?: AccessTrackerConfig,
  ) {
    this.buffer = new Map();
    this.config = {
      flushThreshold: config?.flushThreshold ?? 10,
      flushIntervalMs: config?.flushIntervalMs ?? 60_000,
    };
    this.timer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  /**
   * Record a single access to a document. Accumulates in the buffer
   * without touching MongoDB until a flush trigger fires.
   */
  recordAccess(id: string, collection: string): void {
    const key = `${collection}::${id}`;
    const entry = this.buffer.get(key);
    if (entry) {
      entry.count++;
    } else {
      this.buffer.set(key, { collection, count: 1 });
    }
    this.totalBuffered++;

    if (this.totalBuffered >= this.config.flushThreshold) {
      // Store the promise so manual flush() can await it — do NOT void it.
      this.pendingFlush = this.doFlush();
    }
  }

  /**
   * Flush all buffered accesses to MongoDB.
   * Returns the number of documents updated.
   * Awaits any in-flight auto-flush before starting to prevent race conditions.
   */
  async flush(): Promise<number> {
    // Wait for any auto-triggered flush to complete
    if (this.pendingFlush) {
      await this.pendingFlush;
      this.pendingFlush = null;
    }
    if (this.buffer.size === 0) {
      return 0;
    }
    return this.doFlush();
  }

  private pendingFlush: Promise<number> | null = null;

  private async doFlush(): Promise<number> {
    // Snapshot and clear buffer
    const snapshot = new Map(this.buffer);
    this.buffer.clear();
    this.totalBuffered = 0;

    const now = new Date();
    let updated = 0;

    for (const [key, entry] of snapshot) {
      const id = key.slice(entry.collection.length + 2); // strip "collection::" prefix
      const idField = COLLECTION_ID_FIELDS[entry.collection] ?? "_id";
      const col: Collection = this.db.collection(`${this.prefix}${entry.collection}`);

      try {
        await col.updateOne(
          { [idField]: id },
          {
            $inc: { accessCount: entry.count },
            $set: { lastAccessedAt: now },
          },
        );
        updated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`access tracker flush failed for ${entry.collection}/${id}: ${msg}`);
      }
    }

    return updated;
  }

  /**
   * Clear the interval timer and flush remaining buffer.
   * MUST be called in test teardown to prevent timer leaks.
   */
  close(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Fire-and-forget flush of remaining buffer
    void this.flush();
  }
}
