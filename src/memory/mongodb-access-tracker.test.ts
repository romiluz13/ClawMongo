/**
 * AccessTracker — Approximation Pattern for batched access tracking writes.
 * Tests validate: buffering, batched flush, threshold auto-flush, timer flush,
 * close cleanup, and multi-access accumulation.
 */

import type { Db, Collection, UpdateResult } from "mongodb";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------- Mocks ----------

function makeMockCollection(): Collection {
  return {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 } as UpdateResult),
  } as unknown as Collection;
}

function makeMockDb(collections: Record<string, Collection>): Db {
  return {
    collection: vi.fn((name: string) => {
      return collections[name] ?? makeMockCollection();
    }),
  } as unknown as Db;
}

describe("AccessTracker", () => {
  let tracker: InstanceType<typeof import("./mongodb-access-tracker.js").AccessTracker>;
  let eventsCol: Collection;
  let episodesCol: Collection;
  let db: Db;

  beforeEach(async () => {
    vi.useFakeTimers();
    eventsCol = makeMockCollection();
    episodesCol = makeMockCollection();
    db = makeMockDb({
      test_events: eventsCol,
      test_episodes: episodesCol,
    });

    const mod = await import("./mongodb-access-tracker.js");
    tracker = new mod.AccessTracker(db, "test_", {
      flushThreshold: 10,
      flushIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    // CRITICAL: clean up timer to prevent leaks
    tracker.close();
    vi.useRealTimers();
  });

  test("recordAccess accumulates counts in buffer (no DB write until flush)", () => {
    tracker.recordAccess("event-1", "events");
    tracker.recordAccess("event-2", "events");
    tracker.recordAccess("ep-1", "episodes");

    // No DB writes should happen yet
    expect(eventsCol.updateOne).not.toHaveBeenCalled();
    expect(episodesCol.updateOne).not.toHaveBeenCalled();
  });

  test("flush() performs batched $inc write to correct collection", async () => {
    tracker.recordAccess("event-1", "events");
    tracker.recordAccess("ep-1", "episodes");

    const updated = await tracker.flush();

    expect(updated).toBe(2);
    expect(eventsCol.updateOne).toHaveBeenCalledTimes(1);
    expect(episodesCol.updateOne).toHaveBeenCalledTimes(1);

    // Verify the $inc pattern
    const eventsCall = (eventsCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(eventsCall[0]).toEqual({ eventId: "event-1" });
    expect(eventsCall[1].$inc).toEqual({ accessCount: 1 });
    expect(eventsCall[1].$set).toHaveProperty("lastAccessedAt");

    const episodesCall = (episodesCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(episodesCall[0]).toEqual({ episodeId: "ep-1" });
    expect(episodesCall[1].$inc).toEqual({ accessCount: 1 });
    expect(episodesCall[1].$set).toHaveProperty("lastAccessedAt");
  });

  test("auto-flush at threshold (10 accesses triggers flush)", async () => {
    // Record 10 accesses to trigger threshold flush
    for (let i = 0; i < 10; i++) {
      tracker.recordAccess(`event-${i}`, "events");
    }

    // Allow microtask (flush is async internally)
    await vi.advanceTimersByTimeAsync(0);

    // Should have flushed all 10 items
    expect(eventsCol.updateOne).toHaveBeenCalledTimes(10);
  });

  test("timer-based flush every 60s", async () => {
    tracker.recordAccess("event-1", "events");

    // No flush yet
    expect(eventsCol.updateOne).not.toHaveBeenCalled();

    // Advance timer by 60s
    await vi.advanceTimersByTimeAsync(60_000);

    // Should have flushed
    expect(eventsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  test("close() flushes remaining buffer", async () => {
    tracker.recordAccess("event-1", "events");
    tracker.recordAccess("ep-1", "episodes");

    // close() triggers a synchronous flush attempt
    tracker.close();

    // Allow microtask for the async flush
    await vi.advanceTimersByTimeAsync(0);

    expect(eventsCol.updateOne).toHaveBeenCalledTimes(1);
    expect(episodesCol.updateOne).toHaveBeenCalledTimes(1);
  });

  test("multiple accesses to same ID accumulate correctly", async () => {
    tracker.recordAccess("event-1", "events");
    tracker.recordAccess("event-1", "events");
    tracker.recordAccess("event-1", "events");

    const updated = await tracker.flush();

    expect(updated).toBe(1); // Only 1 document updated (1 unique ID)
    expect(eventsCol.updateOne).toHaveBeenCalledTimes(1);

    // Verify the accumulated count is 3
    const call = (eventsCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].$inc).toEqual({ accessCount: 3 });
  });
});
