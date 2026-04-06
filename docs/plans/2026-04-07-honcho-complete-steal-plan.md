# Honcho Complete Steal Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD. Every sub-agent MUST receive the Skill Hints block at the bottom of this document.
> **Design:** See `docs/plans/2026-04-07-honcho-complete-steal-design.md` for full specification.
> **Honcho Reference:** See `/Users/rom.iluz/.claude/projects/-Users-rom-iluz-Dev-ClawMongo-v2/memory/honcho_steal_analysis.md`
> **Dreaming Eval:** See `docs/plans/2026-04-06-dreaming-wiki-mongodb-evaluation.md`

**Goal:** Complete the Honcho steal from 8/10 to 10/10 by implementing Reasoning Chain Traversal, Surprisal-Based Novelty Detection, and Consolidation Agent (Dreamer), plus upstream Dreaming (importance/access/decay) and Wiki (source categorization) integration.

**Architecture:** Foundation-first sequential build. Three new standalone modules (`mongodb-reasoning-chain.ts`, `mongodb-novelty.ts`, `mongodb-consolidator.ts`) plus extensions to 4 existing files. One new collection (`consolidation_runs`), 3 new indexes, 2 new tools. All functions follow the standalone `(db, prefix, agentId, ...)` pattern. agentId isolation enforced at every query hop via `restrictSearchWithMatch`.

**Tech Stack:** TypeScript ESM, MongoDB (atlas-local:preview for testing), Vitest, existing `$graphLookup` pattern from `mongodb-graph.ts`

**Prerequisites:**

- Phase 0 (commit + push Wave 7 work) MUST complete first — 59 uncommitted files
- Docker MongoDB atlas-local:preview running for e2e tests
- Voyage API key for vector search tests (optional — novelty degrades gracefully)

**Durable Decisions:**

- Standalone function pattern: `functionName(db, prefix, agentId, ...)` — NOT class methods
- agentId in every `restrictSearchWithMatch` for `$graphLookup` (proven pattern from `mongodb-graph.ts:762`)
- Access tracking uses Approximation Pattern: in-memory accumulator, flush on threshold (NOT per-request `$inc`)
- `$lookup` from source collection to events, then `$graphLookup` within events for reasoning chains
- Atlas Vector Search graceful degradation: return empty report when mongot unavailable, never crash
- Consolidation writes to `structured_memory` via existing `writeStructuredMemory()` (at `src/memory/mongodb-structured-memory.ts:333`), not a new write path
- New standalone functions are callable from tools via wrapper methods on MongoDBMemoryManager (same pattern as `hydrateActiveSlate` at line 2339 of `mongodb-manager.ts`), with optional method additions to MemorySearchManager interface in `types.ts`
- `consolidation_runs` is the only new collection (25 total). 3 new indexes (~70 total).
- Importance decay computed at query time, not storage time: `effective = importance * 0.5^(days/halfLife)`

---

## Baselines (MUST verify at Phase 7)

| Metric                          | Before       | After                                                                                        | Delta                     |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------------------- | ------------------------- |
| Collections                     | 24           | 25                                                                                           | +1 (`consolidation_runs`) |
| Standard indexes                | 67           | 70                                                                                           | +3                        |
| mongodb-\*.ts files             | 83           | 86                                                                                           | +3 new modules            |
| Test files                      | +3 new       | `mongodb-reasoning-chain.test.ts`, `mongodb-novelty.test.ts`, `mongodb-consolidator.test.ts` |
| Agent tools                     | existing + 2 | +`memory_reasoning_chain`, +`memory_novelty_scan`                                            |
| `EXPECTED_COLLECTION_SUFFIXES`  | 24 entries   | 25 entries                                                                                   |
| `EXPECTED_STANDARD_INDEX_COUNT` | 67           | 70                                                                                           |

---

## Relevant Codebase Files

### Patterns to Follow

- `src/memory/mongodb-graph.ts` (lines 738-790) — `$graphLookup` with `$facet`, `restrictSearchWithMatch: { agentId }`, `maxDepth` clamping
- `src/memory/mongodb-events.ts` (lines 178-228) — `markEventsConsolidated()`, `getUnconsolidatedEvents()`
- `src/memory/mongodb-episodes.ts` — `materializeEpisode()` for episode creation pattern
- `src/memory/mongodb-schema.ts` (lines 795-815) — `VALIDATED_COLLECTIONS` registry, `ensureCollections()` list
- `src/memory/mongodb-schema.ts` (lines 922-1377) — `ensureStandardIndexes()` — append new indexes here
- `src/memory/mongodb-result-trust.ts` (lines 130-154) — `computeResultTrust()` 6-dimension scoring
- `src/memory/mongodb-reranker.ts` — `crossEncoderRerank()` — extend for importance decay
- `src/memory/types.ts` — all type definitions (add new interfaces here)
- `src/memory/index.ts` — barrel exports (add new module exports here)
- `src/agents/tools/memory-tool.ts` (lines 660-731) — `createMemoryTool()` pattern for new tool registration
- `src/memory/mongodb-e2e.e2e.test.ts` (lines 63-89) — `EXPECTED_COLLECTION_SUFFIXES`, `EXPECTED_STANDARD_INDEX_COUNT`

### Configuration Files

- `src/memory/mongodb-schema.ts` — collection schemas, indexes, search indexes
- `src/memory/mongodb-ops.ts` — `recordProjectionRun()` for tracking consolidation runs

### Test Patterns

- `src/memory/mongodb-graph.test.ts` — mock Db pattern for `$graphLookup` unit tests
- `src/memory/mongodb-events.test.ts` — mock collection pattern
- `src/memory/mongodb-e2e.e2e.test.ts` — e2e test structure with real MongoDB

---

## Behavioral Invariants (extend existing 26 to 33)

These are the NEW invariants added by this plan. They extend the 26 invariants verified during Wave 7.

| ID  | Invariant                                                                                                   | Verification                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 27  | `traceReasoningChain()` returns ordered chain oldest-first for any fact with `sourceEventIds`               | Unit test: multi-hop chain returns nodes in timestamp order                     |
| 28  | `traceReasoningChain()` enforces `agentId` in `restrictSearchWithMatch` — no cross-agent leakage            | Unit test: chain for agent-A does not include agent-B events                    |
| 29  | `scanNovelty()` returns empty report when mongot unavailable, never throws                                  | Unit test: mock $vectorSearch failure returns `{ events: [], scannedCount: 0 }` |
| 30  | `AccessTracker.flush()` uses batched `$inc` write, not per-access                                           | Unit test: 15 `recordAccess()` calls produce 1-2 bulk writes                    |
| 31  | Importance decay formula: `effective = importance * Math.pow(0.5, daysSinceCreation / recencyHalfLifeDays)` | Unit test: 7-day-old event with importance=1.0 returns ~0.5                     |
| 32  | `consolidateMemory()` marks events as consolidated after processing, idempotent on re-run                   | Unit test: second run on same events produces 0 new promotions                  |
| 33  | `EXPECTED_COLLECTION_SUFFIXES` = 25, `EXPECTED_STANDARD_INDEX_COUNT` = 70                                   | E2E assertion in mongodb-e2e.e2e.test.ts                                        |

---

## Phase 0: Commit + Push Wave 7 Work [HITL — requires user action]

**Objective:** Clear the 59 uncommitted files from the Wave 7 merge and memory improvements so subsequent phases build on clean git state.

**Files:** All currently modified (59 files from Wave 7 merge + memory improvements)

**Dependencies:** None

**Allowed scope:** Commit and push only. No code changes.

**Out-of-scope drift:** Do not start Phase 1 before push completes.

**Steps:**

1. `git add -A && git status` — verify staged files
2. `scripts/committer "Wave 7: upstream sync + memory improvements" <files...>`
3. `git push origin main`

**Exit criteria:**

- `git status` shows clean working tree
- `git log -1` shows the commit on main
- Remote `origin/main` is up to date

**Checkpoint:** HITL — user must approve commit and push.

**Required checks:** `git status` clean

---

## Phase 1: Reasoning Chain Traversal (~200 LOC + ~10 tests)

**Objective:** Create `mongodb-reasoning-chain.ts` that traces any structured fact back to its original conversation events via `$lookup` + `$graphLookup` on `sourceEventIds`.

**Files:**

- Create: `src/memory/mongodb-reasoning-chain.ts`
- Create: `src/memory/mongodb-reasoning-chain.test.ts`
- Modify: `src/memory/types.ts` — add `ReasoningChainNode`, `ReasoningChain`, `ReasoningChainOptions` types
- Modify: `src/memory/index.ts` — add exports

**Dependencies:** `sourceEventIds` field exists in 6 collection schemas (verified in `mongodb-schema.ts` lines 225, 288, 336, 400, 580, 615).

**Allowed scope:** New module + types + barrel exports only.

**Out-of-scope drift:** Do NOT modify schema, indexes, or tools in this phase.

### Types to Add (`src/memory/types.ts`)

```typescript
export type ReasoningChainNodeType = "event" | "fact" | "gap";

export type ReasoningChainNode = {
  type: ReasoningChainNodeType;
  id: string;
  collection: string;
  body?: string;
  role?: string;
  timestamp?: Date;
  depth: number;
  reason?: string; // for gap nodes: "deleted" | "missing_sourceEventIds"
};

export type ReasoningChain = {
  factId: string;
  collection: string;
  nodes: ReasoningChainNode[];
  chainComplete: boolean;
  maxDepthReached: boolean;
  agentId: string;
};

export type ReasoningChainOptions = {
  maxDepth?: number; // default 10, clamped >= 0
};
```

### Implementation Pattern (`src/memory/mongodb-reasoning-chain.ts`)

The function MUST follow these exact patterns from `mongodb-graph.ts`:

1. **Function signature:** `export async function traceReasoningChain(params: { db: Db; prefix: string; agentId: string; factId: string; collection: string; options?: ReasoningChainOptions }): Promise<ReasoningChain>`
2. **Two-hop strategy:**
   - First: `$match` the fact by `factId` in the source collection (e.g., `structured_mem`, `entities`, `relations`, `procedures`, `entity_links`) — use the collection name from the `collection` param
   - Then: `$lookup` the fact's `sourceEventIds` array against `events.eventId`
   - Then: `$graphLookup` within events: `connectFromField: "sourceEventIds"` does NOT work because events don't have `sourceEventIds` — events ARE the leaf nodes. The chain walks BACKWARDS from the derived fact through intermediate derived objects to original events.

**CRITICAL CORRECTION:** Events do NOT have `sourceEventIds`. The `sourceEventIds` field is on derived objects (structured_mem, entities, relations, procedures, entity_links). The traversal strategy is:

```
Fact (structured_mem) → sourceEventIds → events (leaf nodes, no further traversal)
```

For facts that were derived from OTHER derived objects (e.g., a structured_mem fact derived from another structured_mem fact), the chain needs to:

1. Find the fact in its source collection
2. Read its `sourceEventIds`
3. For each sourceEventId, check if it's an event (events collection) or if there's a derived object that references it
4. If it's an event: that's a leaf node
5. If a derived object has this eventId in its `sourceEventIds`: recurse

**Simplified approach (Phase 1):** Since events are always the leaf nodes and most derived objects point directly to events via `sourceEventIds`, the Phase 1 implementation does a single-hop lookup:

```typescript
// Phase 1: Single-hop chain (fact → events)
// 1. Find fact in source collection
// 2. Read sourceEventIds from the fact
// 3. $lookup those IDs in events collection
// 4. Return ordered chain: events (oldest first) → fact (newest)
```

This handles the common case. Multi-hop chains (fact → derived → events) can be added as a Phase 1b enhancement if needed.

**Implementation steps:**

**Step 1: Write failing tests**

Create `src/memory/mongodb-reasoning-chain.test.ts`:

```typescript
// Test 1: Single-hop chain - fact with 2 sourceEventIds returns 3-node chain
// Test 2: Fact with no sourceEventIds returns single-node chain (fact only)
// Test 3: Fact not found returns empty chain with chainComplete: true
// Test 4: agentId isolation - chain for agent-A does not include agent-B's fact
// Test 5: maxDepth clamping - maxDepth=0 produces Math.max(0, 0) = valid behavior
// Test 6: Deleted event in sourceEventIds produces gap node
// Test 7: Empty sourceEventIds array returns single-node chain
// Test 8: Collection name validation - unknown collection returns empty chain
// Test 9: Chain ordering - events sorted by timestamp ascending (oldest first), fact last
// Test 10: maxDepth respected - deep chain stops at configured depth
```

Mock pattern: follow `mongodb-graph.test.ts` — mock `db.collection()` to return mock collection with `findOne()`, `aggregate()`.

**Step 2: Run tests, verify they fail**

```bash
pnpm test src/memory/mongodb-reasoning-chain.test.ts
```

Expected: FAIL (module not found)

**Step 3: Implement `src/memory/mongodb-reasoning-chain.ts`**

Core aggregation pipeline:

```typescript
const pipeline: Document[] = [
  // 1. Match the fact
  { $match: { [idField]: factId, agentId } },
  // 2. Lookup source events
  {
    $lookup: {
      from: `${prefix}events`,
      let: { sourceIds: { $ifNull: ["$sourceEventIds", []] } },
      pipeline: [
        { $match: { $expr: { $in: ["$eventId", "$$sourceIds"] }, agentId } },
        { $sort: { timestamp: 1 } },
      ],
      as: "sourceEvents",
    },
  },
];
```

Key implementation details:

- `agentId` in BOTH the fact match AND the event lookup pipeline `$match`
- Use `$ifNull: ["$sourceEventIds", []]` to handle missing field gracefully
- `Math.max(0, options?.maxDepth ?? 10)` for depth clamping
- Return gap nodes for sourceEventIds that don't resolve to events
- Sort events by `timestamp` ascending (oldest first = root cause)
- The fact itself is the last node in the chain

**Step 4: Run tests, verify they pass**

```bash
pnpm test src/memory/mongodb-reasoning-chain.test.ts
```

Expected: PASS (10/10)

**Step 5: Add types to `src/memory/types.ts`**

Append the `ReasoningChainNode`, `ReasoningChain`, `ReasoningChainOptions` types.

**Step 6: Add exports to `src/memory/index.ts`**

```typescript
export {
  traceReasoningChain,
  type ReasoningChain,
  type ReasoningChainNode,
  type ReasoningChainOptions,
} from "./mongodb-reasoning-chain.js";
```

**Step 7: Verify build**

```bash
pnpm build && pnpm check
```

Expected: exit 0

**Step 8: Commit**

```bash
scripts/committer "Memory: add reasoning chain traversal via $lookup on sourceEventIds" src/memory/mongodb-reasoning-chain.ts src/memory/mongodb-reasoning-chain.test.ts src/memory/types.ts src/memory/index.ts
```

### Expected artifacts:

- `src/memory/mongodb-reasoning-chain.ts` (~200 LOC)
- `src/memory/mongodb-reasoning-chain.test.ts` (~10 tests)
- Updated `src/memory/types.ts` (+20 lines)
- Updated `src/memory/index.ts` (+5 lines)

### Required checks:

- `pnpm test src/memory/mongodb-reasoning-chain.test.ts` — 10/10 PASS
- `pnpm build` — exit 0
- `pnpm check` — exit 0 (or pre-existing errors only)

### Exit criteria:

- `traceReasoningChain()` returns ordered chain for facts with `sourceEventIds`
- Single-node chain returned for facts without `sourceEventIds`
- Gap nodes for deleted/missing events
- agentId isolation verified by test
- Invariants 27, 28 verified

---

## Phase 2: Surprisal Novelty Detection (~150 LOC + ~8 tests)

**Objective:** Create `mongodb-novelty.ts` that identifies the most novel/anomalous stored observations using Atlas Vector Search kNN distance scoring. Graceful degradation when mongot is unavailable.

**Files:**

- Create: `src/memory/mongodb-novelty.ts`
- Create: `src/memory/mongodb-novelty.test.ts`
- Modify: `src/memory/types.ts` — add `NoveltyEvent`, `NoveltyReport`, `NoveltyOptions` types

**Dependencies:** Phase 1 complete. Atlas Vector Search embedding index on events collection (may not exist — graceful fallback required).

**Allowed scope:** New module + types only. No schema changes.

**Out-of-scope drift:** Do NOT add indexes or collection changes here.

### Types to Add (`src/memory/types.ts`)

```typescript
export type NoveltyEvent = {
  eventId: string;
  body: string;
  noveltyScore: number; // 0-1, higher = more novel
  timestamp: Date;
  role: string;
  nearestNeighborDistance: number;
};

export type NoveltyReport = {
  events: NoveltyEvent[];
  scannedCount: number;
  error?: string; // "mongot_unavailable" when vector search fails
  agentId: string;
};

export type NoveltyOptions = {
  limit?: number; // default 10 (top-N most novel)
  kNeighbors?: number; // default 5 (K nearest neighbors for scoring)
  scope?: MemoryScope;
  timeRange?: { start: Date; end: Date };
};
```

### Implementation Pattern (`src/memory/mongodb-novelty.ts`)

**Function signature:**

```typescript
export async function scanNovelty(params: {
  db: Db;
  prefix: string;
  agentId: string;
  options?: NoveltyOptions;
}): Promise<NoveltyReport>;
```

**Strategy:** For each recent event with an embedding, use `$vectorSearch` to find its K nearest neighbors. The novelty score is the average distance to those neighbors (inverted: higher distance = more novel). Events that are far from everything else are the most surprising.

**CRITICAL: Graceful degradation.** If `$vectorSearch` fails (mongot not running, no vector index, network error):

```typescript
try {
  // ... $vectorSearch pipeline ...
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log.warn(`novelty scan failed (mongot likely unavailable): ${msg}`);
  return { events: [], scannedCount: 0, error: "mongot_unavailable", agentId };
}
```

**Pipeline approach:**

```typescript
// For each candidate event, compute distance to K nearest neighbors
// using $vectorSearch's score metadata
const pipeline: Document[] = [
  {
    $vectorSearch: {
      index: "idx_events_vector",
      path: "embedding",
      queryVector: candidateEmbedding,
      numCandidates: kNeighbors * 10,
      limit: kNeighbors,
      filter: { agentId },
    },
  },
  { $project: { eventId: 1, score: { $meta: "vectorSearchScore" } } },
];
```

**NOTE:** This approach requires iterating over candidate events and running a `$vectorSearch` per candidate, which is expensive. A more efficient approach:

1. Get recent unconsolidated events (last N, default 50)
2. For events with embeddings, compute pairwise distances using the existing embedding vectors
3. Events whose average distance to their K nearest neighbors is highest are the most novel

The efficient approach computes novelty client-side from embedding vectors, avoiding N separate `$vectorSearch` calls. This is the recommended implementation.

**Alternative (simpler, recommended for Phase 2):** Use a single `$vectorSearch` call with the centroid of recent events as the query vector. Events that appear LEAST in the results (lowest score) are the most novel. Events that don't appear at all are the most novel.

**Simplest correct approach:**

1. Fetch recent events with embeddings
2. Compute average embedding (centroid)
3. Run one `$vectorSearch` with centroid as query vector
4. Events in the collection but NOT in the results (or with lowest scores) are most novel
5. If no embeddings exist or `$vectorSearch` fails: return empty report

### Test Plan

```
// Test 1: Empty events collection returns empty report
// Test 2: Events without embeddings returns empty report (no crash)
// Test 3: mongot unavailable returns error report (not exception)
// Test 4: agentId isolation - only scans events for the given agent
// Test 5: Novelty scoring - event far from centroid has higher score
// Test 6: Limit parameter respected
// Test 7: Scope filter applied
// Test 8: Time range filter applied
```

### Steps

1. Write failing tests in `src/memory/mongodb-novelty.test.ts`
2. Run tests, verify fail
3. Implement `src/memory/mongodb-novelty.ts`
4. Run tests, verify pass
5. Add types to `src/memory/types.ts`
6. Add exports to `src/memory/index.ts`
7. `pnpm build && pnpm check`
8. Commit

### Expected artifacts:

- `src/memory/mongodb-novelty.ts` (~150 LOC)
- `src/memory/mongodb-novelty.test.ts` (~8 tests)
- Updated `src/memory/types.ts` (+18 lines)
- Updated `src/memory/index.ts` (+5 lines)

### Required checks:

- `pnpm test src/memory/mongodb-novelty.test.ts` — 8/8 PASS
- `pnpm build` — exit 0
- Invariant 29 verified

### Exit criteria:

- `scanNovelty()` returns scored events sorted by novelty descending
- Graceful degradation verified (mongot_unavailable error, no crash)
- agentId isolation verified

---

## Phase 3: Importance + Access Tracking (~100 LOC + ~6 tests)

**Objective:** Add importance scoring fields to events/episodes schemas, create `AccessTracker` class using the Approximation Pattern (batched writes), and add the new `consolidation_runs` collection + 3 new indexes.

**Files:**

- Create: `src/memory/mongodb-access-tracker.ts` (~100 LOC)
- Create: `src/memory/mongodb-access-tracker.test.ts`
- Modify: `src/memory/mongodb-schema.ts` — add fields to EVENTS_SCHEMA and EPISODES_SCHEMA, add CONSOLIDATION_RUNS_SCHEMA, add consolidation_runs to needed list and VALIDATED_COLLECTIONS, add 3 new indexes
- Modify: `src/memory/mongodb-e2e.e2e.test.ts` — update `EXPECTED_COLLECTION_SUFFIXES` (24 -> 25), `EXPECTED_STANDARD_INDEX_COUNT` (67 -> 70)
- Modify: `src/memory/types.ts` — add `AccessTrackerConfig` type

**Dependencies:** Phase 2 complete.

**Allowed scope:** Schema extensions, new AccessTracker module, e2e baseline updates.

**Out-of-scope drift:** Do NOT modify the reranker or tool registration here.

### Schema Changes (`src/memory/mongodb-schema.ts`)

**Add to EVENTS_SCHEMA properties:**

```typescript
importance: { bsonType: "number", minimum: 0, maximum: 1, description: "Importance score (0-1)" },
accessCount: { bsonType: "number", minimum: 0, description: "Approximate access count (approximation pattern)" },
lastAccessedAt: { bsonType: "date", description: "Last access timestamp" },
dreamerProcessedAt: { bsonType: "date", description: "When this event was processed by the consolidation agent (Dreamer)" },
dreamerRunId: { bsonType: "string", description: "Consolidation run that processed this event" },
```

**Add to EPISODES_SCHEMA properties:**

```typescript
importance: { bsonType: "number", minimum: 0, maximum: 1, description: "Importance score (0-1)" },
accessCount: { bsonType: "number", minimum: 0, description: "Approximate access count (approximation pattern)" },
lastAccessedAt: { bsonType: "date", description: "Last access timestamp" },
sourceEventIds: { bsonType: "array", items: { bsonType: "string" }, description: "Source event IDs for provenance" },
```

**New CONSOLIDATION_RUNS_SCHEMA:**

```typescript
const CONSOLIDATION_RUNS_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: ["runId", "agentId", "startedAt", "status"],
    properties: {
      runId: { bsonType: "string", description: "Unique run identifier" },
      agentId: { bsonType: "string" },
      startedAt: { bsonType: "date" },
      completedAt: { bsonType: "date" },
      status: { enum: ["running", "completed", "failed"], description: "Run status" },
      eventsProcessed: { bsonType: "number", minimum: 0 },
      factsPromoted: { bsonType: "number", minimum: 0 },
      factsPruned: { bsonType: "number", minimum: 0 },
      conflictsResolved: { bsonType: "number", minimum: 0 },
      durationMs: { bsonType: "number" },
      error: { bsonType: "string" },
    },
  },
};
```

**Add to VALIDATED_COLLECTIONS:**

```typescript
consolidation_runs: CONSOLIDATION_RUNS_SCHEMA,
```

**Add to ensureCollections needed list:**

```typescript
"consolidation_runs",
```

**New collection accessor:**

```typescript
export function consolidationRunsCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "consolidation_runs");
}
```

**Add 3 indexes to ensureStandardIndexes:**

```typescript
// Importance-based promotion candidates
const episodes = episodesCollection(db, prefix); // already declared above
await episodes.createIndex(
  { agentId: 1, importance: -1, accessCount: -1 },
  { name: "idx_episodes_agent_importance_access" },
);
applied++;

// NOTE: Wiki source index DEFERRED to Phase 5 — KB has no agentId field, and vault is added in Phase 5.
// See Phase 5 for the KB wiki index.

// Consolidation run tracking
const consolidationRuns = consolidationRunsCollection(db, prefix);
await consolidationRuns.createIndex(
  { agentId: 1, startedAt: -1 },
  { name: "idx_consolidation_runs_agent_started" },
);
applied++;
```

**IMPORTANT:** The `episodes` variable is already declared earlier in `ensureStandardIndexes`. The new index additions for `episodes` must use that existing variable reference — do NOT re-declare it. The `consolidationRuns` variable is new. Place the 2 new indexes (episodes + consolidation_runs) at the END of `ensureStandardIndexes`, just before the `log.info` line. The KB wiki index is deferred to Phase 5 (KB has no agentId field, and vault/wikiSource are added in Phase 5).

**INDEX COUNT UPDATE:** Phase 3 adds 2 indexes (not 3). Phase 5 adds the 3rd. Total still reaches 70 by Phase 7.

### AccessTracker Implementation (`src/memory/mongodb-access-tracker.ts`)

```typescript
export type AccessTrackerConfig = {
  flushThreshold?: number; // default 10 — flush after this many buffered accesses
  flushIntervalMs?: number; // default 60_000 — flush every N ms
};

export class AccessTracker {
  private buffer: Map<string, { collection: string; count: number }>;
  private config: Required<AccessTrackerConfig>;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(
    private db: Db,
    private prefix: string,
    config?: AccessTrackerConfig,
  ) { ... }

  recordAccess(id: string, collection: string): void {
    // Accumulate in buffer. If buffer size >= threshold, flush.
  }

  async flush(): Promise<number> {
    // Batched $inc writes for all buffered accesses.
    // For each (id, collection) in buffer:
    //   collection.updateOne({ _id_field: id }, { $inc: { accessCount: count }, $set: { lastAccessedAt: new Date() } })
    // Clear buffer after flush.
    // Return number of documents updated.
  }

  close(): void {
    // Clear interval timer, flush remaining.
  }
}
```

### Test Plan

```
// Test 1: recordAccess accumulates counts in buffer (no DB write until flush)
// Test 2: flush() performs batched $inc write to correct collection
// Test 3: Auto-flush at threshold (10 accesses triggers flush)
// Test 4: Timer-based flush every 60s
// Test 5: close() flushes remaining buffer
// Test 6: Multiple accesses to same ID accumulate correctly
```

### Steps

1. Write failing tests for AccessTracker
2. Run tests, verify fail
3. Implement `src/memory/mongodb-access-tracker.ts`
4. Run tests, verify pass
5. Modify `src/memory/mongodb-schema.ts` — add schema fields, collection, indexes
6. Update `src/memory/mongodb-e2e.e2e.test.ts` — `EXPECTED_COLLECTION_SUFFIXES` add `"consolidation_runs"`, `EXPECTED_STANDARD_INDEX_COUNT` = 70
7. Add types and exports to `src/memory/types.ts` and `src/memory/index.ts`
8. `pnpm build && pnpm check`
9. Commit

### Expected artifacts:

- `src/memory/mongodb-access-tracker.ts` (~100 LOC)
- `src/memory/mongodb-access-tracker.test.ts` (~6 tests)
- Updated `src/memory/mongodb-schema.ts` (+60 lines)
- Updated `src/memory/mongodb-e2e.e2e.test.ts` (+2 lines)

### Required checks:

- `pnpm test src/memory/mongodb-access-tracker.test.ts` — 6/6 PASS
- `pnpm build` — exit 0
- Invariant 30 verified

### Exit criteria:

- AccessTracker accumulates accesses and flushes in batches
- 3 new schema fields on events + episodes
- 1 new collection (`consolidation_runs`) with schema validation
- 2 new indexes created (episodes promotion + consolidation_runs tracking; KB wiki index deferred to Phase 5)
- `EXPECTED_COLLECTION_SUFFIXES` = 25
- `EXPECTED_STANDARD_INDEX_COUNT` = 69 (Phase 5 adds the 3rd index to reach 70)

---

## Phase 4: Importance Decay in Ranking (~30 LOC + ~4 tests)

**Objective:** Extend the heuristic reranker with importance-weighted scoring using time-decayed importance.

**Files:**

- Modify: `src/memory/mongodb-result-trust.ts` — add `computeImportanceDecay()` pure function
- Modify: `src/memory/mongodb-result-trust.test.ts` — add decay tests (or create if not exists)

**Dependencies:** Phase 3 complete (importance field exists on schema).

**Allowed scope:** Pure function addition to trust module. No DB changes.

**Out-of-scope drift:** Do NOT modify the crossEncoderRerank or the retrieval planner here.

### Implementation

Add to `src/memory/mongodb-result-trust.ts`:

```typescript
/**
 * Compute time-decayed effective importance.
 * importance * 0.5^(daysSinceCreation / recencyHalfLifeDays)
 * @param importance - raw importance score (0-1)
 * @param createdAt - when the document was created
 * @param now - current time
 * @param recencyHalfLifeDays - half-life in days (default 7)
 */
export function computeImportanceDecay(
  importance: number | undefined,
  createdAt: Date | undefined,
  now: Date = new Date(),
  recencyHalfLifeDays: number = 7,
): number {
  const raw =
    typeof importance === "number" && Number.isFinite(importance) ? clamp01(importance) : 0.5; // default importance
  if (!(createdAt instanceof Date)) {
    return raw;
  }
  const daysSinceCreation = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS);
  return clamp01(raw * Math.pow(0.5, daysSinceCreation / recencyHalfLifeDays));
}
```

Also integrate into `applyTrustAwareReranking()` — add `importanceWeight` param (default 0.10):

```typescript
// In the scored.map() callback, after trust calculation:
const importanceDecay = computeImportanceDecay(
  (result as any).importance,
  result.timestamp ?? result.signals?.updatedAt,
  now,
);
adjustedScore += importanceDecay * importanceWeight;
```

### Test Plan

```
// Test 1: 7-day-old event with importance=1.0 returns ~0.5
// Test 2: Brand new event (0 days old) with importance=1.0 returns ~1.0
// Test 3: Missing importance defaults to 0.5
// Test 4: Missing createdAt returns raw importance unchanged
```

### Steps

1. Write failing tests
2. Run tests, verify fail
3. Implement `computeImportanceDecay()` function
4. Integrate into `applyTrustAwareReranking()`
5. Run tests, verify pass
6. Export from `src/memory/index.ts`
7. `pnpm build && pnpm check`
8. Commit

### Required checks:

- `pnpm test src/memory/mongodb-result-trust.test.ts` — all PASS
- `pnpm build` — exit 0
- Invariant 31 verified

### Exit criteria:

- `computeImportanceDecay()` pure function produces correct decay values
- Reranker uses importance decay as scoring component
- Existing trust scoring unchanged

---

## Phase 5: Wiki Source Categorization (~40 LOC + ~4 tests)

**Objective:** Add wiki source categorization fields to KB entries schema for distinguishing wiki content from other reference material.

**Files:**

- Modify: `src/memory/mongodb-schema.ts` — add `wikiSource`, `vault`, `section` fields to KB_CHUNKS_SCHEMA
- Modify: `src/memory/mongodb-structured-memory.ts` or KB ingestion path — add source field awareness (if needed)
- Create or modify test file for KB schema validation

**Dependencies:** Phase 4 complete.

**Allowed scope:** Schema field additions + KB wiki index (deferred from Phase 3 because KB has no `agentId` field and `vault`/`wikiSource` didn't exist until this phase).

**Out-of-scope drift:** Do NOT implement LLM compilation pipeline or Obsidian import.

### Schema Changes

**Add to KB_CHUNKS_SCHEMA properties:**

```typescript
wikiSource: {
  enum: ["wiki", "reference", "imported"],
  description: "Source category for wiki/reference material",
},
vault: { bsonType: "string", description: "Wiki vault name" },
section: { bsonType: "string", description: "Wiki section path" },
```

**NOTE:** The index `{ agentId: 1, source: 1, vault: 1 }` on kb_chunks was added in Phase 3. However, looking at the KB collection structure, KB entries live in `knowledge_base` and `kb_chunks`. The `wikiSource` field should be on `kb_chunks` (the searchable layer) and the `knowledge_base` document should carry a `wikiSource` field too for metadata.

**Add to KB_SCHEMA properties:**

```typescript
wikiSource: {
  enum: ["wiki", "reference", "imported"],
  description: "Source category for wiki/reference material",
},
vault: { bsonType: "string", description: "Wiki vault name" },
section: { bsonType: "string", description: "Wiki section path" },
```

**KB Wiki Index (deferred from Phase 3):** Add to `ensureStandardIndexes`:

```typescript
const kbChunks = kbChunksCollection(db, prefix); // already declared above
await kbChunks.createIndex(
  { docId: 1, wikiSource: 1, vault: 1 },
  { name: "idx_kb_chunks_doc_wikisource_vault", sparse: true },
);
applied++;
```

NOTE: KB_SCHEMA and KB_CHUNKS_SCHEMA do NOT have `agentId` — KB entries are scoped via `docId` which references the knowledge_base document. The index uses `docId` (not `agentId`).

### Test Plan

```
// Test 1: KB entry with wikiSource="wiki" passes schema validation
// Test 2: KB entry with vault and section fields passes validation
// Test 3: KB entry without wikiSource/vault/section still passes (optional fields)
// Test 4: Invalid wikiSource value rejected by schema
```

### Steps

1. Write failing tests
2. Run tests, verify fail
3. Add schema fields to KB_SCHEMA and KB_CHUNKS_SCHEMA
4. Run tests, verify pass
5. `pnpm build && pnpm check`
6. Commit

### Required checks:

- Schema tests PASS
- `pnpm build` — exit 0

### Exit criteria:

- KB entries accept `wikiSource`, `vault`, `section` fields
- Schema validation enforces enum constraint on `wikiSource`
- KB wiki index `{ docId: 1, wikiSource: 1, vault: 1 }` created
- No breaking changes to existing KB entries
- EXPECTED_STANDARD_INDEX_COUNT reaches 70 (Phase 3 added 2, this phase adds 1)

---

## Phase 6: Consolidation Agent / Dreamer (~400 LOC + ~12 tests)

**Objective:** Create `mongodb-consolidator.ts` — the offline consolidation pipeline that reads unconsolidated events, scores them using novelty + importance + access patterns, walks reasoning chains for provenance, deduces new structured facts, resolves conflicts via trust scoring, and records the run.

**Files:**

- Create: `src/memory/mongodb-consolidator.ts`
- Create: `src/memory/mongodb-consolidator.test.ts`
- Modify: `src/memory/types.ts` — add `ConsolidationResult`, `ConsolidationOptions`, `ConsolidationCandidate` types
- Modify: `src/memory/index.ts` — add exports

**Dependencies:** Phases 1-5 complete. Uses:

- `getUnconsolidatedEvents()` from `mongodb-events.ts`
- `markEventsConsolidated()` from `mongodb-events.ts`
- `traceReasoningChain()` from `mongodb-reasoning-chain.ts` (Phase 1)
- `scanNovelty()` from `mongodb-novelty.ts` (Phase 2)
- `computeImportanceDecay()` from `mongodb-result-trust.ts` (Phase 4)
- `computeResultTrust()` from `mongodb-result-trust.ts`
- `writeStructuredMemory()` from `mongodb-structured-memory.ts`
- `consolidationRunsCollection()` from `mongodb-schema.ts` (Phase 3)

**Allowed scope:** New module. May wire into existing functions but NOT modify their signatures.

**Out-of-scope drift:** Do NOT add LLM calls. Consolidation uses rule-based pattern matching only (deduction, not induction). LLM-powered induction is a future enhancement.

### Types to Add (`src/memory/types.ts`)

```typescript
export type ConsolidationCandidate = {
  eventId: string;
  body: string;
  timestamp: Date;
  noveltyScore: number;
  importanceDecay: number;
  accessCount: number;
  combinedScore: number;
};

export type ConsolidationResult = {
  runId: string;
  agentId: string;
  eventsProcessed: number;
  factsPromoted: number;
  factsPruned: number;
  conflictsResolved: number;
  durationMs: number;
  candidates: ConsolidationCandidate[];
};

export type ConsolidationOptions = {
  maxEvents?: number; // default 100
  minCombinedScore?: number; // default 0.3 — minimum score to consider for promotion
  minIntervalMs?: number; // default 3_600_000 (1 hour) — minimum time between runs
  noveltyWeight?: number; // default 0.4
  importanceWeight?: number; // default 0.3
  accessWeight?: number; // default 0.3
  scope?: MemoryScope;
};
```

### Implementation Pattern (`src/memory/mongodb-consolidator.ts`)

**Function signature:**

```typescript
export async function consolidateMemory(params: {
  db: Db;
  prefix: string;
  agentId: string;
  options?: ConsolidationOptions;
}): Promise<ConsolidationResult>;
```

**Pipeline:**

```
1. Rate limit check: query consolidation_runs for last run. If < minIntervalMs ago, return early.
2. Record run start: insert { runId, agentId, startedAt: new Date(), status: "running" }
3. Query un-dreamer-processed events: query events where `dreamerProcessedAt: { $exists: false }` and `agentId` matches (NOT `getUnconsolidatedEvents()` — that checks episode consolidation via `consolidatedAt`, which is a different lifecycle)
4. Score each candidate:
   a. noveltyScore: from scanNovelty() result (match by eventId)
   b. importanceDecay: computeImportanceDecay(event.importance, event.timestamp)
   c. accessCount: event.accessCount ?? 0
   d. combinedScore: noveltyWeight * noveltyScore + importanceWeight * importanceDecay + accessWeight * normalizedAccess
5. Filter candidates with combinedScore >= minCombinedScore
6. For top candidates (sorted by combinedScore desc):
   a. traceReasoningChain() for provenance context
   b. Pattern-match for deducible facts:
      - User statements with "I prefer X" → { type: "preference", key: X, value: statement }
      - User statements with "I decided X" → { type: "decision", key: X, value: statement }
      - Repeated mentions (reinforcementCount > 2) → { type: "fact", key: topic, value: summary }
   c. Check for conflicts with existing structured_memory via computeResultTrust()
   d. If no conflict: upsert to structured_memory with sourceEventIds pointing to the event
   e. If conflict detected: log and skip (don't auto-resolve without LLM)
7. Mark all processed events as dreamer-processed: create new `markEventsDreamerProcessed()` function (NOT `markEventsConsolidated()` — that requires an `episodeId` for episode consolidation, which the Dreamer doesn't produce). The new function sets `dreamerProcessedAt: new Date()` and `dreamerRunId: runId` on events. Add `dreamerProcessedAt` field to EVENTS_SCHEMA in Phase 3.
8. Record run completion: update consolidation_runs with status, counts, duration
9. Return ConsolidationResult
```

**Rule-based pattern matching (step 6b) — examples:**

```typescript
const PREFERENCE_PATTERN = /\b(?:I\s+(?:prefer|like|want|always use|love))\s+(.+)/i;
const DECISION_PATTERN = /\b(?:I\s+(?:decided|chose|picked|selected|went with))\s+(.+)/i;
const FACT_PATTERN = /\b(?:(?:actually|in fact|the truth is|it turns out))\s+(.+)/i;
```

These patterns are intentionally conservative. They identify high-confidence deductions only. False negatives are acceptable; false positives are not.

**Error handling:**

- Individual candidate failures don't crash the pipeline (try/catch per candidate)
- Run is recorded as "failed" if the overall process throws
- Rate limiting prevents runaway consolidation

### Test Plan

```
// Test 1: Empty unconsolidated events returns 0 processed
// Test 2: Rate limiting - second run within minIntervalMs returns early
// Test 3: Candidate scoring - higher novelty + importance = higher combined score
// Test 4: minCombinedScore threshold filters low-score candidates
// Test 5: Pattern matching - "I prefer X" extracts preference fact
// Test 6: Pattern matching - "I decided X" extracts decision fact
// Test 7: Existing conflict detected - fact NOT promoted, conflict logged
// Test 8: Events marked consolidated after processing
// Test 9: Run recorded in consolidation_runs collection
// Test 10: Idempotency - re-running on consolidated events produces 0 new promotions
// Test 11: Individual candidate failure doesn't crash pipeline
// Test 12: agentId isolation - only processes events for given agent
```

### Steps

1. Write failing tests
2. Run tests, verify fail
3. Implement `src/memory/mongodb-consolidator.ts`
4. Run tests, verify pass
5. Add types to `src/memory/types.ts`
6. Add exports to `src/memory/index.ts`
7. `pnpm build && pnpm check`
8. Commit

### Expected artifacts:

- `src/memory/mongodb-consolidator.ts` (~400 LOC)
- `src/memory/mongodb-consolidator.test.ts` (~12 tests)
- Updated `src/memory/types.ts` (+30 lines)
- Updated `src/memory/index.ts` (+5 lines)

### Required checks:

- `pnpm test src/memory/mongodb-consolidator.test.ts` — 12/12 PASS
- `pnpm build` — exit 0
- Invariant 32 verified

### Exit criteria:

- `consolidateMemory()` processes unconsolidated events and promotes facts
- Rate limiting prevents excessive runs
- Pattern-based deduction extracts preferences and decisions
- Trust scoring prevents conflict auto-resolution
- Events marked consolidated after processing
- Run tracking in `consolidation_runs` collection
- Idempotent: re-running produces 0 new promotions for already-consolidated events

---

## Phase 7: Tool Registration + Final Validation [HITL — publish requires user action]

**Objective:** Register 2 new tools (`memory_reasoning_chain`, `memory_novelty_scan`), run full validation suite, update baselines, commit, and prepare for npm publish.

**Files:**

- Modify: `src/memory/types.ts` — add 2 optional methods to MemorySearchManager interface
- Modify: `src/memory/mongodb-manager.ts` — add 2 wrapper methods (traceReasoningChain, scanNovelty) delegating to standalone functions
- Modify: `src/agents/tools/memory-tool.ts` — add 2 new tool creators following existing pattern
- Modify: `src/plugins/runtime/runtime-tools.ts` — import + re-export the 2 new tool creators (CRITICAL — without this, tools won't be available at runtime)
- Modify: `src/memory/mongodb-e2e.e2e.test.ts` — verify baselines
- All files from Phases 1-6

**Dependencies:** Phases 1-6 complete.

**Allowed scope:** Manager wiring, tool registration, final validation, baselines.

**Out-of-scope drift:** Do NOT add new features or fix unrelated issues.

### Manager Wiring (CRITICAL — must be done BEFORE tool registration)

The new standalone functions (`traceReasoningChain`, `scanNovelty`) need to be callable from tools. Since `db` and `prefix` are `private readonly` on MongoDBMemoryManager (line 394-395 of `mongodb-manager.ts`), tools cannot call standalone functions directly. Follow the established pattern:

**Step A: Add optional methods to MemorySearchManager interface (`src/memory/types.ts`)**

```typescript
// Add to MemorySearchManager interface:
traceReasoningChain?(params: {
  factId: string;
  collection: string;
  options?: ReasoningChainOptions;
}): Promise<ReasoningChain>;

scanNovelty?(params?: NoveltyOptions): Promise<NoveltyReport>;
```

**Step B: Add wrapper methods to MongoDBMemoryManager (`src/memory/mongodb-manager.ts`)**

Follow the exact pattern of `hydrateActiveSlate()` at line 2339:

```typescript
// Import at top of file:
import { traceReasoningChain } from "./mongodb-reasoning-chain.js";
import { scanNovelty } from "./mongodb-novelty.js";

// Add methods to the class:
async traceReasoningChain(params: {
  factId: string;
  collection: string;
  options?: ReasoningChainOptions;
}): Promise<ReasoningChain> {
  return traceReasoningChain({
    db: this.db,
    prefix: this.prefix,
    agentId: this.agentId,
    factId: params.factId,
    collection: params.collection,
    options: params.options,
  });
}

async scanNovelty(params?: NoveltyOptions): Promise<NoveltyReport> {
  return scanNovelty({
    db: this.db,
    prefix: this.prefix,
    agentId: this.agentId,
    options: params,
  });
}
```

**Step C: Tools call via `memory.manager.traceReasoningChain(...)` and `memory.manager.scanNovelty(...)`**

This is the same pattern used by `memory_active_slate`, `memory_discovery_projection`, and `memory_context_bundle`.

### Tool Registration

**`memory_reasoning_chain` tool:**

Follow the exact pattern from `createMemoryActiveSlateTool()` at `memory-tool.ts:660-694`.

```typescript
const MemoryReasoningChainSchema = Type.Object({
  fact_id: Type.String({
    description: "The ID of the fact to trace (e.g., structured memory key, entity ID)",
  }),
  collection: Type.String({
    description: "Source collection: structured_mem, entities, relations, procedures, entity_links",
  }),
  max_depth: Type.Optional(Type.Number({ description: "Maximum traversal depth (default 10)" })),
});

export function createMemoryReasoningChainTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Reasoning Chain",
    name: "memory_reasoning_chain",
    description:
      "Trace the provenance of any stored fact back to the original conversation events that produced it. Returns an ordered chain from root cause to derived fact. Use when you need to understand WHY a memory exists or verify its source.",
    parameters: MemoryReasoningChainSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const factId = readStringParam(params, "factId", { required: true });
        const collection = readStringParam(params, "collection", { required: true });
        const maxDepth = readNumberParam(params, "maxDepth", { integer: true });
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ nodes: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.traceReasoningChain) {
          return jsonResult({
            nodes: [],
            disabled: true,
            error: "reasoning chain is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(
            await memory.manager.traceReasoningChain({
              factId,
              collection,
              options: maxDepth !== undefined ? { maxDepth } : undefined,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ nodes: [], disabled: true, error: message });
        }
      },
  });
}
```

**`memory_novelty_scan` tool:**

```typescript
const MemoryNoveltyScanSchema = Type.Object({
  limit: Type.Optional(
    Type.Number({ description: "Number of most novel events to return (default 10)" }),
  ),
  scope: Type.Optional(Type.String({ description: "Memory scope filter" })),
});

export function createMemoryNoveltyScanTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Novelty Scan",
    name: "memory_novelty_scan",
    description:
      "Find the most novel and surprising observations stored in memory. Returns events ranked by how unusual they are compared to everything else stored. Use when looking for anomalies, new patterns, or unexpected information.",
    parameters: MemoryNoveltyScanSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const limit = readNumberParam(params, "limit", { integer: true });
        const scope = readMemoryScopeParam(params, "scope");
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ events: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.scanNovelty) {
          return jsonResult({
            events: [],
            disabled: true,
            error: "novelty scan is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(
            await memory.manager.scanNovelty({
              ...(limit !== undefined ? { limit } : {}),
              ...(scope ? { scope } : {}),
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ events: [], disabled: true, error: message });
        }
      },
  });
}
```

**IMPORTANT:** The tool execute functions call `getMemoryManagerContext()` which returns the manager. The new tools call `memory.manager.traceReasoningChain(...)` and `memory.manager.scanNovelty(...)` — these wrapper methods were added in the Manager Wiring step above. This is the same pattern used by `memory_active_slate`, `memory_discovery_projection`, and `memory_context_bundle`.

### Validation Checklist

Run in order:

```bash
# 1. Type check
pnpm build

# 2. Lint/format
pnpm check

# 3. Unit tests for all new modules
pnpm test src/memory/mongodb-reasoning-chain.test.ts
pnpm test src/memory/mongodb-novelty.test.ts
pnpm test src/memory/mongodb-access-tracker.test.ts
pnpm test src/memory/mongodb-consolidator.test.ts
pnpm test src/memory/mongodb-result-trust.test.ts

# 4. Full memory test suite (should pass with pre-existing failures only)
pnpm test -- --reporter=verbose 2>&1 | tail -20

# 5. E2E tests (requires Docker MongoDB)
MONGODB_TEST_URI='mongodb://localhost:27018/?directConnection=true' pnpm test -- src/memory/mongodb-e2e.e2e.test.ts --reporter=verbose
```

### Final Baseline Verification

| Check                                 | Expected                                        |
| ------------------------------------- | ----------------------------------------------- |
| `EXPECTED_COLLECTION_SUFFIXES.length` | 25                                              |
| `EXPECTED_STANDARD_INDEX_COUNT`       | 70                                              |
| mongodb-\*.ts file count              | 86 (was 83)                                     |
| New tools registered                  | `memory_reasoning_chain`, `memory_novelty_scan` |
| All 33 invariants                     | PASS                                            |
| `pnpm build`                          | exit 0                                          |
| `pnpm check`                          | exit 0 (or pre-existing only)                   |

### Steps

1. Add tool schemas and creators to `memory-tool.ts`
2. Wire tool creators into the tool registration list (find where `createMemoryActiveSlateTool` is called and add new tools adjacent)
3. Run full validation checklist
4. Update any baselines that drifted
5. Commit all Phase 7 changes
6. `git push origin main`
7. npm publish (user action)

### Required checks:

- Full validation checklist above
- Invariant 33 verified
- All 7 phase commits clean

### Exit criteria:

- 2 new tools registered and functional
- All baselines match expected values
- Full test suite passes (pre-existing failures only)
- Build passes
- Ready for npm publish

### Checkpoint: HITL — user must approve:

- `git push origin main`
- `npm publish`

---

## Phase Dependency Map

```
Phase 0 (commit/push) → Phase 1 (reasoning chain)
Phase 1 → Phase 2 (novelty) [novelty uses events, same collection]
Phase 2 → Phase 3 (importance/access/schema) [schema changes after modules validated]
Phase 3 → Phase 4 (importance decay) [decay uses Phase 3 fields]
Phase 4 → Phase 5 (wiki categorization) [independent but sequential for safety]
Phase 5 → Phase 6 (consolidator) [uses Phases 1-4]
Phase 6 → Phase 7 (tools/validation) [register tools, final gate]
```

---

## Phase Autonomy Classification

| Phase | Checkpoint Type | Classification | Reason                                    |
| ----- | --------------- | -------------- | ----------------------------------------- |
| 0     | human_action    | HITL           | Commit/push requires user approval        |
| 1     | none            | AFK            | Pure new module, no decisions needed      |
| 2     | none            | AFK            | Pure new module with graceful degradation |
| 3     | none            | AFK            | Schema + module, patterns are established |
| 4     | none            | AFK            | Pure function addition, 30 LOC            |
| 5     | none            | AFK            | Schema field additions only               |
| 6     | none            | AFK            | Largest phase but patterns established    |
| 7     | human_action    | HITL           | Push + publish require user approval      |

---

## Risks and Mitigations

| Risk                                                                                 | Dimension | P   | I   | Score | Mitigation                                                                                                                          |
| ------------------------------------------------------------------------------------ | --------- | --- | --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `$graphLookup` on sourceEventIds in Phase 1 — events don't have sourceEventIds field | Technical | 2   | 4   | 8     | Design corrected: use `$lookup` not `$graphLookup` for event hop. Events are leaf nodes.                                            |
| Atlas Vector Search unavailable for novelty scan                                     | Technical | 3   | 3   | 9     | Graceful degradation: return empty report with error string, never crash                                                            |
| AccessTracker timer leak in tests                                                    | Quality   | 3   | 2   | 6     | `close()` method clears timer; test afterEach calls close()                                                                         |
| Consolidation pattern matching false positives                                       | Quality   | 2   | 3   | 6     | Conservative patterns only. False negatives acceptable, false positives not.                                                        |
| Schema validation rejects existing documents after field additions                   | Technical | 1   | 5   | 5     | All new fields are optional with no `required` constraint. validationLevel: "moderate" skips existing docs.                         |
| Index count drift from upstream sync                                                 | Timeline  | 2   | 2   | 4     | Baselines explicitly tracked in e2e test constants                                                                                  |
| Importance decay changes reranker behavior for existing queries                      | Quality   | 2   | 3   | 6     | Default importanceWeight=0.10 is small additive effect. Existing behavior preserved when importance field absent (defaults to 0.5). |

---

## Acceptance Checks

- [ ] `traceReasoningChain()` returns ordered chain for multi-hop provenance
- [ ] `scanNovelty()` degrades gracefully when mongot unavailable
- [ ] `AccessTracker` uses batched writes (approximation pattern verified)
- [ ] `computeImportanceDecay()` matches formula: `importance * 0.5^(days/halfLife)`
- [ ] KB entries accept `wikiSource`, `vault`, `section` fields
- [ ] `consolidateMemory()` promotes facts and marks events consolidated
- [ ] `memory_reasoning_chain` tool registered and callable
- [ ] `memory_novelty_scan` tool registered and callable
- [ ] `EXPECTED_COLLECTION_SUFFIXES` = 25
- [ ] `EXPECTED_STANDARD_INDEX_COUNT` = 70
- [ ] `pnpm build` exit 0
- [ ] `pnpm check` exit 0 (or pre-existing only)
- [ ] All 33 invariants PASS
- [ ] ~35-45 new unit tests PASS
- [ ] Honcho steal score: 10/10

---

## SKILL HINTS (MANDATORY for all sub-agents)

```
SKILL HINTS (MANDATORY for all sub-agents):
- DO NOT USE mongodb-agent-skills
- For MongoDB best practices: use `mcp__mongodb__search-knowledge` MCP tool
- For web validation: use Bright Data MCP (`mcp__brightdata__scrape_as_markdown`, `mcp__brightdata__search_engine`)
- MongoDB skill references at: /Users/rom.iluz/.claude/skills/mongodb-schema-design/references/
- CC10x skills: architecture-patterns, code-review-patterns, test-driven-development, verification-before-completion
- Honcho reference repo: /Users/rom.iluz/Dev/memory-referance/honcho
- Key gotchas from patterns.md:
  - $graphLookup does recursive self-joins on SINGLE collection; cross-collection needs $lookup chains
  - restrictSearchWithMatch is ESSENTIAL for multi-tenant agentId isolation
  - Entity hydration after $graphLookup must include agentId in find filter
  - Empty-string regex guard: always check !query.trim() before $regex
  - Summarizer/LLM output validation: always validate shape before persisting
  - Idempotent upsert: $setOnInsert for creation-time fields, $set for mutable
  - Events do NOT have sourceEventIds — derived objects (structured_mem, entities, relations, procedures, entity_links) have them
  - Phase 1 reasoning chain uses $lookup (not $graphLookup) because events are leaf nodes
  - AccessTracker must use approximation pattern (batched writes) — NEVER per-request $inc
  - Atlas Vector Search may be unavailable: always wrap in try/catch, return degraded result
  - consolidation_runs is the ONLY new collection — total 25
  - All new schema fields are OPTIONAL — no breaking changes to existing documents
  - Standalone function pattern: (db, prefix, agentId, ...) — NOT class methods
  - Importance decay computed at QUERY TIME, not storage time
  - GAP REVIEW FIX: markEventsConsolidated() requires episodeId — use new markEventsDreamerProcessed() instead
  - GAP REVIEW FIX: KB has no agentId field — KB wiki index uses docId, not agentId
  - GAP REVIEW FIX: runtime-tools.ts MUST import+re-export new tool creators for runtime availability
  - dreamerProcessedAt field distinguishes Dreamer processing from episode consolidation (consolidatedAt)
```
