# ClawMongo Memory v2 Enhancements Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** See `docs/plans/2026-03-15-memory-architecture-v2-design.md` for v2 base design.
> **v2 Plan:** See `docs/plans/2026-03-15-memory-architecture-v2-plan.md` for original v2 implementation plan.

**Goal:** Implement 5 memory architecture improvements and 1 bug fix to bring ClawMongo v2 from C+/B- to A- on all memory capabilities. All improvements are research-validated by 3 parallel research agents (Reddit user pain analysis, production architecture comparison, code-level safety audit).

**Architecture:** All changes are additive to the existing v2 codebase. No breaking changes. No new npm dependencies. All new functions follow the standalone `(db, prefix, agentId, ...)` pattern. All new functions are exported from `src/memory/index.ts`. Rollback-safe: every feature can be disabled without data loss.

**Tech Stack:** TypeScript ESM, MongoDB Community + mongot, Vitest, `$graphLookup`, `$facet`, JSON Schema validation (moderate level).

**Prerequisites:**

- v2 build complete (all 10 phases pass, 205 unit tests, 6 e2e scenarios)
- Working MongoDB 8.2+ instance for e2e tests
- Existing codebase patterns understood (see Context References below)

---

## Relevant Codebase Files

### Patterns to Follow

- `src/memory/mongodb-schema.ts:32-34` - `col()` helper, collection accessors
- `src/memory/mongodb-schema.ts:263-280` - EVENTS_SCHEMA JSON Schema validator
- `src/memory/mongodb-schema.ts:322-357` - EPISODES_SCHEMA JSON Schema validator (bug location)
- `src/memory/mongodb-schema.ts:500-782` - `ensureStandardIndexes()` index creation + sparse pattern
- `src/memory/mongodb-events.ts:30-59` - `writeEvent()` upsert pattern
- `src/memory/mongodb-events.ts:109-123` - `getUnprojectedEvents()` filter pattern (model for getUnconsolidatedEvents)
- `src/memory/mongodb-graph.ts:68-109` - `upsertEntity()` upsert with `$set/$setOnInsert`
- `src/memory/mongodb-graph.ts:237-346` - `expandGraph()` with `$graphLookup` + dedup by key
- `src/memory/mongodb-episodes.ts:47-148` - `materializeEpisode()` summarizer injection pattern
- `src/memory/mongodb-manager.ts:93-109` - `deduplicateSearchResults()` used at line 1696
- `src/memory/mongodb-manager.ts:1590-1706` - `searchV2()` pipeline (reranker insertion point at line 1696)
- `src/memory/mongodb-retrieval-planner.ts` - pure function pattern, keyword heuristic scoring
- `src/memory/index.ts` - barrel exports (35 v2 symbols currently)
- `src/memory/types.ts:5-15` - `MemorySearchResult` type (no timestamp field currently)
- `src/config/types.memory.ts:8` - `MemoryScope` type

### Test Patterns

- `src/memory/mongodb-events.test.ts` - event module test pattern (mock Db/Collection)
- `src/memory/mongodb-graph.test.ts` - graph module test pattern
- `src/memory/mongodb-episodes.test.ts` - episodes module test pattern with mock summarizer
- `src/memory/mongodb-manager.test.ts` - manager test pattern (mock imports)
- `src/memory/mongodb-retrieval-planner.test.ts` - pure function test pattern

### Existing Constants

- `EXPECTED_COLLECTION_SUFFIXES = 16` in e2e tests (no change needed -- no new collections)
- `EXPECTED_STANDARD_INDEX_COUNT = 43` in e2e tests (will become 44 with new sparse index)

---

## Dependency Graph

```
Phase 0 (bug fix) -----> Phase 5 (auto episodes requires fixed enum)
Phase 1 (consolidation) --> Phase 5 (auto episodes uses getUnconsolidatedEvents + markEventsConsolidated)
Phase 2 (bi-directional graph) -- independent
Phase 3 (heuristic reranking) -- independent
Phase 4 (entity extraction) -- independent
```

Build order: Phase 0 -> Phase 1 -> (Phases 2, 3, 4 in parallel) -> Phase 5

---

## Phase 0: Fix EPISODES_SCHEMA Enum Bug (~5 LOC)

> **Exit Criteria:** EPISODES_SCHEMA enum includes all 5 EpisodeType values. Existing tests pass. Schema validation accepts "weekly" and "decision" episode types.

### Task 0.1: Fix EPISODES_SCHEMA enum

**Files:**

- Modify: `src/memory/mongodb-schema.ts:338`
- Test: `src/memory/mongodb-schema.test.ts` (add test for enum completeness)

**Step 1: Write failing test**

Add test in `src/memory/mongodb-schema.test.ts` that verifies EPISODES_SCHEMA enum includes all EpisodeType values:

```typescript
it("EPISODES_SCHEMA enum includes all EpisodeType values", () => {
  // The EpisodeType union: "daily" | "weekly" | "thread" | "topic" | "decision"
  const expectedTypes = ["daily", "weekly", "thread", "topic", "decision"];
  // Access the enum from the schema validator
  // EPISODES_SCHEMA is not directly exported, but we can verify via ensureCollections
  // or by checking the schema constant indirectly.
  // Since EPISODES_SCHEMA is internal, test via attempting to validate a doc with each type.
});
```

Note: Since EPISODES_SCHEMA is a module-level const (not exported), the most robust test approach is to add an exported helper or test through the schema validation path. The builder should verify by checking the enum array directly in the source.

**Step 2: Fix the enum**

In `src/memory/mongodb-schema.ts`, line 338, change:

```typescript
// BEFORE:
type: { enum: ["daily", "thread", "topic"], description: "Episode type" },

// AFTER:
type: { enum: ["daily", "weekly", "thread", "topic", "decision"], description: "Episode type" },
```

**Step 3: Run tests to verify no regressions**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-schema.test.ts`
Expected: All existing 48 schema tests pass + new test passes.

**Step 4: Commit**

```bash
scripts/committer "fix: add missing 'weekly' and 'decision' to EPISODES_SCHEMA enum" src/memory/mongodb-schema.ts src/memory/mongodb-schema.test.ts
```

---

## Phase 1: Memory Consolidation Lifecycle (~60 LOC)

> **Exit Criteria:** Events can be marked as consolidated into an episode. `getUnconsolidatedEvents()` returns only events without `consolidatedAt`. Sparse index on `consolidatedAt` exists. All tests pass.

### Task 1.1: Add consolidation fields to EVENTS_SCHEMA

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (EVENTS_SCHEMA properties, ensureStandardIndexes)

**Step 1: Add schema properties**

In `src/memory/mongodb-schema.ts`, add two properties to the EVENTS_SCHEMA `properties` object (after the existing `projectedAt` property at approximately line 277):

```typescript
consolidatedAt: { bsonType: "date", description: "When this event was consolidated into an episode" },
consolidatedIntoEpisodeId: { bsonType: "string", description: "Episode ID this event was consolidated into" },
```

These are NOT in the `required` array, so existing documents remain valid under `validationLevel: "moderate"`.

**Step 2: Add sparse index on consolidatedAt**

In `ensureStandardIndexes()`, after the existing events indexes block (after line 724):

```typescript
await events.createIndex({ consolidatedAt: 1 }, { name: "idx_events_consolidated", sparse: true });
applied++;
```

This brings `EXPECTED_STANDARD_INDEX_COUNT` from 43 to 44. Update the e2e test constant.

**Step 3: Update CanonicalEvent type**

In `src/memory/mongodb-events.ts`, add optional fields to the `CanonicalEvent` type:

```typescript
consolidatedAt?: Date;
consolidatedIntoEpisodeId?: string;
```

**Step 4: Run schema tests**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-schema.test.ts`
Expected: All pass. No regressions.

**Step 5: Commit**

```bash
scripts/committer "feat: add consolidation fields to EVENTS_SCHEMA and CanonicalEvent type" src/memory/mongodb-schema.ts src/memory/mongodb-events.ts
```

### Task 1.2: Implement markEventsConsolidated and getUnconsolidatedEvents

**Files:**

- Modify: `src/memory/mongodb-events.ts` (add 2 new functions)
- Create: tests in `src/memory/mongodb-events.test.ts` (add new describe block)

**Step 1: Write failing tests**

Add to `src/memory/mongodb-events.test.ts`:

```typescript
describe("markEventsConsolidated", () => {
  it("marks events with consolidatedAt and episodeId", async () => {
    // mock updateMany to verify the correct filter and $set
    const mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 3 });
    // ... setup mock collection
    const result = await markEventsConsolidated({
      db: mockDb,
      prefix: "test_",
      eventIds: ["e1", "e2", "e3"],
      episodeId: "ep-123",
    });
    expect(result).toBe(3);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { eventId: { $in: ["e1", "e2", "e3"] } },
      { $set: { consolidatedAt: expect.any(Date), consolidatedIntoEpisodeId: "ep-123" } },
    );
  });

  it("returns 0 for empty eventIds array", async () => {
    const result = await markEventsConsolidated({
      db: mockDb,
      prefix: "test_",
      eventIds: [],
      episodeId: "ep-123",
    });
    expect(result).toBe(0);
  });
});

describe("getUnconsolidatedEvents", () => {
  it("returns events without consolidatedAt field", async () => {
    // mock find to verify filter includes { consolidatedAt: { $exists: false } }
    // ... setup mock
    const events = await getUnconsolidatedEvents({
      db: mockDb,
      prefix: "test_",
      agentId: "agent-1",
    });
    expect(mockFind).toHaveBeenCalledWith({
      agentId: "agent-1",
      consolidatedAt: { $exists: false },
    });
  });

  it("applies optional scope filter", async () => {
    await getUnconsolidatedEvents({
      db: mockDb,
      prefix: "test_",
      agentId: "agent-1",
      scope: "session",
    });
    expect(mockFind).toHaveBeenCalledWith({
      agentId: "agent-1",
      consolidatedAt: { $exists: false },
      scope: "session",
    });
  });

  it("applies optional limit", async () => {
    await getUnconsolidatedEvents({
      db: mockDb,
      prefix: "test_",
      agentId: "agent-1",
      limit: 10,
    });
    expect(mockLimit).toHaveBeenCalledWith(10);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-events.test.ts`
Expected: FAIL (functions not yet implemented)

**Step 3: Implement markEventsConsolidated**

In `src/memory/mongodb-events.ts`, add after `markEventsProjected` (after line 144):

```typescript
/**
 * Mark events as consolidated into an episode.
 * Sets consolidatedAt timestamp and consolidatedIntoEpisodeId.
 * Returns the count of modified events.
 */
export async function markEventsConsolidated(params: {
  db: Db;
  prefix: string;
  eventIds: string[];
  episodeId: string;
}): Promise<number> {
  const { db, prefix, eventIds, episodeId } = params;
  if (eventIds.length === 0) {
    return 0;
  }
  const collection = eventsCollection(db, prefix);
  const result = await collection.updateMany(
    { eventId: { $in: eventIds } },
    { $set: { consolidatedAt: new Date(), consolidatedIntoEpisodeId: episodeId } },
  );
  log.info(`marked ${result.modifiedCount} events consolidated into episode=${episodeId}`);
  return result.modifiedCount;
}
```

**Step 4: Implement getUnconsolidatedEvents**

In `src/memory/mongodb-events.ts`, add after `markEventsConsolidated`:

```typescript
/**
 * Get events that have NOT been consolidated into any episode.
 * Uses the sparse index on consolidatedAt for efficient queries.
 */
export async function getUnconsolidatedEvents(params: {
  db: Db;
  prefix: string;
  agentId: string;
  scope?: MemoryScope;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, scope, limit } = params;
  const collection = eventsCollection(db, prefix);
  const filter: Document = {
    agentId,
    consolidatedAt: { $exists: false },
  };
  if (scope) {
    filter.scope = scope;
  }

  return (
    (await collection
      .find(filter)
      // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
      .sort({ timestamp: 1 })
      .limit(limit ?? 500)
      .toArray()) as unknown as CanonicalEvent[]
  );
}
```

**Step 5: Export from barrel**

In `src/memory/index.ts`, add to the mongodb-events.js export block:

```typescript
markEventsConsolidated,
getUnconsolidatedEvents,
```

**Step 6: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-events.test.ts`
Expected: All pass.

**Step 7: Update e2e test constant**

In `src/memory/mongodb-e2e.e2e.test.ts`, update `EXPECTED_STANDARD_INDEX_COUNT` from 43 to 44.

**Step 8: Commit**

```bash
scripts/committer "feat: add memory consolidation lifecycle (markEventsConsolidated, getUnconsolidatedEvents)" src/memory/mongodb-events.ts src/memory/mongodb-events.test.ts src/memory/index.ts src/memory/mongodb-e2e.e2e.test.ts
```

---

## Phase 2: Bi-directional $graphLookup (~50 LOC)

> **Exit Criteria:** `expandGraph()` supports optional `bidirectional` param (default `false`, backward compatible). When `bidirectional=true`, uses `$facet` for parallel forward+reverse traversal in a single aggregation. `maxConnections` limit prevents hub entity explosion. Existing tests still pass.

### Task 2.1: Add bidirectional and maxConnections params to expandGraph

**Files:**

- Modify: `src/memory/mongodb-graph.ts` (expandGraph function)
- Modify: `src/memory/mongodb-graph.test.ts` (add tests)

**Step 1: Write failing tests**

Add to `src/memory/mongodb-graph.test.ts`:

```typescript
describe("expandGraph bidirectional", () => {
  it("backward compatible: bidirectional defaults to false", async () => {
    // Call expandGraph without bidirectional param
    // Verify it uses the existing outbound-only pipeline (no $facet)
    const result = await expandGraph({
      db: mockDb,
      prefix: "test_",
      entityId: "e1",
      agentId: "a1",
    });
    // Verify aggregate was called without $facet
    expect(mockAggregate).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ $facet: expect.anything() })]),
    );
  });

  it("bidirectional=true uses $facet for parallel traversal", async () => {
    const result = await expandGraph({
      db: mockDb,
      prefix: "test_",
      entityId: "e1",
      agentId: "a1",
      bidirectional: true,
    });
    // Verify $facet stage is present
    expect(mockAggregate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ $facet: expect.anything() })]),
    );
  });

  it("maxConnections limits total connections returned", async () => {
    // Setup mock to return many connections
    const result = await expandGraph({
      db: mockDb,
      prefix: "test_",
      entityId: "e1",
      agentId: "a1",
      bidirectional: true,
      maxConnections: 5,
    });
    expect(result?.connections.length).toBeLessThanOrEqual(5);
  });

  it("deduplicates connections from forward and reverse traversal", async () => {
    // Setup mock where same relation appears in both directions
    // Verify dedup by existing key pattern: `${fromEntityId}:${toEntityId}:${type}`
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-graph.test.ts`
Expected: FAIL (new params not yet supported)

**Step 3: Modify expandGraph signature**

Add `bidirectional?: boolean` and `maxConnections?: number` to the params type:

```typescript
export async function expandGraph(params: {
  db: Db;
  prefix: string;
  entityId: string;
  agentId: string;
  maxDepth?: number;
  bidirectional?: boolean;    // NEW: default false
  maxConnections?: number;    // NEW: default 100
}): Promise<GraphExpansionResult | null> {
```

**Step 4: Implement bidirectional $facet pipeline**

When `bidirectional=true`, replace the current single `$graphLookup` with a `$facet` stage that runs forward and reverse traversals in parallel within a single aggregation:

```typescript
if (bidirectional) {
  // Use $facet for parallel forward + reverse traversal in one aggregation
  const facetPipeline: Document[] = [
    {
      $facet: {
        forward: [
          { $match: { fromEntityId: entityId, agentId } },
          {
            $graphLookup: {
              from: `${prefix}relations`,
              startWith: "$toEntityId",
              connectFromField: "toEntityId",
              connectToField: "fromEntityId",
              as: "transitiveRelations",
              maxDepth: Math.max(0, (maxDepth ?? 2) - 1),
              depthField: "depth",
              restrictSearchWithMatch: { agentId },
            },
          },
        ],
        reverse: [
          { $match: { toEntityId: entityId, agentId } },
          {
            $graphLookup: {
              from: `${prefix}relations`,
              startWith: "$fromEntityId",
              connectFromField: "fromEntityId",
              connectToField: "toEntityId",
              as: "transitiveRelations",
              maxDepth: Math.max(0, (maxDepth ?? 2) - 1),
              depthField: "depth",
              restrictSearchWithMatch: { agentId },
            },
          },
        ],
      },
    },
  ];

  const [facetResult] = await relCol.aggregate(facetPipeline).toArray();
  // Merge forward and reverse results, dedup by key
  const forwardRels = (facetResult?.forward ?? []) as Document[];
  const reverseRels = (facetResult?.reverse ?? []) as Document[];
  // ... process both arrays using existing dedup logic
}
```

The dedup uses the existing key pattern: `${fromEntityId}:${toEntityId}:${type}`.

**Step 5: Apply maxConnections limit**

After building the connections array, apply the limit:

```typescript
const connectionLimit = maxConnections ?? 100;
const limitedConnections = connections.slice(0, connectionLimit);
if (connections.length > connectionLimit) {
  log.warn(
    `expandGraph: truncated ${connections.length} connections to maxConnections=${connectionLimit} for entity=${entityId}`,
  );
}
return { rootEntity, connections: limitedConnections };
```

**Step 6: Ensure backward compatibility**

When `bidirectional` is `false` or `undefined`, the existing pipeline runs unchanged. The `maxConnections` limit applies regardless of direction.

**Step 7: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-graph.test.ts`
Expected: All pass (existing 10 tests + new tests).

**Step 8: Commit**

```bash
scripts/committer "feat: add bidirectional $graphLookup with $facet and maxConnections limit" src/memory/mongodb-graph.ts src/memory/mongodb-graph.test.ts
```

---

## Phase 3: Heuristic Reranking (~80 LOC)

> **Exit Criteria:** New pure function `rerankResults()` applies source diversity penalty and episode priority boost. Inserted into `searchV2()` between dedup and slice. Configurable weights. All tests pass.

### Task 3.1: Implement rerankResults pure function

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (add rerankResults function + integrate into searchV2)
- Modify: `src/memory/mongodb-manager.test.ts` (add tests)
- Modify: `src/memory/index.ts` (export rerankResults)

**Step 1: Write failing tests**

Add to `src/memory/mongodb-manager.test.ts`:

```typescript
describe("rerankResults", () => {
  const makeResult = (
    path: string,
    snippet: string,
    score: number,
    source: MemorySearchResult["source"],
  ): MemorySearchResult => ({
    path,
    filePath: path,
    startLine: 0,
    endLine: 0,
    snippet,
    score,
    source,
  });

  it("returns empty array for empty input", () => {
    const result = rerankResults([], "query");
    expect(result).toHaveLength(0);
  });

  it("applies source diversity penalty (no >2 from same source at top)", () => {
    const results = [
      makeResult("event:1", "text1", 0.95, "conversation"),
      makeResult("event:2", "text2", 0.9, "conversation"),
      makeResult("event:3", "text3", 0.85, "conversation"),
      makeResult("struct:1", "text4", 0.8, "structured"),
    ];
    const reranked = rerankResults(results, "query");
    // The 3rd conversation result should be penalized below structured
    const top3Sources = reranked.slice(0, 3).map((r) => r.source);
    expect(top3Sources).toContain("structured");
  });

  it("boosts episode results", () => {
    const results = [
      makeResult("event:1", "text1", 0.9, "conversation"),
      makeResult("episode:ep1", "Episode: summary", 0.8, "conversation"),
    ];
    const reranked = rerankResults(results, "query");
    // Episode should be boosted above the event
    expect(reranked[0].path).toBe("episode:ep1");
  });

  it("respects custom weights", () => {
    const results = [
      makeResult("event:1", "text1", 0.9, "conversation"),
      makeResult("episode:ep1", "text2", 0.8, "conversation"),
    ];
    // With zero episode boost, original order preserved
    const reranked = rerankResults(results, "query", { episodeBoost: 0 });
    expect(reranked[0].path).toBe("event:1");
  });

  it("does not mutate original array", () => {
    const results = [
      makeResult("event:1", "text1", 0.9, "conversation"),
      makeResult("event:2", "text2", 0.85, "conversation"),
    ];
    const originalOrder = [...results.map((r) => r.path)];
    rerankResults(results, "query");
    expect(results.map((r) => r.path)).toEqual(originalOrder);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-manager.test.ts`
Expected: FAIL (rerankResults not defined)

**Step 3: Implement rerankResults**

In `src/memory/mongodb-manager.ts`, add the pure function:

```typescript
/**
 * Heuristic reranker for v2 search results.
 * Phase 1 scoring:
 * - Source diversity penalty: no more than 2 results from the same source at the top
 * - Episode priority boost: episode results get a score boost
 *
 * Recency boost deferred (needs timestamp in MemorySearchResult interface).
 */
export type RerankWeights = {
  diversityWeight?: number; // Penalty per excess result from same source (default 0.15)
  episodeBoost?: number; // Bonus for episode results (default 0.12)
};

export function rerankResults(
  results: MemorySearchResult[],
  _query: string,
  weights?: RerankWeights,
): MemorySearchResult[] {
  if (results.length === 0) {
    return [];
  }

  const diversityWeight = weights?.diversityWeight ?? 0.15;
  const episodeBoost = weights?.episodeBoost ?? 0.12;

  // Score each result
  const scored = results.map((r) => ({
    result: r,
    adjustedScore: r.score,
  }));

  // 1. Episode priority boost
  for (const entry of scored) {
    if (entry.result.path.startsWith("episode:")) {
      entry.adjustedScore += episodeBoost;
    }
  }

  // 2. Sort by adjusted score descending
  scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // 3. Source diversity penalty: penalize 3rd+ result from same source
  const sourceCounts = new Map<string, number>();
  for (const entry of scored) {
    const source = entry.result.source;
    const count = (sourceCounts.get(source) ?? 0) + 1;
    sourceCounts.set(source, count);
    if (count > 2) {
      entry.adjustedScore -= diversityWeight * (count - 2);
    }
  }

  // 4. Re-sort after diversity penalty
  scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

  return scored.map((s) => s.result);
}
```

**Step 4: Integrate into searchV2**

In `src/memory/mongodb-manager.ts`, at line 1696, change:

```typescript
// BEFORE (line 1696):
const deduped = deduplicateSearchResults(results).slice(0, maxResults);

// AFTER:
const deduped = deduplicateSearchResults(results);
const reranked = rerankResults(deduped, query);
const finalResults = reranked.slice(0, maxResults);
```

And update the return to use `finalResults`:

```typescript
return {
  results: finalResults,
  metadata: { plan, pathsExecuted, resultsByPath },
};
```

**Step 5: Export from barrel**

In `src/memory/index.ts`, add to exports:

```typescript
export { rerankResults, type RerankWeights } from "./mongodb-manager.js";
```

**Step 6: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-manager.test.ts`
Expected: All pass (existing 33 tests + new tests).

**Step 7: Commit**

```bash
scripts/committer "feat: add heuristic reranker with source diversity and episode boost" src/memory/mongodb-manager.ts src/memory/mongodb-manager.test.ts src/memory/index.ts
```

---

## Phase 4: Rule-based Entity Extraction (~150 LOC)

> **Exit Criteria:** `extractAndUpsertEntities()` extracts @mentions, #tags, URLs, file paths, and "quoted names" from event content. Deterministic entityIds via hash. Uses existing `upsertEntity/upsertRelation`. Fire-and-forget pattern (caller decides whether to await). All tests pass.

### Task 4.1: Implement extractAndUpsertEntities

**Files:**

- Modify: `src/memory/mongodb-graph.ts` (add extractAndUpsertEntities function + STOP_WORDS constant)
- Modify: `src/memory/mongodb-graph.test.ts` (add tests)
- Modify: `src/memory/index.ts` (export)

**Step 1: Write failing tests**

Add to `src/memory/mongodb-graph.test.ts`:

```typescript
describe("extractAndUpsertEntities", () => {
  it("extracts @mentions as person entities", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "Talked to @alice about the project",
      scope: "agent",
    });
    expect(result.entities).toContainEqual(
      expect.objectContaining({ name: "alice", type: "person" }),
    );
  });

  it("extracts #tags as topic entities", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "Working on #frontend #refactor today",
      scope: "agent",
    });
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].type).toBe("topic");
  });

  it("extracts URLs as document entities", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "See https://example.com/docs for details",
      scope: "agent",
    });
    expect(result.entities).toContainEqual(
      expect.objectContaining({ name: "https://example.com/docs", type: "document" }),
    );
  });

  it("extracts file paths as document entities", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "Modified src/memory/mongodb-graph.ts",
      scope: "agent",
    });
    expect(result.entities).toContainEqual(
      expect.objectContaining({ name: "src/memory/mongodb-graph.ts", type: "document" }),
    );
  });

  it("extracts 'quoted names' as person entities (min 3 chars)", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: 'Meeting with "John Smith" about the design',
      scope: "agent",
    });
    expect(result.entities).toContainEqual(
      expect.objectContaining({ name: "John Smith", type: "person" }),
    );
  });

  it("filters out stop words and short names", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: '"the" and "is" are not names. @me is too short',
      scope: "agent",
    });
    expect(result.entities).toHaveLength(0);
  });

  it("generates deterministic entityIds via hash", async () => {
    const result1 = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "Talked to @alice",
      scope: "agent",
    });
    const result2 = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "Met @alice again",
      scope: "agent",
    });
    // Same @alice -> same entityId
    const id1 = result1.entities.find((e) => e.name === "alice")?.entityId;
    const id2 = result2.entities.find((e) => e.name === "alice")?.entityId;
    expect(id1).toBe(id2);
  });

  it("returns empty result for content with no extractable entities", async () => {
    const result = await extractAndUpsertEntities({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      eventContent: "Just a plain message with no entities",
      scope: "agent",
    });
    expect(result.entities).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-graph.test.ts`
Expected: FAIL (function not defined)

**Step 3: Implement the function**

In `src/memory/mongodb-graph.ts`, add:

```typescript
import { createHash } from "node:crypto";

// Stop words for quoted name filtering
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "must",
  "need",
  "not",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "him",
  "her",
  "they",
  "them",
  "their",
]);

// Regex patterns for structural entity extraction
const MENTION_REGEX = /@(\w{3,})/g;
const TAG_REGEX = /#(\w{3,})/g;
const URL_REGEX = /https?:\/\/[^\s)]+/g;
const FILE_PATH_REGEX = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
const QUOTED_NAME_REGEX = /"([^"]{3,})"/g;

function makeEntityId(name: string, type: string): string {
  return createHash("sha256").update(`${name.toLowerCase()}:${type}`).digest("hex").slice(0, 16);
}

type ExtractedEntity = { entityId: string; name: string; type: EntityType };

/**
 * Extract structural entities from event content and upsert them.
 * Regex patterns: @mentions->person, #tags->topic, URLs->document,
 * file paths->document, "quoted names"->person.
 *
 * Deterministic entityIds via hash of name.toLowerCase() + type.
 * Fire-and-forget: caller decides whether to await.
 * SEPARATE from writeEvent -- not called automatically.
 */
export async function extractAndUpsertEntities(params: {
  db: Db;
  prefix: string;
  agentId: string;
  eventContent: string;
  scope: MemoryScope;
  sourceEventId?: string;
}): Promise<{ entities: ExtractedEntity[]; relationsCreated: number }> {
  const { db, prefix, agentId, eventContent, scope, sourceEventId } = params;

  const extracted: ExtractedEntity[] = [];
  const seen = new Set<string>(); // dedup by entityId

  // Helper to add an entity (dedup by entityId)
  function addEntity(name: string, type: EntityType): void {
    const entityId = makeEntityId(name, type);
    if (!seen.has(entityId)) {
      seen.add(entityId);
      extracted.push({ entityId, name, type });
    }
  }

  // 1. @mentions -> person
  for (const match of eventContent.matchAll(MENTION_REGEX)) {
    const name = match[1];
    if (name && !STOP_WORDS.has(name.toLowerCase())) {
      addEntity(name, "person");
    }
  }

  // 2. #tags -> topic
  for (const match of eventContent.matchAll(TAG_REGEX)) {
    const name = match[1];
    if (name && !STOP_WORDS.has(name.toLowerCase())) {
      addEntity(name, "topic");
    }
  }

  // 3. URLs -> document
  for (const match of eventContent.matchAll(URL_REGEX)) {
    addEntity(match[0], "document");
  }

  // 4. File paths -> document
  for (const match of eventContent.matchAll(FILE_PATH_REGEX)) {
    const path = match[1];
    if (path) {
      addEntity(path, "document");
    }
  }

  // 5. "Quoted names" -> person (min 3 chars, stop-word filtered)
  for (const match of eventContent.matchAll(QUOTED_NAME_REGEX)) {
    const name = match[1];
    if (name && name.trim().length >= 3 && !STOP_WORDS.has(name.toLowerCase().trim())) {
      addEntity(name.trim(), "person");
    }
  }

  if (extracted.length === 0) {
    return { entities: [], relationsCreated: 0 };
  }

  // Upsert entities
  try {
    for (const entity of extracted) {
      await upsertEntity({
        db,
        prefix,
        entity: {
          entityId: entity.entityId,
          name: entity.name,
          type: entity.type,
          agentId,
          scope,
          updatedAt: new Date(),
          ...(sourceEventId && { sourceEventIds: [sourceEventId] }),
        },
      });
    }

    // Create "mentioned_with" relations between co-occurring entities
    let relationsCreated = 0;
    if (extracted.length >= 2) {
      for (let i = 0; i < extracted.length - 1 && i < 5; i++) {
        for (let j = i + 1; j < extracted.length && j < 6; j++) {
          await upsertRelation({
            db,
            prefix,
            relation: {
              fromEntityId: extracted[i].entityId,
              toEntityId: extracted[j].entityId,
              type: "mentioned_with",
              agentId,
              scope,
              updatedAt: new Date(),
              ...(sourceEventId && { sourceEventIds: [sourceEventId] }),
            },
          });
          relationsCreated++;
        }
      }
    }

    log.info(
      `extracted ${extracted.length} entities and ${relationsCreated} relations from event content for agent=${agentId}`,
    );
    return { entities: extracted, relationsCreated };
  } catch (err) {
    log.error(
      `extractAndUpsertEntities failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
```

**Step 4: Export from barrel**

In `src/memory/index.ts`, add to the mongodb-graph.js export block:

```typescript
extractAndUpsertEntities,
```

**Step 5: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-graph.test.ts`
Expected: All pass (existing 10 tests + new tests).

**Step 6: Commit**

```bash
scripts/committer "feat: add rule-based entity extraction (mentions, tags, URLs, paths, quoted names)" src/memory/mongodb-graph.ts src/memory/mongodb-graph.test.ts src/memory/index.ts
```

---

## Phase 5: Auto Episode Triggers (~150 LOC)

> **Exit Criteria:** `checkAutoEpisodeTriggers()` fires on session gap, event count, or explicit trigger. Async-only (not blocking write path). Rate limited (max 1 per hour per agent, configurable). Uses Phase 1's `getUnconsolidatedEvents()` and `markEventsConsolidated()`. All tests pass.

**DEPENDS ON:** Phase 0 (EPISODES_SCHEMA enum fix) + Phase 1 (consolidation lifecycle)

### Task 5.1: Implement checkAutoEpisodeTriggers

**Files:**

- Modify: `src/memory/mongodb-episodes.ts` (add checkAutoEpisodeTriggers function + rate limiter)
- Modify: `src/memory/mongodb-episodes.test.ts` (add tests)
- Modify: `src/memory/index.ts` (export)

**Step 1: Write failing tests**

Add to `src/memory/mongodb-episodes.test.ts`:

```typescript
describe("checkAutoEpisodeTriggers", () => {
  it("triggers episode on session gap (>30min default)", async () => {
    // Mock getUnconsolidatedEvents to return events with a >30min gap
    // Mock materializeEpisode to return an episode
    // Mock markEventsConsolidated
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("session_gap");
  });

  it("triggers episode on event count (>50 default)", async () => {
    // Mock getUnconsolidatedEvents to return 51+ events with no gap
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("event_count");
  });

  it("does not trigger when under thresholds", async () => {
    // Mock getUnconsolidatedEvents to return 10 events, no gap
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
    });
    expect(result.triggered).toBe(false);
  });

  it("respects rate limit (max 1 per hour per agent)", async () => {
    // Mock getEpisodesByTimeRange to return a recent episode (<1 hour ago)
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("rate_limited");
  });

  it("calls markEventsConsolidated after episode creation", async () => {
    // Verify markEventsConsolidated is called with the episode's eventIds
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
    });
    expect(mockMarkEventsConsolidated).toHaveBeenCalled();
  });

  it("supports configurable thresholds", async () => {
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
      sessionGapMinutes: 60,
      maxEventsWithoutEpisode: 100,
      rateLimitMinutes: 120,
    });
    // Verify custom thresholds are used
  });

  it("supports explicit trigger (force=true bypasses thresholds)", async () => {
    const result = await checkAutoEpisodeTriggers({
      db: mockDb,
      prefix: "test_",
      agentId: "a1",
      summarizer: mockSummarizer,
      force: true,
    });
    // Even with few events, force=true triggers if >=2 unconsolidated events
    expect(result.triggered).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-episodes.test.ts`
Expected: FAIL (function not defined)

**Step 3: Implement checkAutoEpisodeTriggers**

In `src/memory/mongodb-episodes.ts`, add:

```typescript
import { getUnconsolidatedEvents, markEventsConsolidated } from "./mongodb-events.js";

export type AutoEpisodeTriggerResult = {
  triggered: boolean;
  reason?: "session_gap" | "event_count" | "explicit" | "rate_limited" | "insufficient_events";
  episode?: Episode;
};

/**
 * Check if auto episode materialization should trigger.
 * Three triggers:
 * (a) Session gap: >sessionGapMinutes between consecutive events
 * (b) Event count: >maxEventsWithoutEpisode unconsolidated events
 * (c) Explicit: force=true (user-triggered)
 *
 * MUST be async (not blocking write path) -- the summarizer is an LLM call.
 * Rate limited: max 1 episode per rateLimitMinutes per agent.
 */
export async function checkAutoEpisodeTriggers(params: {
  db: Db;
  prefix: string;
  agentId: string;
  summarizer: EpisodeSummarizer;
  scope?: MemoryScope;
  sessionGapMinutes?: number;
  maxEventsWithoutEpisode?: number;
  rateLimitMinutes?: number;
  force?: boolean;
}): Promise<AutoEpisodeTriggerResult> {
  const {
    db,
    prefix,
    agentId,
    summarizer,
    scope,
    sessionGapMinutes = 30,
    maxEventsWithoutEpisode = 50,
    rateLimitMinutes = 60,
    force = false,
  } = params;

  try {
    // 1. Get unconsolidated events
    const events = await getUnconsolidatedEvents({ db, prefix, agentId, scope, limit: 500 });

    // Need at least 2 events for any episode
    if (events.length < 2) {
      return { triggered: false, reason: "insufficient_events" };
    }

    // 2. Rate limit check (unless forced)
    if (!force) {
      const now = new Date();
      const rateLimitWindow = new Date(now.getTime() - rateLimitMinutes * 60 * 1000);
      const recentEpisodes = await getEpisodesByTimeRange({
        db,
        prefix,
        agentId,
        start: rateLimitWindow,
        end: now,
      });
      if (recentEpisodes.length > 0) {
        return { triggered: false, reason: "rate_limited" };
      }
    }

    // 3. Determine trigger reason
    let triggerReason: "session_gap" | "event_count" | "explicit" | undefined;

    if (force) {
      triggerReason = "explicit";
    } else {
      // Check session gap
      const gapMs = sessionGapMinutes * 60 * 1000;
      for (let i = 1; i < events.length; i++) {
        const gap = events[i].timestamp.getTime() - events[i - 1].timestamp.getTime();
        if (gap > gapMs) {
          triggerReason = "session_gap";
          break;
        }
      }

      // Check event count
      if (!triggerReason && events.length > maxEventsWithoutEpisode) {
        triggerReason = "event_count";
      }
    }

    if (!triggerReason) {
      return { triggered: false };
    }

    // 4. Determine time range from unconsolidated events
    const timeRange = {
      start: events[0].timestamp,
      end: events[events.length - 1].timestamp,
    };

    // 5. Materialize episode
    const episode = await materializeEpisode({
      db,
      prefix,
      agentId,
      type: "thread", // auto-triggered episodes are "thread" type
      timeRange,
      scope,
      summarizer,
    });

    if (!episode) {
      return { triggered: false, reason: "insufficient_events" };
    }

    // 6. Mark events as consolidated
    const eventIds = events.map((e) => e.eventId);
    await markEventsConsolidated({ db, prefix, eventIds, episodeId: episode.episodeId });

    log.info(
      `auto episode triggered: reason=${triggerReason} episode=${episode.episodeId} events=${eventIds.length} agent=${agentId}`,
    );
    return { triggered: true, reason: triggerReason, episode };
  } catch (err) {
    log.error(
      `checkAutoEpisodeTriggers failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
```

**Step 4: Export from barrel**

In `src/memory/index.ts`, add to the mongodb-episodes.js export block:

```typescript
checkAutoEpisodeTriggers,
type AutoEpisodeTriggerResult,
```

**Step 5: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/mongodb-episodes.test.ts`
Expected: All pass (existing 14 tests + new tests).

**Step 6: Run full test suite**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: All 205+ tests pass.

**Step 7: Commit**

```bash
scripts/committer "feat: add auto episode triggers (session gap, event count, explicit)" src/memory/mongodb-episodes.ts src/memory/mongodb-episodes.test.ts src/memory/index.ts
```

---

## Final Validation

> **Exit Criteria:** All v2 unit tests pass. Build succeeds. Lint/format clean. All new functions exported from barrel. Index count updated.

### Task F.1: Run full validation suite

**Step 1: Build**

Run: `pnpm build`
Expected: exit 0

**Step 2: Unit tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: All tests pass (205 existing + ~35 new = ~240 tests)

**Step 3: Lint/format**

Run: `pnpm check`
Expected: Clean (24 pre-existing TS errors in test files only, not new)

**Step 4: Verify exports**

Check `src/memory/index.ts` exports all new symbols:

- `markEventsConsolidated`
- `getUnconsolidatedEvents`
- `extractAndUpsertEntities`
- `rerankResults`, `RerankWeights`
- `checkAutoEpisodeTriggers`, `AutoEpisodeTriggerResult`

**Step 5: Verify index count**

The `EXPECTED_STANDARD_INDEX_COUNT` in e2e tests should be 44 (43 + 1 sparse consolidatedAt index).

**Step 6: Commit final validation**

```bash
scripts/committer "chore: final validation for memory v2 enhancements" [any remaining files]
```

---

## Risks

| Risk                                                                      | P   | I   | Score | Mitigation                                                               |
| ------------------------------------------------------------------------- | --- | --- | ----- | ------------------------------------------------------------------------ |
| $facet memory limit (100MB per pipeline) with large $graphLookup          | 2   | 3   | 6     | maxConnections limit (default 100) + maxDepth clamp                      |
| Source diversity reranker is no-op if all v2 results share same source    | 3   | 2   | 6     | Documented as Phase 1 limitation; recency boost deferred                 |
| Entity extraction regex false positives (e.g., @variable in code)         | 3   | 2   | 6     | Stop-word list + min 3-char filter + function is opt-in (caller decides) |
| Auto episode rate limiter uses getEpisodesByTimeRange which could be slow | 2   | 2   | 4     | Only queries last hour, uses existing index on timeRange.start           |
| Bidirectional graph may return duplicate relations from forward+reverse   | 2   | 2   | 4     | Dedup by existing key pattern `${from}:${to}:${type}`                    |

---

## Success Criteria

- [ ] EPISODES_SCHEMA enum includes all 5 EpisodeType values
- [ ] Events can be marked as consolidated with consolidatedAt + episodeId
- [ ] getUnconsolidatedEvents returns only unconsolidated events
- [ ] Sparse index on consolidatedAt exists (44 total standard indexes)
- [ ] expandGraph supports bidirectional traversal via $facet
- [ ] expandGraph respects maxConnections limit
- [ ] rerankResults applies source diversity and episode boost
- [ ] searchV2 uses rerankResults between dedup and slice
- [ ] extractAndUpsertEntities extracts @mentions, #tags, URLs, paths, "quoted names"
- [ ] Entity IDs are deterministic via hash
- [ ] checkAutoEpisodeTriggers fires on gap, count, and explicit triggers
- [ ] Auto episodes are rate-limited
- [ ] All new functions exported from index.ts
- [ ] All tests pass (existing + new)
- [ ] Build succeeds
- [ ] No new npm dependencies
