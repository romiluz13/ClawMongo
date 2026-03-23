# Production-Readiness E2E Test Suite Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** N/A (self-contained test file, no design doc needed).
> **Existing tests:** `src/memory/real-e2e-v2.e2e.test.ts` (81 tests, 17 phases) and `src/memory/mongodb-e2e.e2e.test.ts` (existing collections/sync tests). This plan creates a NEW complementary file.

**Goal:** Create `src/memory/production-readiness.e2e.test.ts` — a single living test file that validates all 15 audit gaps the existing 81-test e2e suite missed, covering operational quality (score bounds, index usage, telemetry completeness, timeout behavior, bulkWrite batching) against real MongoDB (atlas-local:preview).

**Architecture:** Sequential layered phases where later phases depend on data seeded in earlier phases. A realistic multi-turn agent conversation is written in Phase 1, then every subsequent phase validates a different production-quality aspect using that shared data. Uses the same vitest.e2e.config.ts infrastructure as the existing e2e tests.

**Tech Stack:** TypeScript, Vitest, MongoDB Node.js driver, atlas-local:preview (MongoDB 8.2+), Voyage AI API (for reranking/vector search)

**Prerequisites:**

- `MONGODB_TEST_URI` env var pointing to a running atlas-local:preview instance
- `VOYAGE_API_KEY` env var for reranking/vector-search tests (some tests degrade gracefully without it)
- Collections and indexes created by `ensureCollections` + `ensureStandardIndexes`

---

## Plan Mode & Rigor

- Plan mode: `execution_plan`
- Verification rigor: `standard`

## Requirements Snapshot

1. ONE new test file: `src/memory/production-readiness.e2e.test.ts`
2. Tests run against REAL MongoDB via `vitest.e2e.config.ts`
3. Covers all 15 audit gaps identified in the gap analysis
4. Uses realistic agent conversation data (not synthetic "test123")
5. Validates operational quality: score ranges, index usage, telemetry, timeouts
6. File follows existing project patterns: randomUUID() agentId, deleteMany cleanup, VECTOR_SEARCH_TIMEOUT for autoEmbed
7. Complements existing tests — does NOT duplicate them

## Constraints Snapshot

- atlas-local:preview = MongoDB 8.2+ (all operators available)
- `$vectorSearch` requires search indexes + autoEmbed time (180s timeout for polling)
- Voyage API tests need `VOYAGE_API_KEY` env var (tests should skip gracefully if absent)
- Fire-and-forget telemetry means we need `setTimeout` or `flushTelemetry` helper to wait for insertOne completion
- Cannot use `$vectorSearch` inside `$facet` or `$lookup`
- `$percentile` requires `method: "approximate"` (GA since MongoDB 7.0)
- Test file should NOT import from `mongodb-manager.ts` MongoDBMemoryManager class (use standalone functions)

## In Scope

- All 15 audit gaps from the gap analysis
- 12 test phases covering: foundation data, write-path quality, read-path quality, index health, cache behavior, reranker robustness, profile synthesis, telemetry completeness, query rewriting, graceful degradation, score normalization, MongoDB operator inventory
- Realistic conversation dataset (multi-turn, multi-session, named entities)
- `explain("executionStats")` assertions for index usage (COLLSCAN detection)
- `$percentile` server-side aggregation validation
- bulkWrite batching verification
- RRF score normalization bounds validation

## Out Of Scope

- Modifying existing e2e test files
- Testing the `MongoDBMemoryManager` class (tested elsewhere)
- LLM entity extraction (not production-ready yet)
- Change Streams testing (already covered in mongodb-e2e.e2e.test.ts)
- Performance benchmarking (this is correctness-focused)

## Open Decisions

None

## Differences From Agreement

None

## Recommended Defaults

- Phase 1 conversation size: 15+ events across 2 sessions (sufficient to trigger episode materialization, entity extraction, and multi-path searchV2)
- Telemetry flush wait: 200ms setTimeout after fire-and-forget calls (empirically sufficient for local insertOne)
- explain() threshold: reject if ANY critical pipeline stage shows `COLLSCAN` (zero tolerance for missing indexes)

## Current State

### Existing test coverage

- `src/memory/real-e2e-v2.e2e.test.ts` — 81 tests across 17 phases. Covers: event write, entity extraction, graph ops, episode materialization, consolidation, auto triggers, retrieval planner, searchV2 pipeline, V2 status/health, agent isolation, vector search, semantic cache, telemetry, profile synthesis, reranking, query rewriting, entity extraction.
- `src/memory/mongodb-e2e.e2e.test.ts` — ~30 tests. Covers: collection/index creation, sync workflow, $text search, search dispatcher, dedup, transactions, TTL, analytics, change streams, v2 event/chunk/graph/episode/migration/retrieval/health.

### 15 audit gaps NOT covered

| #   | Gap                                | Why it matters                                                                                       |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | RRF Score Normalization            | Scores from different paths merged without validating [0,1]                                          |
| 2   | Tier 2 Cache (Semantic Similarity) | $vectorSearch on cache never tested with real MongoDB                                                |
| 3   | KB Path in searchV2                | Retrieval planner routes to "kb" but no KB search e2e (Phase 1 seeds KB data, Phase 3 tests KB path) |
| 4   | Index Usage (explain)              | ZERO explain() calls in any test                                                                     |
| 5   | Score Bounds                       | No test asserts all scores in [0,1] after fusion                                                     |
| 6   | Graceful Degradation Cascade       | Multi-layer failure cascade not tested                                                               |
| 7   | Config Validation                  | Bad config never tested e2e                                                                          |
| 8   | Reranking Timeout                  | Timeout behavior with real latency not tested                                                        |
| 9   | Empty Snippet Handling             | Graph relations with empty text sent to reranker                                                     |
| 10  | Entity-Extraction Telemetry        | Entity extraction telemetry emission never verified                                                  |
| 11  | Cache TTL from Paths               | TTL derivation from pathsExecuted never verified                                                     |
| 12  | Raw-Window Event Cap               | Unbounded time-range query never stress-tested                                                       |
| 13  | $percentile Server-Side            | Telemetry $percentile never tested against real MongoDB                                              |
| 14  | bulkWrite Batching                 | Entity upserts bulkWrite behavior never verified                                                     |
| 15  | Synonym Expansion Quality          | False-positive rate never measured                                                                   |

### Key source files referenced

| File                                         | What it provides                                                 | Lines |
| -------------------------------------------- | ---------------------------------------------------------------- | ----- |
| `src/memory/mongodb-manager.ts:2603-3083`    | `searchV2()` — multi-path search with RRF normalization          |
| `src/memory/mongodb-telemetry.ts:72-133`     | `getLatencyStats()` — $percentile aggregation                    |
| `src/memory/mongodb-query-cache.ts:78-222`   | `checkCache()` — two-tier cache lookup                           |
| `src/memory/mongodb-reranker.ts:50-166`      | `crossEncoderRerank()` — Voyage API reranking                    |
| `src/memory/mongodb-query-rewriter.ts:73-97` | `expandSynonyms()` — synonym expansion                           |
| `src/memory/mongodb-profile.ts:78-295`       | `synthesizeProfile()` — $facet + $lookup                         |
| `src/memory/mongodb-hybrid.ts:64-66`         | `rrfScore()` — RRF formula                                       |
| `src/memory/mongodb-graph.ts`                | `extractAndUpsertEntities()`, `expandGraph()`                    |
| `src/memory/mongodb-events.ts`               | `writeEvent()`, `getEventsByTimeRange()`                         |
| `src/memory/mongodb-schema.ts`               | Collection helpers, `ensureCollections`, `ensureStandardIndexes` |
| `src/memory/mongodb-episodes.ts`             | `materializeEpisode()`, `searchEpisodes()`                       |

---

## Critical-Path Verification Design

- Behavior contract: Not required (standard rigor)
- Edge-case catalog: See Phase 10 (graceful degradation) and Phase 6 (reranker robustness)
- Provable properties: None
- Purity boundary map: Not required
- Verification strategy: Each phase has explicit assertions. Run via `pnpm vitest run --config vitest.e2e.config.ts src/memory/production-readiness.e2e.test.ts --reporter=verbose`

---

## Phase Plan

### Phase 1: File Scaffold and Realistic Conversation Data

**Objective:** Create the test file skeleton with imports, connection setup, cleanup, and a realistic 15-event multi-session conversation dataset that all later phases share.

**Inputs:** Existing e2e patterns from `real-e2e-v2.e2e.test.ts` and `mongodb-e2e.e2e.test.ts`

**Files/surfaces:**

- Create: `src/memory/production-readiness.e2e.test.ts`

**Expected artifacts:**

- Test file with:
  - MongoDB connection setup (beforeAll/afterAll)
  - `ensureCollections` + `ensureStandardIndexes` in beforeAll
  - Unique `AGENT_ID = randomUUID()` for test isolation
  - Unique `PREFIX = "prodready_"` to avoid collisions
  - Two conversation sessions:
    - Session 1 (10 events): A developer discussing Kubernetes migration with named people (Sarah, Marcus), specific projects (Atlas Migration), and technical topics (pod autoscaling, Helm charts, CI/CD pipeline)
    - Session 2 (5 events): Bug report and fix discussion with references back to earlier conversation
  - Events written via `writeEvent()` with realistic timestamps spanning 2 days
  - Entity extraction via `extractAndUpsertEntities()` on the events
  - Episode materialization via `materializeEpisode()` on day 1 events
  - Structured memory entries (preferences, decisions, facts) via `writeStructuredMemory()`
  - KB data seeded: Insert 3-5 documents into `kb_chunks` collection with realistic reference content (e.g., "Kubernetes Helm chart best practices", "MongoDB aggregation pipeline patterns", "CI/CD pipeline configuration guide") to support Gap #3 testing in Phase 3
  - A `describe("Phase 1: Foundation Data", ...)` with basic smoke tests confirming data was seeded
- Phase 1 test count: ~6 tests (events written, entities extracted, episode created, structured mem written, relations created, KB data seeded)

**Required checks:**

- `it("seeds 15 events across 2 sessions")` — countDocuments === 15
- `it("extracts entities: Sarah, Marcus, Atlas Migration, Kubernetes")` — findEntitiesByName returns matches
- `it("materializes day-1 episode")` — episode exists with correct sourceEventCount
- `it("creates structured memory entries")` — at least 3 entries exist
- `it("creates entity relations")` — relation count > 0
- `it("seeds KB reference documents")` — kb_chunks countDocuments >= 3

**Checkpoint type:** Automated (all assertions)

**Exit criteria:** 15 events, 4+ entities, 1+ episode, 3+ structured memory entries, 1+ relations, 3+ KB chunks exist in the test database.

---

### Phase 2: Write-Path Quality (Gaps #10, #14)

**Objective:** Verify entity extraction telemetry emission and bulkWrite batching behavior.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 2: Write-Path Quality", ...)` with tests for:
  - **Gap #10 (Entity-Extraction Telemetry):** After Phase 1 extraction, query `memory_telemetry` collection for `meta.operation === "entity-extraction"` entries. Assert they exist and have `ok: true`, `entitiesExtracted >= 1`, and valid `durationMs`.
  - **Gap #14 (bulkWrite Batching):** Call `extractAndUpsertEntities()` with a text containing 6+ entity names. Verify: (a) all entities created with correct types, (b) relations created between them (C(n,2) pairs capped at 15), (c) performance: entire batch completes in <500ms (single bulkWrite vs N sequential inserts).

**Required checks:**

- `it("emits entity-extraction telemetry")` — telemetry doc exists with correct fields
- `it("batches entity upserts for multiple entities")` — 6+ entities created, 15 relations (cap), all in one call
- `it("records extraction method in telemetry")` — `extractionMethod` field present

**Checkpoint type:** Automated

**Exit criteria:** Telemetry entries for entity-extraction exist. bulkWrite creates entities and relations in bounded time.

---

### Phase 3: Read-Path Quality — searchV2 (Gaps #1, #3, #5)

**Objective:** Validate that searchV2 produces scores in [0,1] after RRF normalization, that multi-path results are properly fused, and that the KB path actually executes.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 3: Read-Path Quality", ...)` with tests for:
  - **Gap #1 (RRF Score Normalization):** Run `searchV2()` with a query that hits multiple paths (e.g., "Sarah Kubernetes migration" triggers graph + hybrid + episodic). Assert: every result score is `>= 0 && <= 1`. Assert: results are sorted by score descending. Assert: `metadata.pathsExecuted.length >= 2`.
  - **Gap #5 (Score Bounds):** Run searchV2 with multiple query types (entity name, time reference, technical topic) and assert ALL scores across all queries are in [0,1].
  - **Gap #3 (KB Path in searchV2):** Seed KB data in Phase 1 (insert documents into `kb_chunks` collection with realistic content like "Kubernetes Helm chart best practices" and "CI/CD pipeline configuration guide"). Then run `searchV2()` with the "kb" path available (`availablePaths` includes "kb") and a query like "Helm chart best practices" that should route through the kb path. Assert: either (a) `metadata.pathsExecuted` includes "kb" and results contain KB content, OR (b) if $vectorSearch is not available for kb_chunks, the path fails gracefully (no crash) and metadata does NOT include "kb". Also directly test `searchKB()` function with the seeded data and $text search to confirm the function works against real MongoDB.
  - Verify `metadata.resultsByPath` accurately reports per-path counts.
  - Verify deduplication: if same content appears in multiple paths, only highest-scoring version survives.

**Required checks:**

- `it("all searchV2 scores are in [0,1] after RRF normalization")` — every result.score validated
- `it("results are sorted by score descending")` — adjacent pair comparison
- `it("multiple paths are executed for entity+topic queries")` — pathsExecuted.length >= 2
- `it("KB path routes through searchKB on kb-related queries")` — searchKB returns results or fails gracefully
- `it("resultsByPath accurately reports per-path counts")` — sum(resultsByPath values) >= total results
- `it("deduplicates results across paths")` — no duplicate snippets in final results

**Checkpoint type:** Automated

**Exit criteria:** All searchV2 results have scores in [0,1], sorted descending, with multi-path execution confirmed. KB path tested directly via searchKB.

---

### Phase 4: Index Health via explain() (Gap #4)

**Objective:** Run `explain("executionStats")` on critical aggregation pipelines and assert NO COLLSCAN on indexed fields.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 4: Index Health", ...)` with tests for:
  - **Relations $lookup by fromEntityId:** Run explain on the profile synthesis outgoing relations lookup. Assert: winning plan uses index on `fromEntityId`.
  - **Relations $lookup by toEntityId:** Same for incoming relations. Assert: index used.
  - **Entity search by name:** explain on `findEntitiesByName` query. Assert: uses compound index, not COLLSCAN.
  - **Event time-range query:** explain on `getEventsByTimeRange` equivalent query. Assert: uses timestamp compound index.
  - **Structured memory by type:** explain on structured_mem find with type filter. Assert: uses compound index.
  - **Telemetry by operation:** explain on telemetry aggregation $match. Assert: uses ts index.

**Implementation pattern:**

```typescript
const explainResult = await collection.find(filter).explain("executionStats");
// Walk executionStats.executionStages looking for COLLSCAN
function hasCollScan(stages: any): boolean {
  if (stages.stage === "COLLSCAN") return true;
  if (stages.inputStage) return hasCollScan(stages.inputStage);
  if (stages.inputStages) return stages.inputStages.some(hasCollScan);
  return false;
}
expect(hasCollScan(explainResult.queryPlanner.winningPlan)).toBe(false);
```

**Required checks:**

- `it("relations fromEntityId lookup uses index")` — no COLLSCAN
- `it("relations toEntityId lookup uses index")` — no COLLSCAN
- `it("entity name search uses compound index")` — no COLLSCAN
- `it("event time-range query uses timestamp index")` — no COLLSCAN
- `it("structured memory type query uses compound index")` — no COLLSCAN
- `it("telemetry operation query uses ts index")` — no COLLSCAN

**Checkpoint type:** Automated

**Exit criteria:** All 6 explain checks pass with zero COLLSCAN stages on indexed paths.

---

### Phase 5: Cache Behavior (Gaps #2, #11)

**Objective:** Validate two-tier cache (exact + semantic), TTL derivation from pathsExecuted, and cache hit/miss lifecycle.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 5: Cache Behavior", ...)` with tests for:
  - **Cache miss on first query:** Call `checkCache()` with a fresh query. Assert: `hit === false, tier === "miss"`.
  - **Cache write then exact hit:** Call `writeCache()` with results, then `checkCache()` with same query. Assert: `hit === true, tier === "exact"`.
  - **Gap #2 (Tier 2 Semantic Cache):** Write cache with query "Kubernetes pod autoscaling". Check cache with slightly different query "K8s autoscaling pods". If vector search index exists, assert: `tier === "semantic"` with high similarity. If not, assert: `tier === "miss"` (graceful degradation).
  - **Gap #11 (Cache TTL from Paths):** Write cache entries with different TTLs (conversation: 300s, KB: 3600s). Assert: `expiresAt` field reflects the TTL correctly by checking the stored document directly.
  - **Cache hit count tracking:** Verify `hitCount` increments on repeated hits and `lastHitAt` updates.

**Required checks:**

- `it("reports cache miss on first query")` — hit === false
- `it("reports exact cache hit after write")` — tier === "exact"
- `it("attempts semantic similarity lookup on near-miss query")` — tier is "semantic" or "miss" depending on index
- `it("derives TTL from source type: conversation=300s, kb=3600s")` — expiresAt math validated
- `it("increments hitCount and updates lastHitAt")` — verified via direct document read

**Checkpoint type:** Automated

**Exit criteria:** Cache lifecycle (miss -> write -> hit) works. TTL derivation correct. Hit tracking functional.

---

### Phase 6: Reranker Robustness (Gaps #8, #9)

**Objective:** Test cross-encoder reranking with real Voyage API including timeout behavior and empty snippet handling.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 6: Reranker Robustness", ...)` with tests for:
  - **Valid reranking:** Call `crossEncoderRerank()` with 5+ results from Phase 1 data. Assert: `reranked === true`, all output scores in [0,1], results are sorted by relevance_score.
  - **Gap #8 (Reranking Timeout):** `crossEncoderRerank()` uses `AbortSignal.timeout(10_000)`. Test: verify that when the function handles timeout gracefully (reranked=false, original order preserved). Use a mock URL or verify the catch behavior by checking the fallback path.
  - **Gap #9 (Empty Snippet Handling):** Create results where some have empty/blank snippets (simulating graph relations). Call `crossEncoderRerank()`. Assert: empty-snippet results are filtered before API call (counted separately), non-empty results are reranked, final output includes both reranked + empty-snippet + overflow + below-minScore in correct order.
  - Skip tests gracefully if `VOYAGE_API_KEY` is not set.

**Required checks:**

- `it("reranks valid results with Voyage API")` — reranked=true, scores in [0,1] (skip if no API key)
- `it("preserves input order when reranking fails or times out")` — reranked=false
- `it("filters empty snippets before sending to reranker API")` — empty snippets not in API payload but appear in output
- `it("emits rerank telemetry on success and failure")` — telemetry docs exist for both

**Checkpoint type:** Automated

**Exit criteria:** Reranker handles valid, timeout, and empty-snippet cases correctly.

---

### Phase 7: Profile Synthesis (Gap #4 continued — $facet + $lookup index usage)

**Objective:** Validate `synthesizeProfile()` with real data and verify the split-$lookup pattern uses indexes.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 7: Profile Synthesis", ...)` with tests for:
  - **Profile completeness:** Call `synthesizeProfile()` on Phase 1 data. Assert: preferences, decisions, facts have entries. topEntities includes at least "Sarah" and "Kubernetes". recentEpisodes has at least 1 entry. activityPatterns.totalEvents === 15.
  - **$facet returns structured memory grouped by type:** Assert preferences.length > 0, decisions.length > 0.
  - **Activity patterns from events:** Assert roleDistribution has "user" and "assistant" keys. lastActive is a valid Date.
  - **Top entities by relation count:** Assert topEntities are sorted by relationCount descending.
  - **Profile emits telemetry:** Check telemetry collection for `operation === "profile-synthesis"`.

**Required checks:**

- `it("returns complete profile with all sections populated")` — all fields non-empty
- `it("groups structured memory by type via $facet")` — preferences and decisions have entries
- `it("calculates activity patterns from events")` — roleDistribution, totalEvents, lastActive validated
- `it("ranks entities by relation count")` — sorted descending
- `it("emits profile-synthesis telemetry")` — telemetry entry exists

**Checkpoint type:** Automated

**Exit criteria:** Profile synthesis returns complete, correctly structured results from real MongoDB data.

---

### Phase 8: Telemetry Completeness (Gap #13)

**Objective:** Verify all telemetry operations are represented and `$percentile` works against real MongoDB.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 8: Telemetry Completeness", ...)` with tests for:
  - **Gap #13 ($percentile Server-Side):** Call `getLatencyStats()` after all prior phases generated telemetry. Assert: p50, p95, p99 are numbers >= 0. Count > 0. This validates the `$percentile` aggregation runs successfully on real MongoDB 8.2.
  - **Operation distribution:** Call `getOperationDistribution()`. Assert: at least 3 different operation types appear (e.g., "entity-extraction", "profile-synthesis", "cache-check").
  - **Cache hit rate:** Call `getCacheHitRate()`. Assert: returns valid hitRate (0 <= hitRate <= 1).
  - **Every operation type has telemetry:** Query telemetry collection grouped by `meta.operation`. Assert that operations from prior phases exist: "entity-extraction", "profile-synthesis", "cache-check", and optionally "rerank" and "query-rewrite".

**Required checks:**

- `it("getLatencyStats returns valid p50/p95/p99 via $percentile")` — all are numbers >= 0
- `it("getOperationDistribution reports multiple operations")` — 3+ distinct operations
- `it("getCacheHitRate returns valid rate")` — 0 <= hitRate <= 1
- `it("telemetry covers all operation types from prior phases")` — 3+ operation types present

**Checkpoint type:** Automated

**Exit criteria:** $percentile works on real MongoDB. All telemetry aggregation helpers return valid data.

---

### Phase 9: Query Rewriting (Gap #15)

**Objective:** Validate synonym expansion quality — no false positives, 3x cap respected.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 9: Query Rewriting", ...)` with tests for:
  - **Expansion works on realistic queries:** `expandSynonyms("auth db config")` produces expanded terms including "authentication", "database", "configuration".
  - **Gap #15 (No false positives):** Assert that "api" does NOT expand to "route" or "rest" (H7 audit fix). Assert "ui" does NOT expand to "frontend" or "component".
  - **3x expansion cap:** `expandSynonyms("auth db config deps deploy")` — 5 words, max 15 expanded. Count words in result, assert <= 15.
  - **Original words preserved:** All original words appear in expanded output.
  - **rewriteQuery integration:** Call `rewriteQuery()` with config `{ enabled: true, method: "synonym-expansion", maxTokens: 100 }`. Assert: `rewritten === true`, `method === "synonym-expansion"`, `rewrittenQuery` contains original + expanded terms.
  - **Telemetry emission:** After rewriteQuery, check telemetry for `operation === "query-rewrite"` with `queryRewritten === true`.

**Required checks:**

- `it("expands known synonyms: auth -> authentication, login, oauth")` — terms present
- `it("does NOT expand api to route/rest (H7 fix)")` — no false positives
- `it("respects 3x expansion cap")` — word count <= 3 \* original count
- `it("preserves original words in expansion")` — all originals present
- `it("rewriteQuery emits query-rewrite telemetry")` — telemetry entry exists

**Checkpoint type:** Automated

**Exit criteria:** Synonym expansion is correct, bounded, and free of known false positives.

---

### Phase 10: Graceful Degradation (Gap #6)

**Objective:** Test multi-layer failure cascades and empty-state behavior.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 10: Graceful Degradation", ...)` with tests for:
  - **Gap #6 (Multi-layer cascade):** Use a fresh agentId with NO data. Call `searchV2()` with all paths available. Assert: returns empty results (not crash), metadata shows 0 pathsExecuted, no error thrown.
  - **Empty profile synthesis:** Call `synthesizeProfile()` on empty agentId. Assert: returns profile with all arrays empty, totalEvents === 0, lastActive === null. No error thrown.
  - **searchV2 with no vector index available:** Call searchV2 with `capabilities: { vectorSearch: false, textSearch: false, scoreFusion: false, rankFusion: false }`. Assert: degrades to $text search or returns empty gracefully.
  - **getLatencyStats with no telemetry:** Call on empty agentId. Assert: returns { p50: 0, p95: 0, p99: 0, count: 0 }.
  - **checkCache on empty cache:** Assert: `hit === false, tier === "miss"`.

**Required checks:**

- `it("searchV2 returns empty on completely empty agent")` — no crash
- `it("synthesizeProfile returns empty profile on no data")` — all arrays empty
- `it("getLatencyStats returns zeros on no telemetry")` — all fields are 0
- `it("checkCache returns miss on empty cache")` — hit === false
- `it("searchV2 degrades gracefully with no vector capabilities")` — no crash

**Checkpoint type:** Automated

**Exit criteria:** All empty-state and degraded-capability scenarios return safe defaults without crashing.

---

### Phase 11: Score Normalization Deep Check (Gaps #1, #5 reinforced)

**Objective:** The deep validation that the original e2e MISSED — write data that triggers all paths, run searchV2, and exhaustively validate every score.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 11: Score Normalization Deep Check", ...)` with tests for:
  - **Multi-path execution:** Use the Phase 1 agent's data. Run searchV2 with a query that references entities ("Sarah"), time ("yesterday"), and topic ("Kubernetes migration") to trigger graph + raw-window + hybrid/episodic paths simultaneously.
  - **Exhaustive score validation:** Iterate ALL results. For each: assert `result.score >= 0`, assert `result.score <= 1`, assert `typeof result.score === "number"`, assert `!Number.isNaN(result.score)`.
  - **RRF metadata present:** When pathsExecuted.length > 1, verify that scores were modified by RRF (not raw synthetic scores like 0.85 or 1.0 - recency).
  - **Sort order invariant:** For every pair of adjacent results, assert `results[i].score >= results[i+1].score`.
  - **Gap #12 (Raw-Window Event Cap):** Call searchV2 with raw-window path on a query that matches many events. Verify result count from raw-window path is capped at 50 (the M2 audit fix limit).

**Required checks:**

- `it("every searchV2 result score satisfies 0 <= score <= 1")` — exhaustive loop
- `it("scores are finite numbers (no NaN, Infinity)")` — typeof + isNaN + isFinite
- `it("results are sorted descending by score")` — pairwise check
- `it("RRF normalization applied when multiple paths execute")` — pathsExecuted.length > 1
- `it("raw-window path caps results at 50")` — resultsByPath["raw-window"] <= 50

**Checkpoint type:** Automated

**Exit criteria:** ALL searchV2 results pass exhaustive score validation.

---

### Phase 12: MongoDB Operator Inventory

**Objective:** One test per MongoDB operator/feature to confirm it works on atlas-local:preview.

**Files/surfaces:** Same test file

**Expected artifacts:**

- `describe("Phase 12: MongoDB Operator Inventory", ...)` with tests for:
  - **$facet:** Run a $facet aggregation on structured_mem. Assert: returns an object with facet keys.
  - **$lookup:** Run a $lookup from entities to relations. Assert: joined results present.
  - **$graphLookup:** Run a $graphLookup on relations. Assert: recursive traversal works.
  - **$percentile:** Run $percentile on telemetry durationMs. Assert: returns array of numbers.
  - **$group + $count:** Run $group on events by role with $count. Assert: counts match expected.
  - **$addFields + $sort + $limit:** Run pipeline on entities. Assert: computed field present, sorted, limited.
  - **bulkWrite (updateOne + upsert):** Run bulkWrite on entities with 3 upserts. Assert: upsertedCount + modifiedCount correct.
  - **insertOne (time series):** Insert into telemetry collection (time series). Assert: insertedId present.
  - **createIndex (compound):** Create a test compound index. Assert: no error.
  - **createIndex (text):** Verify text index exists on chunks. Assert: index present.
  - **createIndex (TTL):** Create a TTL index on a test field. Assert: expireAfterSeconds set.
  - **createIndex (sparse):** Create a sparse index. Assert: sparse === true.
  - **$vectorSearch:** If search indexes available, run $vectorSearch. Assert: results have vectorSearchScore.
  - **$search:** If search indexes available, run $search. Assert: results have searchScore.

**Required checks:** One `it()` per operator (14 tests)

**Checkpoint type:** Automated

**Exit criteria:** All MongoDB operators used by ClawMongo work on atlas-local:preview.

---

## Acceptance Checks

```bash
# Run the full production-readiness e2e suite
MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true" \
  pnpm vitest run --config vitest.e2e.config.ts src/memory/production-readiness.e2e.test.ts --reporter=verbose

# Expected: all tests pass (some skip gracefully if VOYAGE_API_KEY absent)

# Verify the file compiles with no new TS errors
pnpm tsgo

# Verify it doesn't break existing tests
pnpm test -- src/memory/
```

## Risks And Mitigations

| Risk                                                   | P   | I   | Score | Mitigation                                                                         |
| ------------------------------------------------------ | --- | --- | ----- | ---------------------------------------------------------------------------------- |
| atlas-local:preview not running                        | 2   | 5   | 10    | Test file header documents required setup; beforeAll fails fast with clear message |
| Voyage API key missing                                 | 3   | 3   | 9     | Reranker + vector tests skip gracefully with `describe.skipIf(!API_KEY)`           |
| $vectorSearch requires autoEmbed delay                 | 3   | 3   | 9     | Use existing `waitForVectorResults` polling pattern with 180s timeout              |
| explain() output format varies by MongoDB version      | 2   | 3   | 6     | Use recursive COLLSCAN detection helper that walks any explain structure           |
| Fire-and-forget telemetry not flushed before assertion | 4   | 2   | 8     | Add 200ms await + retry pattern for telemetry assertions                           |
| Test data isolation across parallel runs               | 2   | 4   | 8     | randomUUID() agentId + unique prefix ensures isolation                             |

## Summary

- Plan saved: `docs/plans/2026-03-23-production-readiness-e2e-plan.md`
- Phases: 12
- Risks: 6 identified
- Key decisions: Sequential layered phases, realistic conversation data, explain()-based index validation, graceful skip for optional API keys

## Recommended Skills for BUILD (SKILL_HINTS for Router)

- `cc10x:architecture-patterns` (multi-component test architecture)

## Confidence Score: 88/100

- Context References included with file:line (+25) — all source files documented
- All edge cases documented (+20) — 15 gaps mapped to specific tests
- Test commands specific (+20) — exact vitest command provided
- Risk mitigations defined (+20) — 6 risks with concrete mitigations
- File paths exact (+15) — single file, clear path
- Deductions: -12 for Voyage API dependency (some tests need real API key to fully validate)

**Key Assumptions:**

- atlas-local:preview (MongoDB 8.2+) is available and running
- `$percentile` operator is GA in the test environment (MongoDB 7.0+)
- Voyage API key is available for reranking/vector tests (tests skip if not)
- Existing `ensureCollections` + `ensureStandardIndexes` create all needed indexes
- Fire-and-forget telemetry flushes within 200ms on local MongoDB

## Findings

- The existing 81-test real-e2e-v2.e2e.test.ts covers feature correctness well but has ZERO operational quality assertions (no explain(), no score bounds, no telemetry completeness)
- The RRF normalization in searchV2 (lines 3030-3046 of mongodb-manager.ts) uses `rrfScore()` from mongodb-hybrid.ts which produces values in (0, 1/k) range — should naturally be in [0,1] for k=60, but this was never validated
- The split-$lookup pattern in synthesizeProfile (replacing $or with two $eq lookups) was the C2/M4 audit fix — this plan validates it actually uses indexes via explain()
- `crossEncoderRerank` already has `AbortSignal.timeout(10_000)` but this timeout behavior was never tested
- `expandSynonyms` already has the 3x cap and H7 false-positive fixes — this plan validates those fixes hold

## Task Status

- Follow-up tasks created: None
- **CRITICAL:** Now execute the `TaskUpdate` tool to mark task as completed.

---

## Router Contract (MACHINE-READABLE)

```yaml
STATUS: PLAN_CREATED
PLAN_MODE: execution_plan
VERIFICATION_RIGOR: standard
CONFIDENCE: 88
PLAN_FILE: "docs/plans/2026-03-23-production-readiness-e2e-plan.md"
PHASES: 12
RISKS_IDENTIFIED: 6
SCENARIOS:
  - name: "searchV2 multi-path RRF score normalization"
    given: "15 realistic events with entities and episodes seeded"
    when: "searchV2 executes with query hitting graph + hybrid + episodic paths"
    then: "all result scores are in [0,1], sorted descending, pathsExecuted >= 2"
  - name: "explain detects no COLLSCAN on indexed queries"
    given: "standard indexes created via ensureStandardIndexes"
    when: "explain('executionStats') runs on 6 critical query patterns"
    then: "zero COLLSCAN stages found in any winning plan"
  - name: "$percentile telemetry aggregation"
    given: "telemetry entries emitted by prior test phases"
    when: "getLatencyStats runs $percentile aggregation"
    then: "p50, p95, p99 are valid non-negative numbers"
  - name: "graceful degradation on empty data"
    given: "fresh agentId with no data in any collection"
    when: "searchV2, synthesizeProfile, getLatencyStats called"
    then: "all return safe empty defaults without throwing"
  - name: "cache two-tier lifecycle"
    given: "empty cache for agent"
    when: "checkCache (miss) -> writeCache -> checkCache (hit)"
    then: "first check misses, second hits with tier=exact"
ASSUMPTIONS:
  [
    "atlas-local:preview running with MongoDB 8.2+",
    "$percentile GA in test environment",
    "Voyage API key available (tests skip if not)",
    "ensureStandardIndexes creates all needed indexes",
  ]
DECISIONS:
  [
    "Sequential layered phases sharing data",
    "Single file for all 12 phases",
    "explain-based COLLSCAN detection",
    "Graceful skip for optional API keys",
  ]
OPEN_DECISIONS: []
DIFFERENCES_FROM_AGREEMENT: []
RECOMMENDED_DEFAULTS:
  [
    "telemetry flush wait: 200ms",
    "explain threshold: zero COLLSCAN tolerance",
    "conversation size: 15 events across 2 sessions",
  ]
ALTERNATIVES: ["Separate files per phase", "Mock-based instead of real MongoDB"]
DRAWBACKS:
  [
    "Requires atlas-local:preview running for test execution",
    "Some tests need Voyage API key",
    "Sequential phases mean later tests depend on earlier data",
  ]
PROVABLE_PROPERTIES: []
BLOCKING: false
NEXT_ACTION: "build"
REMEDIATION_NEEDED: false
REQUIRES_REMEDIATION: false
REMEDIATION_REASON: null
GATE_PASSED: true
USER_INPUT_NEEDED: []
MEMORY_NOTES:
  learnings:
    [
      "15 audit gaps mapped to 12 test phases covering operational quality, all using shared realistic conversation data",
    ]
  patterns:
    [
      "explain-based COLLSCAN detection pattern for index health validation",
      "Sequential layered e2e test design where phases build on shared seeded data",
    ]
  verification:
    ["Plan: docs/plans/2026-03-23-production-readiness-e2e-plan.md with 88/100 confidence"]
```
