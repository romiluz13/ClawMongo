# Memory Retrieval Improvements (5 Gaps) Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** See `docs/plans/2026-03-15-memory-architecture-v2-design.md` for v2 design context (note: design file may not exist on disk; use memory context + source code as ground truth).

**Goal:** Add 5 incremental retrieval improvements to ClawMongo v2 memory system based on research across Mem0, MemGPT, Hindsight benchmarks, Paprwork reference repo, and MongoDB best practices.

**Architecture:** Each improvement is additive and opt-in via config flags. Never replace existing 1:1 event-to-chunk projection. All changes must be backward-compatible with the existing 16-collection, 60+ index architecture. Each improvement gets unit tests AND production-readiness e2e tests.

**Tech Stack:** TypeScript ESM, MongoDB Community + mongot, Vitest, Voyage AI embeddings

**Prerequisites:**

- Working ClawMongo v2 with all prod-readiness e2e tests passing
- MongoDB replica set available for e2e tests
- Current release: v2026.3.30

---

## Plan Metadata

- **Plan mode:** `execution_plan`
- **Verification rigor:** `critical_path`
- **Safety contract:** NEVER break existing functionality; all changes additive/opt-in

## Requirements Snapshot

1. Gap 1 - Context Expansion: When search hits chunk N, also fetch chunks N-1 and N+1 by timestamp from same session
2. Gap 2 - Wire LLM Entity Extractor: Pass `LLMEntityExtractor` to `extractAndUpsertEntities` when config says `method: "llm"`
3. Gap 3 - Conversation Window Chunks: Add second chunk type (5-7 turn windows with 2-turn overlap) alongside existing 1:1 event chunks
4. Gap 4 - 3-Tier Episode Summaries: Generate short_term, medium_term, long_term summaries + topics array per episode
5. Gap 5 - Contiguous Merge: Post-processing pure function to merge adjacent chunks from same session

## Constraints Snapshot

- MongoDB Community + mongot only (no external DB)
- TypeScript ESM, strict typing, no `any`
- Each improvement opt-in via config flag where appropriate
- Production-readiness e2e tests in `src/memory/production-readiness.e2e.test.ts`
- All existing unit tests + prod-readiness e2e tests must continue passing
- Pre-existing TS error baseline: 51 (all test-file-only; do not fix during this work)
- Standalone function pattern (db, prefix, ...) for v2 modules
- E2E test isolation: `randomUUID()` agentId per describe block + `deleteMany` in `beforeAll`

## In Scope

- All 5 gaps as specified
- Unit tests for each gap
- Production-readiness e2e tests for each gap (appended to existing file)
- Config type additions in `src/config/types.memory.ts`
- Backend config resolution additions in `src/memory/backend-config.ts`
- Barrel export additions in `src/memory/index.ts`
- **Prerequisite schema change:** Add `sessionId` and `timestamp` to chunk documents and `MemorySearchResult`

## Out Of Scope

- Replacing existing 1:1 event-to-chunk projection
- Adding external databases
- Changing canonical truth model
- Fixing pre-existing TS errors
- Fixing pre-existing test failures
- LLM-based query rewriting (separate feature)
- Change stream episode triggers (deferred)
- Voyage-Context-3 model changes (deferred)

## Open Decisions

- None (all decisions pre-answered in requirements)

## Differences From Agreement

- None

## Recommended Defaults

- Context expansion `enableContextExpansion`: default `true` (low risk, high value)
- Conversation windows `enableConversationWindows`: default `false` (new chunk type, opt-in)
- Contiguous merge `enableContiguousMerge`: default `true` (pure post-processing, low risk)
- Entity extraction method: default `"regex"` (safe default, opt-in to `"llm"`)

## Critical-Path Verification Design

### Behavior Contract

1. **Existing search results MUST NOT change** when all new features are disabled (default config)
2. **Context expansion** adds neighbor chunks but MUST NOT duplicate already-returned chunks
3. **LLM entity extractor** MUST fall back to regex on timeout/error (5s default)
4. **Conversation window chunks** MUST coexist with 1:1 event chunks (different path prefix: `windows/` vs `events/`)
5. **Tiered episode summaries** MUST be backward-compatible (existing episodes with single summary still work)
6. **Contiguous merge** MUST preserve the highest score of any chunk in the merged block

### Edge-Case Catalog

| Edge Case                                                    | Expected Behavior                                      |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Context expansion on chunk with no sessionId in chunk doc    | Skip expansion for that chunk, return original results |
| Context expansion returns duplicate of already-fetched chunk | Deduplicate by canonicalId/path                        |
| LLM extractor timeout (>5s)                                  | Fall back to regex, log warning                        |
| LLM extractor returns malformed JSON                         | Fall back to regex, log warning                        |
| LLM extractor config="llm" but no llmFn injected             | Do not create LLMEntityExtractor, use default regex    |
| Conversation window with <5 turns in session                 | Skip window projection (session too short)             |
| Conversation window with exactly 5 turns                     | Create single window, no overlap                       |
| Episode with existing single summary + new tiered fields     | Both accessible; single summary is backward compat     |
| Contiguous merge with single result                          | Return as-is (no merge needed)                         |
| Contiguous merge with results from different sessions        | Do not merge across sessions                           |
| Contiguous merge on results with no sessionId                | Pass through unchanged (non-conversation results)      |
| searchV2 with all new features enabled simultaneously        | All features compose correctly                         |

### Provable Properties

1. **Deduplication invariant:** Context expansion adds neighbors only up to `maxResults`, dropping lowest-scored tail results
2. **Score monotonicity:** Contiguous merge preserves `max(scores)` of merged chunks
3. **Backward compatibility:** Any Episode document missing tiered fields still works with existing code
4. **Fallback guarantee:** LLM extractor ALWAYS produces results (regex fallback on any error); if no llmFn is available, extractor is never created and regex is used implicitly
5. **Chunk coexistence:** `events/{eventId}` paths and `windows/{sessionId}/{windowIndex}` paths are disjoint

### Purity Boundary Map

| Function                       | Pure? | Side Effects                                                 |
| ------------------------------ | ----- | ------------------------------------------------------------ |
| `mergeContiguousChunks()`      | YES   | None                                                         |
| `buildConversationWindows()`   | YES   | None                                                         |
| `buildTieredSummaryPrompt()`   | YES   | None                                                         |
| `expandSearchContext()`        | NO    | Reads from events collection (1 batched query per expansion) |
| `projectConversationWindows()` | NO    | Writes to chunks collection                                  |
| `LLMEntityExtractor.extract()` | NO    | Calls LLM API (5s timeout)                                   |

### Verification Strategy

- Unit tests for all pure functions (property-based where applicable)
- Integration tests for DB-touching functions (mock Db)
- E2E tests against real MongoDB for full-path validation
- Run `pnpm test` (full suite) after each phase to confirm no regressions

---

## Relevant Codebase Files

### Core Files to Modify

- `src/memory/mongodb-manager.ts` (searchV2 at line ~2647, writeEventAndProject at line ~2420, class write path at line ~2308)
- `src/memory/mongodb-events.ts` (projectEventChunk at line 327 — add sessionId/timestamp to chunk doc)
- `src/memory/mongodb-episodes.ts` (Episode type at line 24, EpisodeSummarizer type at line 45, materializeEpisode destructuring at line 175)
- `src/memory/mongodb-entity-extractor.ts` (LLMEntityExtractor at line 191 — already built, no changes needed)
- `src/config/types.memory.ts` (MemoryMongoDBConfig — add config flags)
- `src/memory/backend-config.ts` (config resolution — add defaults)
- `src/memory/types.ts` (MemorySearchResult — add optional `sessionId` field)
- `src/memory/index.ts` (barrel exports — add new symbols)
- `src/memory/production-readiness.e2e.test.ts` (new Phase 17-21 test blocks)

### New Files to Create

- `src/memory/mongodb-contiguous-merge.ts` (pure merge function)
- `src/memory/mongodb-contiguous-merge.test.ts`
- `src/memory/mongodb-context-expansion.ts` (neighbor expansion)
- `src/memory/mongodb-context-expansion.test.ts`
- `src/memory/mongodb-conversation-windows.ts` (window builder + projection)
- `src/memory/mongodb-conversation-windows.test.ts`
- `src/memory/mongodb-tiered-summary.ts` (tiered summarizer wrapper)
- `src/memory/mongodb-tiered-summary.test.ts`

### Patterns to Follow

- `src/memory/mongodb-events.ts:327-370` (projectEventChunk pattern for chunk writes)
- `src/memory/mongodb-manager.ts:2647-3143` (searchV2 path execution pattern)
- `src/memory/mongodb-hybrid.ts:135-220` (mergeHybridResultsMongoDB for merge pattern)
- `src/memory/mongodb-entity-extractor.ts:191-238` (LLMEntityExtractor with timeout + fallback)
- `src/memory/production-readiness.e2e.test.ts:355` (Phase structure for e2e tests)

### Key Code Facts (verified by reviewer)

- The `MongoDBMemoryManager` class has NO `llmFn` field. Config is accessed as `this.config.mongodb!` (not `this.resolvedConfig`).
- `MemorySearchResult` at `src/memory/types.ts:5-16` has NO `sessionId` field — must be added.
- Chunk documents stored by `projectEventChunk` have NO `sessionId` — must be added.
- `materializeEpisode` destructures at line 175: `const { title, summary, tags } = await summarizer(...)` — must change to full assignment to capture tiered fields.
- searchV2 pipeline order: path execution → deduplication (line ~3020) → RRF normalization (lines ~3081-3098) → heuristic rerank (line ~3101) → cross-encoder → final.
- Existing e2e file has Phases 1-14 and 16 (Phase 15 unused). New phases start at 17.

---

## Phase Plan (5 Implementation + 1 Integration)

### Phase 0: Schema Foundation (Prerequisite)

**Objective:** Add `sessionId` and `timestamp` fields to chunk documents and `MemorySearchResult` so that Phases 2-3 (contiguous merge, context expansion) can determine session identity without extra DB lookups.

**Risk:** Low (additive optional fields; existing chunks without sessionId continue working)

**Files:**

- Modify: `src/memory/types.ts:5-16` (add optional `sessionId?: string` and `timestamp?: Date` to `MemorySearchResult`)
- Modify: `src/memory/mongodb-events.ts:339-354` (add `sessionId` and `timestamp` to `$setOnInsert` in `projectEventChunk`)
- Modify: `src/memory/mongodb-manager.ts:2829-2841` (raw-window path mapping — include `sessionId` in result)
- Modify: `src/memory/mongodb-search.ts` (toSearchResult function — pass through `sessionId` if present in chunk doc)
- No new e2e test needed (verified by Phase 6 integration)

**Step 1: Add fields to MemorySearchResult**

In `src/memory/types.ts`, add optional fields:

```typescript
export type MemorySearchResult = {
  // ... existing fields ...
  sessionId?: string; // session the chunk belongs to (for contiguous merge / context expansion)
  timestamp?: Date; // event timestamp (for ordering in merge/expansion)
};
```

**Step 2: Store sessionId in chunk documents**

In `src/memory/mongodb-events.ts:projectEventChunk`, add to `$setOnInsert`:

```typescript
$setOnInsert: {
  path,
  text,
  hash,
  source: "conversation",
  agentId: event.agentId,
  scope: event.scope,
  scopeRef: event.scopeRef,
  updatedAt: new Date(),
  // NEW: store session/timestamp for merge and expansion
  ...(event.sessionId && { sessionId: event.sessionId }),
  timestamp: event.timestamp,
},
```

**Step 3: Pass sessionId through `toSearchResult` (hybrid/vector/keyword paths)**

In `src/memory/mongodb-search.ts:71-82`, modify `toSearchResult` to propagate `sessionId` and `timestamp` from chunk documents:

```typescript
function toSearchResult(doc: Document, source: LegacyMemorySource): MemorySearchResult {
  const sourceType = mapLegacySourceToRuntime(doc.source ?? source);
  return {
    path: typeof doc.path === "string" ? doc.path : "",
    startLine: typeof doc.startLine === "number" ? doc.startLine : 0,
    endLine: typeof doc.endLine === "number" ? doc.endLine : 0,
    score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
    snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
    source: sourceType,
    sourceType,
    // NEW: propagate session/timestamp from chunk doc (added in Phase 0 Step 2)
    ...(typeof doc.sessionId === "string" && { sessionId: doc.sessionId }),
    ...(doc.timestamp instanceof Date && { timestamp: doc.timestamp }),
  };
}
```

This covers ALL hybrid/vector/keyword search results automatically since they all go through `toSearchResult`.

**Step 4: Pass sessionId in raw-window path mapping**

In the raw-window path of searchV2 (`mongodb-manager.ts:2829-2841`), add `sessionId` and `timestamp`:

```typescript
pathResults = recentFirst.map((e, i) => ({
  canonicalId: e.eventId,
  path: `events/${e.eventId}`,
  filePath: `events/${e.eventId}`,
  startLine: 0,
  endLine: 0,
  snippet: e.body,
  score: 1 - i * 0.01,
  source: "conversation" as MemorySource,
  sourceType: "conversation" as MemorySource, // consistency with toSearchResult
  sessionId: e.sessionId,
  timestamp: e.timestamp,
}));
```

**Step 5: Scope note for graph/episodic paths**

The `graph` path produces results from entity expansion (not event chunks) and the `episodic` path produces episode summaries. Neither produces event-based chunks with `events/` path prefix. Context expansion and contiguous merge already filter on `events/` path prefix, so these paths are **automatically excluded** — no code change needed.

**Step 6: Add index for context expansion queries**

In `src/memory/mongodb-schema.ts`, add to the events collection indexes:

```typescript
{ key: { agentId: 1, sessionId: 1, timestamp: 1 }, name: "idx_events_agent_session_ts" }
```

**Note:** An existing index `idx_events_session_ts` at `mongodb-schema.ts:1129-1132` covers `{sessionId: 1, timestamp: -1}` (sparse). The new index adds `agentId` as prefix, which is needed for multi-agent scoped queries (context expansion always filters by agentId for safety). Both indexes are needed — the existing one serves session-only lookups, the new one serves agent-scoped neighbor queries.

This supports the batched neighbor lookup in Phase 3 (context expansion queries events by agentId + sessionId + timestamp range).

**Step 8: Update CHUNKS_SCHEMA validator**

In `src/memory/mongodb-schema.ts:404-424`, add optional properties to CHUNKS_SCHEMA:

```typescript
sessionId: { bsonType: "string" },
timestamp: { bsonType: "date" },
windowIndex: { bsonType: "int" },
```

This ensures chunk documents with the new fields pass schema validation. While `validationLevel: "moderate"` only validates updates to existing docs, keeping the schema complete prevents issues if validation level is ever changed.

**Step 9: Export renderEventChunkText**

In `src/memory/mongodb-events.ts:31`, add `export` keyword:

```typescript
// BEFORE:
function renderEventChunkText(event: Pick<CanonicalEvent, "role" | "body">): string {
// AFTER:
export function renderEventChunkText(event: Pick<CanonicalEvent, "role" | "body">): string {
```

Add to barrel `src/memory/index.ts`:

```typescript
export { renderEventChunkText } from "./mongodb-events.js";
```

This is needed by Phase 3 (context expansion) to render neighbor events consistently with chunk text.

**Step 10: Run existing tests**

Run: `pnpm test -- src/memory/`
Expected: All existing tests PASS (fields are optional, no breaking changes)

**Required checks:** No TS errors introduced, all existing tests pass
**Exit criteria:** `MemorySearchResult` has optional `sessionId` and `timestamp`; chunk docs store `sessionId` when available

---

### Phase 1: Wire LLM Entity Extractor (Gap 2)

**Objective:** Pass `LLMEntityExtractor` to `extractAndUpsertEntities` when config says `method: "llm"`. Currently the extractor option exists but is never passed with an LLM extractor.

**Risk:** Low (LLMEntityExtractor is fully built with timeout + regex fallback; config defaults to "regex")

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (class — add optional `llmFn` to constructor/create params; add `entityExtractor` private field; pass at line ~2308)
- Modify: `src/memory/mongodb-manager.ts:2474-2487` (standalone writeEventAndProject — already accepts `options?.extractor`, no change needed)
- Test: `src/memory/mongodb-manager.test.ts` (unit test for extractor wiring)
- Test: `src/memory/production-readiness.e2e.test.ts` (new Phase 17 block)

**Step 1: Add llmFn to MongoDBMemoryManager**

The class constructor/create params currently have NO `llmFn` field (verified: constructor at line ~374, `create()` at line ~406). Add:

```typescript
// In the create() factory or constructor params:
llmFn?: (prompt: string) => Promise<string>;
```

Store as private field:

```typescript
private entityExtractor?: EntityExtractor;
```

In init, after config is resolved:

```typescript
const mongoCfg = this.config.mongodb!;
if (mongoCfg.graph?.entityExtraction?.method === "llm" && this.llmFn) {
  this.entityExtractor = new LLMEntityExtractor(
    this.llmFn,
    mongoCfg.graph.entityExtraction.timeoutMs ?? 5000,
  );
}
// If method === "llm" but no llmFn available: entityExtractor stays undefined
// → extractAndUpsertEntities falls back to default RegexEntityExtractor
```

**IMPORTANT:** Config access is `this.config.mongodb!` (NOT `this.resolvedConfig` which does not exist).

**Step 2: Pass extractor at class write path (line ~2308)**

Change:

```typescript
.extractAndUpsertEntities({
  db: this.db,
  prefix: this.prefix,
  agentId: this.agentId,
  eventContent: event.body,
  scope,
  scopeRef: written.scopeRef,
  sourceEventId: written.eventId,
})
```

To:

```typescript
.extractAndUpsertEntities({
  db: this.db,
  prefix: this.prefix,
  agentId: this.agentId,
  eventContent: event.body,
  scope,
  scopeRef: written.scopeRef,
  sourceEventId: written.eventId,
  extractor: this.entityExtractor,
  role: event.role, // BUGFIX: role was already accepted by extractAndUpsertEntities (graph.ts:996) but never passed from the class path
})
```

**Step 3: Write unit tests**

Test that:

1. When config `graph.entityExtraction.method === "regex"` (default), `entityExtractor` field is undefined → regex used
2. When config `graph.entityExtraction.method === "llm"` and llmFn is provided in constructor, `LLMEntityExtractor` is created and passed to `extractAndUpsertEntities`
3. When config `graph.entityExtraction.method === "llm"` but no llmFn provided, `entityExtractor` stays undefined → regex fallback at the creation level (LLMEntityExtractor is never instantiated)

**Step 4: Write e2e test (Phase 17: LLM Entity Extractor Wiring)**

```typescript
describe("Phase 17: LLM Entity Extractor Wiring", () => {
  it("uses LLM extractor when configured and falls back to regex on error", async () => {
    // Use standalone writeEventAndProject with a mock LLM function that returns known entities
    // Verify entities are extracted with extractionMethod: "llm"
  });
  it("defaults to regex extraction when no LLM config", async () => {
    // Use standalone writeEventAndProject without extractor option
    // Verify entities extracted with extractionMethod: "regex"
  });
});
```

**Step 5: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager`
Expected: PASS (existing tests + new tests)

**Required checks:** Unit tests pass, no TS errors introduced
**Exit criteria:** `extractAndUpsertEntities` receives `LLMEntityExtractor` when config says `method: "llm"` and llmFn is available; regex fallback at creation level when no llmFn

---

### Phase 2: Contiguous Merge (Gap 5)

**Objective:** Add a pure post-processing function that merges adjacent chunks from the same session into one block, preserving the highest score.

**Risk:** Low (pure function, applied after all retrieval paths merge)

**Depends on:** Phase 0 (sessionId in MemorySearchResult)

**Files:**

- Create: `src/memory/mongodb-contiguous-merge.ts` (pure function)
- Create: `src/memory/mongodb-contiguous-merge.test.ts` (unit tests)
- Modify: `src/memory/mongodb-manager.ts` (apply merge in searchV2 AFTER cross-encoder rerank at line ~3120, BEFORE final slice at line ~3122)
- Modify: `src/config/types.memory.ts` (add `enableContiguousMerge` config)
- Modify: `src/memory/backend-config.ts` (resolve config with default `true`)
- Modify: `src/memory/index.ts` (export)
- Test: `src/memory/production-readiness.e2e.test.ts` (new Phase 18 block)

**Step 1: Write the pure function**

Create `src/memory/mongodb-contiguous-merge.ts`:

```typescript
import type { MemorySearchResult } from "./types.js";

/**
 * Merge contiguous chunks from the same session into single blocks.
 *
 * Algorithm:
 * 1. Separate results into conversation chunks (path starts with "events/")
 *    and non-conversation results (episodes, kb, structured, etc.)
 * 2. Group conversation chunks by sessionId
 * 3. Within each session group, sort by timestamp ascending
 * 4. Walk sorted results; merge consecutive chunks that are ADJACENT IN TIMESTAMP ORDER
 *    within the same session (any time gap is acceptable — adjacency means consecutive
 *    in the sorted timestamp order of the RETURNED RESULTS, not in the original conversation.
 *    If results T1, T3, T5 are returned (T2, T4 not retrieved), T1-T3 and T3-T5 are adjacent.)
 *    This is intentional: we merge whatever the search returned, not the full conversation.
 * 5. Merged block: max(scores), concatenated snippets (newline-separated), first path
 * 6. Results WITHOUT sessionId pass through unchanged (no merge possible)
 * 7. Return merged + non-conversation results sorted by score descending
 *
 * Properties:
 * - Pure function (no side effects)
 * - Score monotonicity: merged score >= any individual score in block
 * - Results from different sessions are never merged
 * - Non-conversation results pass through unchanged
 * - Results with no sessionId pass through unchanged
 */
export function mergeContiguousChunks(results: MemorySearchResult[]): MemorySearchResult[];
```

**Step 2: Write comprehensive unit tests first (TDD)**

`src/memory/mongodb-contiguous-merge.test.ts`:

```typescript
describe("mergeContiguousChunks", () => {
  it("returns empty array for empty input");
  it("returns single result unchanged");
  it("merges two adjacent chunks from same session");
  it("preserves max score of merged chunks");
  it("does not merge chunks from different sessions");
  it("does not merge non-conversation results (episodes, kb, structured)");
  it("does not merge results without sessionId (passes through unchanged)");
  it("concatenates snippets with newline separator");
  it("handles mixed conversation and non-conversation results");
  it("preserves original order when no merges possible");
  it("merges multiple groups independently");
});
```

**Step 3: Add config flag**

In `src/config/types.memory.ts`, add to `MemoryMongoDBConfig`:

```typescript
/** Enable contiguous chunk merging in search results. Default: true */
enableContiguousMerge?: boolean;
```

In `src/memory/backend-config.ts`, add to the `ResolvedMongoDBConfig` type definition (line ~26-107):

```typescript
// Add to ResolvedMongoDBConfig type:
enableContiguousMerge: boolean;
enableContextExpansion: boolean;
```

And add to the resolution logic:

```typescript
enableContiguousMerge: config.enableContiguousMerge !== false,
enableContextExpansion: config.enableContextExpansion !== false,
```

**IMPORTANT:** `searchV2` is a standalone function that does NOT take `ResolvedMongoDBConfig`. Config flags are passed via `context.searchOptions`. Add to the `searchOptions` type in `mongodb-manager.ts:2658-2674`:

```typescript
searchOptions?: {
  // ... existing fields ...
  enableContiguousMerge?: boolean;  // default true
  enableContextExpansion?: boolean; // default true
};
```

The caller (MongoDBMemoryManager class method at line ~816-830) resolves config and passes flags. This is an explicit step — update the class search method to include:

```typescript
searchOptions: {
  ...existingOptions,
  enableContiguousMerge: mongoCfg.enableContiguousMerge,
  enableContextExpansion: mongoCfg.enableContextExpansion,
}
```

**Step 4: Wire into searchV2**

In `src/memory/mongodb-manager.ts`, insert AFTER cross-encoder rerank (line ~3120, after the `if (rerankCfg?.enabled)` block) and BEFORE the final slice at line ~3122:

```typescript
// Contiguous merge: combine adjacent chunks from same session (AFTER cross-encoder)
// Placed after reranking so cross-encoder evaluates individual chunks, not concatenated blocks.
// Merge is a final presentation step before slicing.
const enableMerge = context.searchOptions?.enableContiguousMerge !== false; // default true
const mergedResults = enableMerge ? mergeContiguousChunks(finalResults) : finalResults;
const sliced = mergedResults.slice(0, maxResults);
```

**Why after cross-encoder:** The Voyage rerank model expects individual document snippets. Merging before reranking would send concatenated multi-turn blocks, confusing the model. Merge is a final presentation step.

**Step 5: Write e2e test (Phase 18: Contiguous Merge)**

```typescript
describe("Phase 18: Contiguous Merge", () => {
  it("merges adjacent conversation chunks from same session in search results", async () => {
    // Write 5 sequential events to same session with sessionId
    // Search, verify merged results have fewer items but concatenated snippets
  });
  it("preserves highest score in merged block", async () => {
    // Write events, search, verify max score preserved
  });
  it("does not merge across different sessions", async () => {
    // Write events to two sessions, search, verify no cross-session merge
  });
});
```

**Step 6: Run tests**

Run: `pnpm test -- src/memory/mongodb-contiguous-merge`
Then: `pnpm test -- src/memory/mongodb-manager`
Expected: All PASS

**Required checks:** Unit tests pass, no TS errors, existing searchV2 tests unaffected
**Exit criteria:** `mergeContiguousChunks` is a tested pure function; wired into searchV2 with config flag

---

### Phase 3: Context Expansion (Gap 1)

**Objective:** After search results come back, fetch neighbor events (N-1, N+1 by timestamp) from the same session for event-based chunks.

**Risk:** Medium (adds DB queries; must respect maxResults)

**Depends on:** Phase 0 (sessionId in MemorySearchResult and chunk docs)

**Files:**

- Create: `src/memory/mongodb-context-expansion.ts` (expansion logic)
- Create: `src/memory/mongodb-context-expansion.test.ts` (unit tests)
- Modify: `src/memory/mongodb-manager.ts` (apply expansion in searchV2 AFTER RRF normalization at line ~3098, BEFORE heuristic rerank at line ~3101)
- Modify: `src/config/types.memory.ts` (add `enableContextExpansion` config)
- Modify: `src/memory/backend-config.ts` (resolve config with default `true`)
- Modify: `src/memory/index.ts` (export)
- Test: `src/memory/production-readiness.e2e.test.ts` (new Phase 19 block)

**Step 1: Write the expansion function**

Create `src/memory/mongodb-context-expansion.ts`:

```typescript
import type { Db } from "mongodb";
import type { MemorySearchResult } from "./types.js";

/**
 * Expand search results by fetching neighbor events (N-1, N+1 by timestamp)
 * from the same session for event-based chunks.
 *
 * Only expands results that have a `sessionId` field and path matching `events/{eventId}`.
 * Results without sessionId are passed through unchanged.
 *
 * Context expansion behavior:
 * - Adds neighbors up to `maxResults`; if adding neighbors would exceed maxResults,
 *   drop the lowest-scored tail results to make room.
 * - Neighbors get a score of `parentScore * 0.95` (slightly below parent).
 * - Deduplicates by path against already-present results.
 *
 * **Prerequisite:** `renderEventChunkText` in `mongodb-events.ts:31` is currently private.
 * Export it so this module can render neighbor events consistently with chunk text.
 * Add to `mongodb-events.ts`: `export function renderEventChunkText(...)` (add `export` keyword).
 * Add to barrel `src/memory/index.ts`.
 *
 * Collection: Queries the EVENTS collection (not chunks) because:
 *   - Events have sessionId natively
 *   - The idx_events_session_timestamp index supports efficient neighbor lookups
 *   - Neighbor text is rendered via renderEventChunkText() for consistency with chunk text
 *
 * Performance: Batches all neighbor lookups. For each unique sessionId in results,
 * queries events collection ONCE with sessionId + timestamp $lt/$gt to find neighbors.
 * Total DB queries: 1 per unique sessionId in results (typically 1-2).
 */
export async function expandSearchContext(params: {
  db: Db;
  prefix: string;
  agentId: string;
  results: MemorySearchResult[];
  maxResults?: number; // cap total results (default: results.length + 10)
  windowSize?: number; // neighbors per side (default: 1 = fetch 1 before + 1 after)
}): Promise<MemorySearchResult[]>;
```

**Step 2: Write unit tests (TDD)**

`src/memory/mongodb-context-expansion.test.ts`:

```typescript
describe("expandSearchContext", () => {
  it("returns original results when no event-based chunks present");
  it("fetches neighbor events for event-based chunks with sessionId");
  it("skips expansion for results without sessionId");
  it("deduplicates neighbors already in results");
  it("assigns neighbor score as parentScore * 0.95");
  it("drops lowest-scored tail when neighbors would exceed maxResults");
  it("handles events at session boundaries (no prior/next)");
  it("respects windowSize parameter");
  it("does not expand non-event results (episodes, kb, etc.)");
  it("batches lookups into minimal DB queries");
});
```

**Step 3: Add config flag**

In `src/config/types.memory.ts`:

```typescript
/** Enable context expansion (fetch neighbor chunks). Default: true */
enableContextExpansion?: boolean;
```

In `src/memory/backend-config.ts`:

```typescript
enableContextExpansion: config.enableContextExpansion !== false,
```

**Step 4: Wire into searchV2**

In `src/memory/mongodb-manager.ts`, insert AFTER RRF normalization + sort (line ~3098) and BEFORE heuristic rerank (line ~3101):

```typescript
// Context expansion: fetch neighbor events for event-based chunks
const enableExpansion = context.searchOptions?.enableContextExpansion !== false; // default true
if (enableExpansion) {
  deduped = await expandSearchContext({
    db,
    prefix,
    agentId,
    results: deduped,
    maxResults: maxResults ?? 20,
  });
}
```

**Why this placement:** Expansion happens AFTER RRF so neighbors inherit post-RRF parent scores (via `parentScore * 0.95`). Neighbors then participate in heuristic rerank (episode boost, diversity) and cross-encoder rerank (individual scoring). Contiguous merge runs AFTER cross-encoder as final presentation.

**Pipeline order (complete):**

1. Path execution → raw results per path
2. Deduplication (line ~3020)
3. RRF normalization (lines ~3081-3098)
4. **Context expansion** (NEW — fetches neighbors, adds to results)
5. Heuristic rerank (line ~3101)
6. Cross-encoder rerank (lines ~3104-3120)
7. **Contiguous merge** (NEW — merges adjacent session chunks)
8. Final slice to maxResults (line ~3122)

**Step 5: Write e2e test (Phase 19: Context Expansion)**

```typescript
describe("Phase 19: Context Expansion", () => {
  it("expands event-based search results with neighbor chunks from same session", async () => {
    // Write 5 sequential events with sessionId
    // Search for middle event
    // Verify neighbors appear in results
  });
  it("does not duplicate already-present chunks", async () => {
    // Write events, search returning events 2 and 3
    // Verify expansion does not duplicate event 3 when expanding event 2
  });
  it("handles edge events at session boundary", async () => {
    // Search for first event in session
    // Verify only next neighbor is added (no prior)
  });
});
```

**Step 6: Run tests**

Run: `pnpm test -- src/memory/mongodb-context-expansion`
Then: `pnpm test -- src/memory/mongodb-manager`
Expected: All PASS

**Required checks:** Unit tests pass, no TS errors, result count respects maxResults, no duplicate paths
**Exit criteria:** Search results include neighbor context; deduplication works; config flag controls behavior

---

### Phase 4: Conversation Window Chunks (Gap 3)

**Objective:** Add a second chunk type: 5-7 turn conversation windows with 2-turn overlap, stored alongside existing 1:1 event chunks.

**Risk:** Medium (new chunk type in chunks collection; must coexist with `events/{eventId}` chunks)

**Files:**

- Create: `src/memory/mongodb-conversation-windows.ts` (window builder + projection)
- Create: `src/memory/mongodb-conversation-windows.test.ts` (unit tests)
- Modify: `src/memory/mongodb-manager.ts` — wire into BOTH:
  - Class `addMemory` path (line ~2290-2330) — fire-and-forget after entity extraction
  - Standalone `writeEventAndProject` (line ~2420-2512) — add to options
- Modify: `src/config/types.memory.ts` (add `enableConversationWindows`, `conversationWindowSize`, `conversationWindowOverlap` config)
- Modify: `src/memory/backend-config.ts` (resolve config with default `false`)
- Modify: `src/memory/index.ts` (export)
- Test: `src/memory/production-readiness.e2e.test.ts` (new Phase 20 block)

**Step 1: Design the window chunk format**

Window chunks use path format: `windows/{sessionId}/{windowIndex}`
Each window contains 5-7 turns with 2-turn overlap with adjacent windows.

Example for 12 turns in a session:

- Window 0: turns 0-6 (7 turns), path `windows/sess123/0`
- Window 1: turns 4-10 (7 turns, overlaps turns 4-6), path `windows/sess123/1`
- Window 2: turns 8-11 (4 turns, overlaps turns 8-10), path `windows/sess123/2`

**Step 2: Write the pure window builder**

```typescript
export type ConversationWindow = {
  sessionId: string;
  windowIndex: number;
  startTurnIndex: number;
  endTurnIndex: number;
  events: Array<{ eventId: string; role: string; body: string; timestamp: Date }>;
  text: string; // concatenated role-labeled text
};

/**
 * Build conversation windows from a list of session events.
 * Pure function — no DB access.
 */
export function buildConversationWindows(
  sessionId: string,
  events: Array<{ eventId: string; role: string; body: string; timestamp: Date }>,
  windowSize?: number, // default: 7
  overlap?: number, // default: 2
): ConversationWindow[];
```

**Step 3: Write the projection function**

```typescript
/**
 * Project conversation windows into the chunks collection.
 * Each window becomes a chunk at `windows/{sessionId}/{windowIndex}`.
 * Idempotent: uses upsert with path as unique key.
 *
 * Performance note: This re-windows the ENTIRE session on each call.
 * Only call when session has >= 5 events. The caller should gate this
 * with a session event count check or a modulo trigger (e.g., every 5th event).
 */
export async function projectConversationWindows(params: {
  db: Db;
  prefix: string;
  agentId: string;
  sessionId: string;
  scope: MemoryScope;
  scopeRef: string;
  windowSize?: number;
  overlap?: number;
}): Promise<{ windowsCreated: number }>;
```

**Step 4: Write unit tests (TDD)**

```typescript
describe("buildConversationWindows", () => {
  it("returns empty for <5 events");
  it("creates single window for exactly 5-7 events");
  it("creates overlapping windows for >7 events");
  it("overlap is exactly 2 turns");
  it("last window may be smaller than windowSize");
  it("preserves event order within each window");
  it("generates correct text with role labels");
});

describe("projectConversationWindows", () => {
  it("creates window chunks in chunks collection");
  it("uses windows/{sessionId}/{index} path format");
  it("is idempotent (re-projection does not duplicate)");
  it("stores sessionId and windowIndex in chunk metadata");
});
```

**Step 5: Add config flags**

In `src/config/types.memory.ts`:

```typescript
/** Enable conversation window chunks (multi-turn). Default: false (opt-in) */
enableConversationWindows?: boolean;
/** Window size in turns. Default: 7 */
conversationWindowSize?: number;
/** Overlap between adjacent windows in turns. Default: 2 */
conversationWindowOverlap?: number;
```

**Step 6: Wire into BOTH write paths**

**Embedding note:** Window chunks are stored in the same `chunks` collection as event chunks, using the same `text` field format. If the collection has an autoEmbed vector index on `text`, window chunks are automatically embedded and searchable via vector/hybrid search — no extra embedding step needed.

For the CLASS `addMemory` path (line ~2290-2330), after entity extraction (line ~2320):

```typescript
// Fire-and-forget: project conversation windows if enabled
// Gate: only re-window when session has enough events for at least one window
const mongoCfg = this.config.mongodb!;
const windowSize = mongoCfg.conversationWindowSize ?? 7;
if (mongoCfg.enableConversationWindows && event.sessionId) {
  // Gate: only re-window every windowSize events to amortize cost.
  // Uses chunkCount as a cheap proxy — avoids a count query on every write.
  // On first call (chunkCount=0), skip. After windowSize events, trigger.
  // Subsequent triggers: every windowSize events (modulo).
  // This means window projection runs ~once per window, not once per event.
  if (this.chunkCount > 0 && this.chunkCount % windowSize === 0) {
    projectConversationWindows({
      db: this.db,
      prefix: this.prefix,
      agentId: this.agentId,
      sessionId: event.sessionId,
      scope,
      scopeRef: written.scopeRef,
      windowSize: mongoCfg.conversationWindowSize,
      overlap: mongoCfg.conversationWindowOverlap,
    }).catch((err) => {
      log.warn("conversation window projection failed", { error: err });
    });
  } // closes modulo gate
} // closes enableConversationWindows gate
```

For the STANDALONE `writeEventAndProject` (line ~2420-2512), add to `options`:

```typescript
options?: {
  extractor?: EntityExtractor;
  enableConversationWindows?: boolean;
  conversationWindowSize?: number;
  conversationWindowOverlap?: number;
}
```

**Step 7: Interaction note**

Window chunks have paths like `windows/{sessionId}/{windowIndex}`. Context expansion and contiguous merge filter on `events/` path prefix, so window chunks are **automatically excluded** from those features. This is intentional: window chunks are self-contained multi-turn blocks that don't need neighbor expansion or merge.

**Step 8: Write e2e test (Phase 20: Conversation Window Chunks)**

```typescript
describe("Phase 20: Conversation Window Chunks", () => {
  it("creates window chunks alongside event chunks", async () => {
    // Write 10 sequential events to a session
    // Call projectConversationWindows
    // Verify both events/{eventId} and windows/{sessionId}/{index} chunks exist
  });
  it("windows have correct turn boundaries and overlap", async () => {
    // Write 14 events, project windows
    // Verify window 0 has turns 0-6, window 1 has turns 4-10, etc.
  });
  it("window chunks are searchable alongside event chunks", async () => {
    // Write events, project windows
    // Search for content spanning multiple events
    // Verify window chunk appears in results
  });
  it("1:1 event chunks are NOT affected by window projection", async () => {
    // Write events, project windows
    // Verify all events/{eventId} chunks still exist and unchanged
  });
});
```

**Step 8: Run tests**

Run: `pnpm test -- src/memory/mongodb-conversation-windows`
Then: `pnpm test -- src/memory/mongodb-manager`
Expected: All PASS

**Required checks:** Unit tests pass, no TS errors, existing event chunks unaffected, window chunks searchable
**Exit criteria:** Window chunks coexist with event chunks; searchable; config flag controls behavior; opt-in (default false)

---

### Phase 5: 3-Tier Episode Summaries (Gap 4)

**Objective:** Enhance episodes with tiered summaries (short_term, medium_term, long_term) and a topics array, while maintaining backward compatibility with existing single-summary episodes.

**Risk:** Medium (changes Episode type and EpisodeSummarizer; must be backward-compatible)

**Files:**

- Modify: `src/memory/mongodb-episodes.ts:24-38` (Episode type — add optional tiered fields)
- Modify: `src/memory/mongodb-episodes.ts:45-51` (EpisodeSummarizer type — add optional tiered return)
- Modify: `src/memory/mongodb-episodes.ts:175` (**CRITICAL**: change destructuring to full assignment)
- Create: `src/memory/mongodb-tiered-summary.ts` (tiered summarizer wrapper)
- Create: `src/memory/mongodb-tiered-summary.test.ts` (unit tests)
- Modify: `src/memory/index.ts` (export new types)
- Test: `src/memory/production-readiness.e2e.test.ts` (new Phase 21 block)

**Step 1: Extend the Episode type (backward-compatible)**

Add optional fields to `Episode` at `mongodb-episodes.ts:24`:

```typescript
export type Episode = {
  // ... existing fields ...

  // Tiered summaries (optional — backward compatible with single summary)
  shortTermSummary?: string; // 1-2 sentences, immediate context
  mediumTermSummary?: string; // 1 paragraph, session-level context
  longTermSummary?: string; // 2-3 sentences, archival/knowledge extraction
  topics?: string[]; // extracted topic tags for filtering
};
```

**Step 2: Extend the EpisodeSummarizer type**

Add optional tiered fields to the return type:

```typescript
export type EpisodeSummarizer = (
  events: Array<{ role: string; body: string; timestamp: Date }>,
) => Promise<{
  title: string;
  summary: string;
  tags?: string[];
  // Tiered summaries (optional — summarizer may return none, some, or all)
  shortTermSummary?: string;
  mediumTermSummary?: string;
  longTermSummary?: string;
  topics?: string[];
}>;
```

**Step 3: CRITICAL — Change destructuring in materializeEpisode**

At `mongodb-episodes.ts:175`, change:

```typescript
// BEFORE (destructures and drops extra fields):
const { title, summary, tags } = await summarizer(summarizerInput);
```

To:

```typescript
// AFTER (captures full result including tiered fields):
const summarizerResult = await summarizer(summarizerInput);
const { title, summary, tags } = summarizerResult;
```

Then after existing validation, persist tiered fields:

```typescript
const tieredFields: Record<string, unknown> = {};
if (summarizerResult.shortTermSummary !== undefined)
  tieredFields.shortTermSummary = summarizerResult.shortTermSummary;
if (summarizerResult.mediumTermSummary !== undefined)
  tieredFields.mediumTermSummary = summarizerResult.mediumTermSummary;
if (summarizerResult.longTermSummary !== undefined)
  tieredFields.longTermSummary = summarizerResult.longTermSummary;
if (summarizerResult.topics !== undefined && summarizerResult.topics.length > 0)
  tieredFields.topics = summarizerResult.topics;
```

In the existing upsert code at line ~190, spread tiered fields into `setDoc`:

```typescript
const setDoc: Document = {
  type,
  title,
  summary,
  // ... existing fields ...
  ...tieredFields, // NEW: tiered summaries if present
};
```

**Note on existing test summarizers:** Existing mock summarizers (e.g., `testSummarizer` in `production-readiness.e2e.test.ts:264-293`) return `{title, summary, tags}` which is a valid subset of the widened return type. They do NOT need changes — TypeScript accepts a subset of optional fields.

**Step 4: Create tiered summarizer wrapper**

`src/memory/mongodb-tiered-summary.ts`:

```typescript
import type { EpisodeSummarizer } from "./mongodb-episodes.js";

export function buildTieredSummaryPrompt(
  events: Array<{ role: string; body: string; timestamp: Date }>,
): string;

export function parseTieredSummaryResponse(response: string): {
  shortTermSummary: string;
  mediumTermSummary: string;
  longTermSummary: string;
  topics: string[];
} | null;

export function withTieredSummaries(
  baseSummarizer: EpisodeSummarizer,
  llmFn?: (prompt: string) => Promise<string>,
): EpisodeSummarizer;
```

**Step 5: Write unit tests (TDD)**

```typescript
describe("buildTieredSummaryPrompt", () => {
  it("produces prompt with instructions for 3 tiers + topics");
  it("includes event text in prompt");
  it("handles empty events gracefully");
});

describe("parseTieredSummaryResponse", () => {
  it("parses valid JSON response with all tiers");
  it("returns null for malformed response");
  it("handles missing optional fields");
  it("extracts topics array");
});

describe("withTieredSummaries", () => {
  it("returns base summary + tiered fields when LLM succeeds");
  it("returns base summary only when LLM fails");
  it("returns base summary only when no llmFn provided");
});
```

**Step 6: Write e2e test (Phase 21: 3-Tier Episode Summaries)**

```typescript
describe("Phase 21: 3-Tier Episode Summaries", () => {
  it("materializes episode with tiered summaries when summarizer returns them", async () => {
    // Use mock summarizer that returns all tiers
    // Verify episode document has shortTermSummary, mediumTermSummary, longTermSummary, topics
  });
  it("backward compatible: episode with only base summary still works", async () => {
    // Use basic summarizer (no tiers)
    // Verify episode has title + summary, no tiered fields
    // Verify searchEpisodes still finds it
  });
  it("searchEpisodes returns tiered fields when present", async () => {
    // Materialize episode with tiers
    // Search and verify tiered fields in results
  });
  it("existing episodes without tiers are not broken by schema change", async () => {
    // Write old-style episode directly to collection
    // Read it back, verify no errors
  });
});
```

**Step 7: Run tests**

Run: `pnpm test -- src/memory/mongodb-tiered-summary`
Then: `pnpm test -- src/memory/mongodb-episodes`
Expected: All PASS

**Required checks:** Unit tests pass, no TS errors, existing episode tests unaffected, backward compatibility verified
**Exit criteria:** Episodes can have tiered summaries; existing episodes without tiers still work; EpisodeSummarizer is backward-compatible

---

### Phase 6: Integration Validation

**Objective:** Run all existing tests plus new tests to confirm zero regressions. Verify all 5 gaps work together.

**Files:**

- All modified files from Phases 0-5
- `src/memory/production-readiness.e2e.test.ts` (all new Phase 17-21 blocks)

**Step 1: Run full unit test suite**

Run: `pnpm test -- src/memory/`
Expected: All existing tests PASS + all new tests PASS

**Step 2: Run full production-readiness e2e suite**

Run: `MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true" pnpm vitest run --config vitest.e2e.config.ts src/memory/production-readiness.e2e.test.ts --reporter=verbose`
Expected: All existing + new tests PASS

**Step 3: Run build**

Run: `pnpm build`
Expected: Exit 0

**Step 4: Run lint/format**

Run: `pnpm check`
Expected: Clean (or only pre-existing baseline errors)

**Step 5: Add all-features-enabled e2e test**

Add to `production-readiness.e2e.test.ts`:

```typescript
describe("Phase 22: All Features Enabled Integration", () => {
  it("all 5 features compose correctly when enabled simultaneously", async () => {
    // Write 10 events with sessionId to a session
    // Enable: contextExpansion=true, contiguousMerge=true, conversationWindows=true
    // Use LLM extractor with mock function
    // Use tiered summarizer
    // Search and verify: context expanded, contiguous merged, windows exist, entities extracted, episode has tiers
  });
});
```

**Step 6: Verify barrel exports**

Check `src/memory/index.ts` exports all new symbols:

- `mergeContiguousChunks` from `mongodb-contiguous-merge.ts`
- `expandSearchContext` from `mongodb-context-expansion.ts`
- `buildConversationWindows`, `projectConversationWindows`, `type ConversationWindow` from `mongodb-conversation-windows.ts`
- `buildTieredSummaryPrompt`, `parseTieredSummaryResponse`, `withTieredSummaries` from `mongodb-tiered-summary.ts`

**Step 6: Final commit**

```
scripts/committer "memory: integration validation for 5 retrieval improvements" src/memory/index.ts
```

**Required checks:** Full test suite, build, lint
**Checkpoint type:** Manual (final validation)
**Exit criteria:** All tests pass, build clean, all new symbols exported

---

## Acceptance Checks

1. `pnpm test -- src/memory/` — all existing + new unit tests PASS
2. `pnpm vitest run --config vitest.e2e.config.ts src/memory/production-readiness.e2e.test.ts` — all existing + new e2e tests PASS
3. `pnpm build` — exit 0
4. `pnpm check` — clean (pre-existing baseline only)
5. LLM Extractor: config `graph.entityExtraction.method: "llm"` + llmFn → LLMEntityExtractor used
6. Contiguous Merge: adjacent session chunks merged in search results (uses sessionId from chunk doc)
7. Context Expansion: neighbor events fetched for event-based search hits (uses sessionId from chunk doc)
8. Conversation Windows: `windows/{sessionId}/{index}` chunks created alongside `events/{eventId}` chunks
9. Tiered Episodes: episodes with `shortTermSummary`, `mediumTermSummary`, `longTermSummary`, `topics` fields

## Risks And Mitigations

| Risk                                             | Probability | Impact | Score | Mitigation                                                                  |
| ------------------------------------------------ | ----------- | ------ | ----- | --------------------------------------------------------------------------- |
| Context expansion adds latency to search         | 3           | 2      | 6     | Config flag (default true); batched queries; measure in telemetry           |
| Conversation window projection slows writes      | 2           | 3      | 6     | Default false (opt-in); fire-and-forget with catch; gate on event count     |
| LLM extractor timeout affects write latency      | 2           | 2      | 4     | 5s timeout built into LLMEntityExtractor; regex fallback; no llmFn = no LLM |
| Contiguous merge changes search result count     | 2           | 3      | 6     | Pure function with clear invariants; unit-tested; sessionId-based grouping  |
| Tiered summary breaks existing episode consumers | 1           | 4      | 4     | All new fields optional; backward-compatible; destructuring fix explicit    |
| Cross-feature interaction bugs                   | 2           | 3      | 6     | Phase 6 integration validation; all features compose at searchV2 level      |
| sessionId missing on legacy chunks               | 2           | 2      | 4     | All new features handle missing sessionId gracefully (skip/pass-through)    |

## Summary

- Plan saved: `docs/plans/2026-03-25-memory-retrieval-improvements-plan.md`
- Phases: 7 (1 prerequisite + 5 implementation + 1 integration validation)
- Risks: 7 identified (max score 6, all mitigated)
- Key decisions: All pre-answered (no open decisions)
- New files: 8 (4 modules + 4 test files)
- Modified files: ~9 (manager, events, episodes, types, config, backend-config, index, search, e2e test)
- Expected new tests: ~45-55 unit + ~12-15 e2e

## Recommended Skills for BUILD

- `cc10x:architecture-patterns` (multi-component schema/integration work)
