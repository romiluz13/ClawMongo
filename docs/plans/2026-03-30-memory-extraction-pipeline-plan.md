# Memory Extraction Pipeline Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** See `docs/plans/2026-03-30-memory-extraction-pipeline-design.md` for full specification.
> **Revision:** Plan revised 2026-03-30 after fresh review pass 1. See "Fresh Review Resolution" below.

**Goal:** Wire sync rule-based extraction into `writeEventAndProject()` to populate all 8 retrieval lanes, add lane coverage tracking, make the planner coverage-aware, and update the system prompt to be honest about capabilities.

**Architecture:** Extend the existing `writeEventAndProject()` standalone function in `mongodb-manager.ts` with three additional try/catch-wrapped extraction calls (structured facts via `promoteDerivedMemoryFromEvent()`, entities via `extractAndUpsertEntities()`, episode triggers via `checkAutoEpisodeTriggers()`). Add a new lightweight `mongodb-lane-coverage.ts` module for per-agent lane coverage tracking. Enhance `planRetrieval()` to accept coverage data and skip empty lanes. Update system prompt to reflect automatic extraction.

**Tech Stack:** TypeScript ESM, MongoDB (Community + mongot), Vitest

**Prerequisites:**

- All v2 modules functional (events, graph, episodes, structured-memory, procedures, derived-memory)
- `writeEventAndProject()` exists and writes events + projects chunks + extracts entities (graph only, swallowed `.catch`)
- `extractStructuredCandidatesFromEvent()` exists in `mongodb-derived-memory.ts` but is never called from `writeEventAndProject()`
- `extractProcedureCandidatesFromEvent()` exists in `mongodb-derived-memory.ts` but is never called from `writeEventAndProject()`
- `promoteDerivedMemoryFromEvent()` exists and wraps both structured + procedure extraction with try/catch
- `checkAutoEpisodeTriggers()` exists in `mongodb-episodes.ts` but is never called from `writeEventAndProject()`; returns `Promise<AutoEpisodeTriggerResult>` with `{ triggered: boolean; reason?: string; episode?: Episode }`
- `heuristicEpisodeSummarizer` exists and is already imported in `mongodb-manager.ts`

**Durable Decisions:**

- Extraction is sync rule-based only (no LLM in hot write path)
- Extraction failures NEVER block event writes (each extraction in independent try/catch with log.warn)
- Lane coverage stored as per-agent document with atomic `$inc` updates
- Planner skips lanes with `hasData: false` from coverage
- New collection: `lane_coverage` (1 collection, 1 index on `agentId`)
- Provenance fields on extracted documents: `sourceEventId`, `extractionMethod`, `extractedAt`, `confidence`
- System prompt tells the agent what's automatic vs what requires explicit `memory_write`
- All existing tool APIs (`memory_search`, `memory_write`, `kb_search`, `memory_get`) unchanged
- `kb` lane is populated by a separate ingestion path (not `writeEventAndProject`). Planner must NOT skip `kb` based on lane coverage alone -- it is added to `NEVER_SKIP_LANES` alongside `hybrid` and `raw-window`.

---

## Fresh Review Resolution

**Review pass 1 applied. Findings resolved as follows:**

### BLOCKING (fixed)

- **Episodic lane coverage never incremented.** Phase 3 now captures the `AutoEpisodeTriggerResult` return value from `checkAutoEpisodeTriggers` into an `episodeTriggered` boolean. Phase 4 now includes `episodic` in the lane coverage increments block when `episodeTriggered === true`. Phase 8 E2E test for `lanes.episodic.hasData === true` is now consistent with the increment logic.

### ADVISORY (fixed)

1. **Phase 4 barrel import:** Added comment noting `extractStructuredCandidatesFromEvent` and `extractProcedureCandidatesFromEvent` are imported directly (bypassing the barrel) because they are pure functions used for coverage counting, not part of the external API surface.
2. **Active-critical gate:** Fixed. The active-critical gate now uses `candidates.length > 0` (from re-extraction via pure function) instead of `structuredCreated > 0` (upsert count). This correctly handles repeated facts where upsert count = 0 but data exists.
3. **Phase 6 replace ambiguity:** Made explicit which existing lines to replace in `buildMongoDBBridgeSection` and the Memory Recall section. Added "Replace the existing line..." directives with quoted old text.
4. **Phase 7 redundancy:** Phase 7 merged into Phase 4 (entity refactor happens as part of result capture). Phase 7 is now "Verify-only: confirm all error handling patterns are consistent." No new code changes.
5. **Phase 4 contradictory code blocks:** Removed the abandoned first approach (lines 459-545 in the original plan). Only the authoritative "Final lane coverage block" remains.

---

## Codebase Reality Check

- **Verified files / surfaces:**
  - `src/memory/mongodb-manager.ts:2598-2712` -- `writeEventAndProject()` currently writes event, projects chunk, and calls `extractAndUpsertEntities` with `.catch()` swallowing errors. No structured/procedure extraction. No episode triggers. No lane coverage.
  - `src/memory/mongodb-derived-memory.ts:153-274` -- `extractStructuredCandidatesFromEvent()` is a pure function (no DB calls). Returns `StructuredMemoryEntry[]` with `salience` field.
  - `src/memory/mongodb-derived-memory.ts:314-355` -- `extractProcedureCandidatesFromEvent()` is a pure function. Returns `ProcedureEntry[]`.
  - `src/memory/mongodb-derived-memory.ts:357-452` -- `promoteDerivedMemoryFromEvent()` wraps both structured + procedure extraction with independent try/catch. Returns `{ structuredCreated, proceduresCreated }`.
  - `src/memory/mongodb-graph.ts:987-1268` -- `extractAndUpsertEntities()` returns `{ entities, relationsCreated }`. Uses `RegexEntityExtractor` by default.
  - `src/memory/mongodb-episodes.ts:533-663` -- `checkAutoEpisodeTriggers()` requires `summarizer` param. `heuristicEpisodeSummarizer` is available in `mongodb-derived-memory.ts` and already imported in `mongodb-manager.ts`.
  - `src/memory/mongodb-retrieval-planner.ts:423-562` -- `planRetrieval()` is pure (no DB), takes `RetrievalContext`, returns `RetrievalPlan`. No lane coverage awareness.
  - `src/agents/system-prompt.ts:26-148` -- `buildMongoDBBridgeSection` + Memory Recall section. Currently says nothing about automatic extraction.
  - `src/memory/mongodb-schema.ts:37-127` -- 23 collection helpers, `ensureStandardIndexes` manages all indexes. Current count: 63 standard indexes.
  - `src/memory/mongodb-e2e.e2e.test.ts:63-88` -- `EXPECTED_COLLECTION_SUFFIXES` (23 items), `EXPECTED_STANDARD_INDEX_COUNT` = 63.
  - `src/memory/production-readiness.e2e.test.ts` -- 18 phases (1-18). Next phase number: 19.
  - `src/memory/index.ts` -- barrel exports. `extractStructuredCandidatesFromEvent` and `extractProcedureCandidatesFromEvent` are NOT exported from barrel (only used internally by `promoteDerivedMemoryFromEvent`).

- **Existing patterns / constraints:**
  - Standalone function pattern: `(db, prefix, ...)` -- NOT class methods.
  - Error isolation: each extraction in independent try/catch with `log.warn`.
  - `embeddingMode: "automated"` is the only valid value (mongot handles embeddings).
  - All imports needed for the wiring (`promoteDerivedMemoryFromEvent`, `heuristicEpisodeSummarizer`, `checkAutoEpisodeTriggers`, `mongodbGraph`) are already imported in `mongodb-manager.ts`.
  - KB data is ingested through `ingestKB` / `ingestReference` path, NOT through `writeEventAndProject`. The `kb` lane cannot be tracked by event write coverage.

- **Pressure points / contradictions:**
  - Entity extraction currently uses `.catch()` swallowing pattern (line 2652-2665). Must refactor to try/catch to capture entity count for coverage.
  - `checkAutoEpisodeTriggers` calls `heuristicEpisodeSummarizer` which is sync rule-based (no LLM), but the function comment says "MUST be async (not blocking write path) -- the summarizer is an LLM call." This comment is stale -- the heuristic summarizer is cheap. No contradiction with design.
  - `extractStructuredCandidatesFromEvent` signature expects a `ConversationEvent` type (local to `mongodb-derived-memory.ts`), not `CanonicalEvent`. Must construct the right shape when calling from `writeEventAndProject`.

## Plan-vs-Code Gaps

| Current code / behavior                                                   | Planned change                                   | Gap / risk                                                                           | Plan response                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `writeEventAndProject` only extracts entities (graph)                     | Add structured + procedure + episode extraction  | Entity extraction uses `.catch()`, others will use try/catch -- inconsistent         | Phase 7 refactors entity to try/catch for consistency                            |
| `extractStructuredCandidatesFromEvent` takes `ConversationEvent` type     | Need to call from `writeEventAndProject` context | `ConversationEvent` has `workspaceDir` field not available in `writeEventAndProject` | Pass `undefined` for `workspaceDir` -- field is optional in the structured write |
| `planRetrieval` has no coverage awareness                                 | Add `laneCoverage` to `RetrievalContext`         | Backward compatibility -- existing callers pass no coverage                          | `laneCoverage` is optional. No coverage = no skipping (backward compatible)      |
| `kb` lane populated by separate ingestion                                 | Coverage tracking only knows about event writes  | Planner would skip `kb` even when KB data exists                                     | Add `kb` to `NEVER_SKIP_LANES` -- planner never skips KB based on coverage       |
| System prompt says nothing about automatic extraction                     | Update to describe what's automatic              | Could change agent behavior (more/fewer `memory_write` calls)                        | Change is additive information, not directive change                             |
| `EXPECTED_COLLECTION_SUFFIXES` = 23, `EXPECTED_STANDARD_INDEX_COUNT` = 63 | Add 1 collection + 1 index                       | Constants must be bumped                                                             | Phase 1 bumps to 24 and 64                                                       |

## Assumption Ledger

- **Proven by code:**
  - `promoteDerivedMemoryFromEvent` is imported at `mongodb-manager.ts:19-20` and returns `{ structuredCreated, proceduresCreated }` -- verified by reading source
  - `checkAutoEpisodeTriggers` is imported at `mongodb-manager.ts:24` -- verified
  - `heuristicEpisodeSummarizer` is imported at `mongodb-manager.ts:18` -- verified
  - `extractStructuredCandidatesFromEvent` returns entries with optional `salience` field -- verified at `mongodb-derived-memory.ts:266`
  - `embeddingMode` only valid value is `"automated"` -- verified at `config/types.memory.ts:53`
  - Entity extraction returns `{ entities, relationsCreated }` -- verified at `mongodb-graph.ts:997`
  - Current `EXPECTED_STANDARD_INDEX_COUNT` is 63 -- verified at `mongodb-e2e.e2e.test.ts:88`

- **Inferred:**
  - Lane coverage document at ~500 bytes per agent will not cause storage pressure
  - Double-calling `extractStructuredCandidatesFromEvent` (for coverage + for actual write) is acceptable (<1ms for pure function)
  - `heuristicEpisodeSummarizer` latency is negligible (no LLM, string concatenation only)

- **Needs user confirmation:**
  - None. All decisions are covered by the approved design doc and intent contract.

## Phase Dependency Map

- **Phase 1** (Lane Coverage Module): depends on nothing. Creates `mongodb-lane-coverage.ts` module + schema helper + index. Enables Phase 4 and Phase 5.
- **Phase 2** (Structured/Procedure Extraction Wiring): depends on nothing (uses existing functions). Creates the structured extraction call in `writeEventAndProject`. Enables Phase 4 (structured count capture).
- **Phase 3** (Episode Trigger Wiring): depends on nothing (uses existing functions). Creates the episode trigger call in `writeEventAndProject`. Captures `episodeTriggered` boolean from `AutoEpisodeTriggerResult`. Enables Phase 4 (episodic lane increment) and Phase 8 (e2e episode test).
- **Phase 4** (Entity Refactor + Lane Coverage Wiring): depends on Phase 1 (lane coverage module), Phase 2 (structured extraction wired), Phase 3 (episodeTriggered captured). Refactors entity extraction from `.catch()` to try/catch (capturing `entityCount`). Creates lane coverage updates in `writeEventAndProject` using entityCount, candidate re-extraction for structured/active-critical/procedural, and episodeTriggered for episodic. Enables Phase 5 (planner reads coverage).
- **Phase 5** (Planner Coverage-Aware): depends on Phase 1 (coverage types) and Phase 4 (coverage data exists). Creates coverage-aware planner. Enables Phase 8 (e2e planner test).
- **Phase 6** (System Prompt): depends on nothing. Can run in parallel with Phases 1-5.
- **Phase 7** (Verify Error Handling): depends on Phase 4 (entity refactor). Verify-only -- confirms all extraction blocks use consistent try/catch. No code changes expected.
- **Phase 8** (E2E Tests): depends on ALL prior phases. Validates end-to-end including episodic lane coverage after 55+ events trigger episode materialization.

## Phase Autonomy Classification

| Phase   | Checkpoint Type | Classification | Reason                                                                |
| ------- | --------------- | -------------- | --------------------------------------------------------------------- |
| Phase 1 | none            | AFK            | New module with clear spec, no ambiguity                              |
| Phase 2 | none            | AFK            | Wiring existing function, clear interface                             |
| Phase 3 | none            | AFK            | Wiring existing function, clear interface; captures return value      |
| Phase 4 | none            | AFK            | Entity refactor + mechanical wiring of coverage from captured results |
| Phase 5 | none            | AFK            | Pure function enhancement, backward compatible                        |
| Phase 6 | none            | AFK            | Additive prompt text, no structural change                            |
| Phase 7 | none            | AFK            | Verify-only, no code changes expected                                 |
| Phase 8 | human_verify    | HITL           | E2E requires live MongoDB + manual result inspection                  |

---

## Phase 1: Lane Coverage Module (Foundation)

> **Exit Criteria:** `mongodb-lane-coverage.ts` module exists with `updateLaneCoverage()` and `getLaneCoverage()` functions. Collection helper in schema. 8+ unit tests pass. `pnpm check` PASS.

### Task 1.1: Add lane_coverage collection helper to schema

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (add `laneCoverageCollection()` helper + index in `ensureStandardIndexes`)

**Step 1: Add collection helper function**

After the existing `mutationsCollection` helper (around line 127), add:

```typescript
export function laneCoverageCollection(db: Db, prefix: string): Collection {
  return db.collection(`${prefix}lane_coverage`);
}
```

**Step 2: Add index in `ensureStandardIndexes`**

In the `ensureStandardIndexes` function, add one index for `lane_coverage`:

```typescript
// lane_coverage: unique agentId
{ collection: laneCoverageCollection, index: { agentId: 1 }, options: { unique: true } },
```

**Step 3: Update EXPECTED_COLLECTION_SUFFIXES and EXPECTED_STANDARD_INDEX_COUNT in e2e test**

In `src/memory/mongodb-e2e.e2e.test.ts`:

- Add `"lane_coverage"` to `EXPECTED_COLLECTION_SUFFIXES` array (line ~87)
- Bump `EXPECTED_STANDARD_INDEX_COUNT` from `63` to `64` (1 new index)

**Step 4: Verify**

Run: `pnpm check`
Expected: PASS

### Task 1.2: Create mongodb-lane-coverage.ts module

**Files:**

- Create: `src/memory/mongodb-lane-coverage.ts`
- Create: `src/memory/mongodb-lane-coverage.test.ts`

**Step 1: Write failing tests**

Create `src/memory/mongodb-lane-coverage.test.ts` with these test cases:

1. `updateLaneCoverage increments count for a single lane`
2. `updateLaneCoverage increments multiple lanes atomically`
3. `updateLaneCoverage creates document if none exists (upsert)`
4. `getLaneCoverage returns null for unknown agent`
5. `getLaneCoverage returns coverage document for known agent`
6. `getLaneCoverage returns hasData=true for lanes with count > 0`
7. `getLaneCoverage returns hasData=false for lanes with count 0`
8. `updateLaneCoverage sets lastUpdated timestamp`

Tests should mock `mongodb` collection operations following the existing test pattern (e.g., `mongodb-ops.test.ts`).

**Step 2: Implement mongodb-lane-coverage.ts**

```typescript
import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { laneCoverageCollection } from "./mongodb-schema.js";
import type { RetrievalPath } from "./mongodb-retrieval-planner.js";

const log = createSubsystemLogger("memory:mongodb:lane-coverage");

export type LaneStatus = {
  count: number;
  lastUpdated: Date | null;
  hasData: boolean;
};

export type LaneCoverageDocument = {
  agentId: string;
  lanes: Record<string, LaneStatus>;
  updatedAt: Date;
};

const ALL_LANES: RetrievalPath[] = [
  "active-critical",
  "structured",
  "raw-window",
  "graph",
  "hybrid",
  "kb",
  "episodic",
  "procedural",
];

export function emptyLaneCoverage(): Record<string, LaneStatus> {
  const lanes: Record<string, LaneStatus> = {};
  for (const lane of ALL_LANES) {
    lanes[lane] = { count: 0, lastUpdated: null, hasData: false };
  }
  return lanes;
}

/**
 * Atomically increment lane counters for an agent.
 * Uses $inc for atomic counter updates and upsert for first-time creation.
 */
export async function updateLaneCoverage(params: {
  db: Db;
  prefix: string;
  agentId: string;
  increments: Partial<Record<string, number>>;
}): Promise<void> {
  const { db, prefix, agentId, increments } = params;
  if (Object.keys(increments).length === 0) return;

  const incFields: Record<string, number> = {};
  const setFields: Record<string, unknown> = { updatedAt: new Date() };

  for (const [lane, count] of Object.entries(increments)) {
    if (count && count > 0) {
      incFields[`lanes.${lane}.count`] = count;
      setFields[`lanes.${lane}.lastUpdated`] = new Date();
      setFields[`lanes.${lane}.hasData`] = true;
    }
  }

  if (Object.keys(incFields).length === 0) return;

  const collection = laneCoverageCollection(db, prefix);
  await collection.updateOne(
    { agentId },
    {
      $inc: incFields,
      $set: setFields,
      $setOnInsert: { agentId },
    },
    { upsert: true },
  );
}

/**
 * Get lane coverage for an agent.
 * Returns null if no coverage document exists.
 */
export async function getLaneCoverage(params: {
  db: Db;
  prefix: string;
  agentId: string;
}): Promise<LaneCoverageDocument | null> {
  const { db, prefix, agentId } = params;
  const collection = laneCoverageCollection(db, prefix);
  const doc = await collection.findOne({ agentId });
  if (!doc) return null;
  return doc as unknown as LaneCoverageDocument;
}
```

**Step 3: Run tests**

Run: `pnpm test -- src/memory/mongodb-lane-coverage.test.ts --reporter=verbose`
Expected: 8/8 PASS

**Step 4: Verify build**

Run: `pnpm check`
Expected: PASS

### Task 1.3: Export lane coverage from barrel

**Files:**

- Modify: `src/memory/index.ts`

Add exports:

```typescript
export {
  updateLaneCoverage,
  getLaneCoverage,
  emptyLaneCoverage,
  type LaneCoverageDocument,
  type LaneStatus,
} from "./mongodb-lane-coverage.js";
```

---

## Phase 2: Wire Structured + Procedure Extraction into writeEventAndProject

> **Exit Criteria:** `writeEventAndProject()` calls `promoteDerivedMemoryFromEvent()` after chunk projection. Each extraction wrapped in independent try/catch. 6+ new unit tests pass. `pnpm check` PASS.

### Task 2.1: Write failing tests for structured/procedure extraction wiring

**Files:**

- Modify: `src/memory/mongodb-manager.test.ts`

Add test cases in a new describe block `"writeEventAndProject extraction wiring"`:

1. `writeEventAndProject calls promoteDerivedMemoryFromEvent after chunk projection`
2. `writeEventAndProject succeeds even when promoteDerivedMemoryFromEvent throws`
3. `writeEventAndProject logs warning when structured extraction fails`
4. `writeEventAndProject returns correct eventId and chunksCreated regardless of extraction outcome`
5. `writeEventAndProject passes correct event shape to promoteDerivedMemoryFromEvent`
6. `writeEventAndProject calls extraction with embeddingMode "automated"`

Tests should mock `promoteDerivedMemoryFromEvent` (already imported in mongodb-manager.ts) and verify it is called with expected args. Use `vi.spyOn` or module mock.

**Step 1: Run tests to verify they fail**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts -t "extraction wiring" --reporter=verbose`
Expected: FAIL (promoteDerivedMemoryFromEvent not called)

### Task 2.2: Wire promoteDerivedMemoryFromEvent into writeEventAndProject

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (function `writeEventAndProject`, around line 2651)

**Current state (line 2651-2665):** After `projectEventChunk`, only `extractAndUpsertEntities` is called (with `.catch` swallowing errors).

**Change:** After the existing entity extraction `.catch` block (line 2665), add:

```typescript
// Structured fact + procedure extraction (sync rule-based, non-blocking)
try {
  await promoteDerivedMemoryFromEvent({
    db,
    prefix,
    client: undefined,
    embeddingMode: "automated",
    event: {
      eventId: written.eventId,
      agentId: event.agentId,
      role: event.role as "user" | "assistant" | "system" | "tool",
      body: event.body,
      timestamp: written.timestamp,
      sessionId: event.sessionId,
      scope: event.scope as MemoryScope,
      scopeRef: written.scopeRef,
    },
  });
} catch (err) {
  log.warn("structured/procedure extraction failed during writeEventAndProject", {
    error: err,
    eventId: written.eventId,
  });
}
```

Note: `promoteDerivedMemoryFromEvent` is already imported at line 19. The `embeddingMode: "automated"` is the standard ClawMongo mode (mongot handles embeddings).

**Step 2: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts -t "extraction wiring" --reporter=verbose`
Expected: PASS

**Step 3: Run full manager test suite**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts --reporter=verbose`
Expected: No regressions

---

## Phase 3: Wire Episode Trigger Check into writeEventAndProject

> **Exit Criteria:** `writeEventAndProject()` calls `checkAutoEpisodeTriggers()` after structured extraction. Return value (`AutoEpisodeTriggerResult`) is captured into `episodeTriggered` boolean for Phase 4 lane coverage. Error-isolated. 5+ new unit tests pass. `pnpm check` PASS.

### Task 3.1: Write failing tests for episode trigger wiring

**Files:**

- Modify: `src/memory/mongodb-manager.test.ts`

Add test cases in a new describe block `"writeEventAndProject episode triggers"`:

1. `writeEventAndProject calls checkAutoEpisodeTriggers after extraction`
2. `writeEventAndProject succeeds even when checkAutoEpisodeTriggers throws`
3. `writeEventAndProject passes heuristicEpisodeSummarizer as summarizer`
4. `writeEventAndProject passes correct agentId and scope to episode trigger check`
5. `writeEventAndProject captures triggered=true from checkAutoEpisodeTriggers result`

### Task 3.2: Wire checkAutoEpisodeTriggers into writeEventAndProject

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (function `writeEventAndProject`)

After the structured/procedure extraction try/catch (added in Phase 2), add:

**CRITICAL:** The `checkAutoEpisodeTriggers` return type is `AutoEpisodeTriggerResult = { triggered: boolean; reason?: string; episode?: Episode }`. The return value MUST be captured so Phase 4 can increment the episodic lane in coverage when `triggered === true`.

```typescript
// Episode trigger check (sync, non-blocking)
// MUST capture result: episodeTriggered drives episodic lane coverage in Phase 4.
let episodeTriggered = false;
try {
  const episodeResult = await checkAutoEpisodeTriggers({
    db,
    prefix,
    agentId: event.agentId,
    summarizer: heuristicEpisodeSummarizer,
    scope: event.scope as MemoryScope,
    scopeRef: written.scopeRef,
  });
  episodeTriggered = episodeResult.triggered;
} catch (err) {
  log.warn("episode trigger check failed during writeEventAndProject", {
    error: err,
    eventId: written.eventId,
  });
}
```

Note: `checkAutoEpisodeTriggers` is already imported at line 24. `heuristicEpisodeSummarizer` is already imported at line 18. The `episodeTriggered` variable is declared OUTSIDE the try/catch so it is accessible in Phase 4's lane coverage block.

**Step 1: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts -t "episode triggers" --reporter=verbose`
Expected: PASS

---

## Phase 4: Refactor Entity Extraction + Wire Lane Coverage Updates into writeEventAndProject

> **Exit Criteria:** Entity extraction refactored from `.catch()` to try/catch (capturing `entityCount`). `writeEventAndProject()` calls `updateLaneCoverage()` after all extractions. Increments correct lanes (including episodic from Phase 3's `episodeTriggered`). Active-critical gate uses candidate count from re-extraction (not upsert count). 7+ new unit tests pass. `pnpm check` PASS.

### Task 4.1: Refactor entity extraction from .catch to try/catch

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (function `writeEventAndProject`)

**This replaces what was previously Phase 7.** Change the existing entity extraction (around line 2652-2665) from the `.catch()` pattern to try/catch, capturing the result:

Replace:

```typescript
    await mongodbGraph
      .extractAndUpsertEntities({ ... })
      .catch((projErr) => {
        log.warn("entity projection failed during writeEventAndProject", { error: projErr });
      });
```

With:

```typescript
// Entity extraction (sync rule-based, non-blocking)
let entityCount = 0;
try {
  const entityResult = await mongodbGraph.extractAndUpsertEntities({
    db,
    prefix,
    agentId: event.agentId,
    eventContent: event.body,
    scope: event.scope as MemoryScope,
    scopeRef: written.scopeRef,
    sourceEventId: written.eventId,
    extractor: options?.extractor,
  });
  entityCount = entityResult.entities.length;
} catch (err) {
  log.warn("entity extraction failed during writeEventAndProject", {
    error: err,
    eventId: written.eventId,
  });
}
```

This removes the last swallowed `.catch(() => {})` in `writeEventAndProject` and captures `entityCount` for lane coverage.

### Task 4.2: Capture structured/procedure counts from promoteDerivedMemoryFromEvent

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (function `writeEventAndProject`)

Also refactor the Phase 2 wiring to capture the returned counts:

```typescript
// Structured fact + procedure extraction (sync rule-based, non-blocking)
let structuredCreated = 0;
let proceduresCreated = 0;
try {
  const derivedResult = await promoteDerivedMemoryFromEvent({
    db,
    prefix,
    client: undefined,
    embeddingMode: "automated",
    event: {
      eventId: written.eventId,
      agentId: event.agentId,
      role: event.role as "user" | "assistant" | "system" | "tool",
      body: event.body,
      timestamp: written.timestamp,
      sessionId: event.sessionId,
      scope: event.scope as MemoryScope,
      scopeRef: written.scopeRef,
    },
  });
  structuredCreated = derivedResult.structuredCreated;
  proceduresCreated = derivedResult.proceduresCreated;
} catch (err) {
  log.warn("structured/procedure extraction failed during writeEventAndProject", {
    error: err,
    eventId: written.eventId,
  });
}
```

### Task 4.3: Write failing tests for lane coverage wiring

**Files:**

- Modify: `src/memory/mongodb-manager.test.ts`

Add test cases in a new describe block `"writeEventAndProject lane coverage"`:

1. `writeEventAndProject updates lane coverage for raw-window and hybrid after event write`
2. `writeEventAndProject updates lane coverage for structured lane when facts extracted`
3. `writeEventAndProject updates lane coverage for graph lane when entities extracted`
4. `writeEventAndProject updates lane coverage for episodic lane when episode triggered`
5. `writeEventAndProject does not increment structured lane when no facts extracted`
6. `writeEventAndProject does not increment episodic lane when episode not triggered`
7. `writeEventAndProject succeeds even when updateLaneCoverage throws`

### Task 4.4: Wire updateLaneCoverage into writeEventAndProject

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

Add imports at top:

```typescript
import { updateLaneCoverage } from "./mongodb-lane-coverage.js";
// Direct import: extractStructuredCandidatesFromEvent is a pure function used for
// coverage salience counting. It is NOT part of the external barrel API surface
// (src/memory/index.ts does not export it). This is intentional -- coverage counting
// is an internal concern of writeEventAndProject, not an external consumer.
import {
  extractStructuredCandidatesFromEvent,
  extractProcedureCandidatesFromEvent,
} from "./mongodb-derived-memory.js";
```

After episode trigger try/catch (Phase 3), add the lane coverage update block.

**IMPORTANT design notes for this block:**

- `structuredCreated` from `promoteDerivedMemoryFromEvent` counts **upserts** (new or changed facts), NOT candidates. For repeated facts, upsert returns `upserted: false` so `structuredCreated` can be 0 even when structured data was found.
- The **active-critical gate** therefore uses candidate count from re-extraction (pure function, <1ms) rather than `structuredCreated`. This correctly tracks that active-critical data EXISTS for this agent, even if it was already stored.
- `episodeTriggered` is the boolean captured in Phase 3 from `checkAutoEpisodeTriggers`.

```typescript
// Lane coverage tracking (non-blocking)
try {
  const increments: Record<string, number> = {
    "raw-window": 1, // every event populates raw-window
    hybrid: projected.chunkCreated ? 1 : 0,
  };
  if (entityCount > 0) {
    increments.graph = entityCount;
  }
  // Structured lane: use candidate count from re-extraction (pure function),
  // NOT structuredCreated (upsert count). Reason: for repeated facts,
  // upsert count = 0 but data exists. Coverage tracks data availability,
  // not novelty. Pure function call is <1ms, safe to call twice.
  const candidates = extractStructuredCandidatesFromEvent({
    eventId: written.eventId,
    agentId: event.agentId,
    role: event.role as "user" | "assistant" | "system" | "tool",
    body: event.body,
    timestamp: written.timestamp,
    sessionId: event.sessionId,
    scope: event.scope as MemoryScope,
    scopeRef: written.scopeRef,
  });
  if (candidates.length > 0) {
    increments.structured = candidates.length;
  }
  // Active-critical: check candidates for salience (same re-extraction, no extra call)
  const criticalCount = candidates.filter(
    (c) => c.salience === "critical" || c.salience === "high",
  ).length;
  if (criticalCount > 0) {
    increments["active-critical"] = criticalCount;
  }
  // Procedure lane: use candidate count from re-extraction
  const procedureCandidates = extractProcedureCandidatesFromEvent({
    eventId: written.eventId,
    agentId: event.agentId,
    role: event.role as "user" | "assistant" | "system" | "tool",
    body: event.body,
    timestamp: written.timestamp,
    sessionId: event.sessionId,
    scope: event.scope as MemoryScope,
    scopeRef: written.scopeRef,
  });
  if (procedureCandidates.length > 0) {
    increments.procedural = procedureCandidates.length;
  }
  // Episodic lane: from Phase 3's captured checkAutoEpisodeTriggers result
  if (episodeTriggered) {
    increments.episodic = 1;
  }
  await updateLaneCoverage({
    db,
    prefix,
    agentId: event.agentId,
    increments,
  });
} catch (err) {
  log.warn("lane coverage update failed during writeEventAndProject", {
    error: err,
    eventId: written.eventId,
  });
}
```

**Step 1: Run tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts -t "lane coverage" --reporter=verbose`
Expected: PASS

**Step 2: Run full check**

Run: `pnpm check`
Expected: PASS

---

## Phase 5: Make Planner Coverage-Aware

> **Exit Criteria:** `planRetrieval()` accepts optional `laneCoverage` parameter. Skips lanes with `hasData: false`. Reports coverage in plan reasoning. 8+ new unit tests pass. `pnpm check` PASS.

### Task 5.1: Write failing tests for coverage-aware planner

**Files:**

- Modify: `src/memory/mongodb-retrieval-planner.test.ts`

Add test cases in a new describe block `"planRetrieval with lane coverage"`:

1. `planRetrieval skips lanes with hasData=false when coverage provided`
2. `planRetrieval includes all lanes when no coverage provided (backward compatible)`
3. `planRetrieval does not skip hybrid lane even with hasData=false (backstop)`
4. `planRetrieval does not skip raw-window lane even with hasData=false (always has events)`
5. `planRetrieval does not skip kb lane even with hasData=false (separate ingestion path)`
6. `planRetrieval includes coverage note in reasoning when lanes skipped`
7. `planRetrieval returns skippedLanes in plan`
8. `planRetrieval skips episodic lane when episodes hasData=false`
9. `planRetrieval skips graph lane when graph hasData=false`

### Task 5.2: Add laneCoverage parameter to RetrievalContext and planRetrieval

**Files:**

- Modify: `src/memory/mongodb-retrieval-planner.ts`

**Step 1: Extend RetrievalContext type** (around line 63):

```typescript
export type RetrievalContext = {
  /** Available sources based on config */
  availablePaths: Set<RetrievalPath>;
  /** Known entity names for graph matching */
  knownEntityNames?: string[];
  /** Whether episodes exist */
  hasEpisodes?: boolean;
  /** Whether graph has entities */
  hasGraphData?: boolean;
  /** Lane coverage data for skipping empty lanes */
  laneCoverage?: Record<string, { hasData: boolean; count: number; lastUpdated: Date | null }>;
};
```

**Step 2: Add coverage-based filtering in planRetrieval** (after score computation, before the `sorted` line at ~513):

```typescript
// Coverage-aware lane filtering: skip lanes known to be empty
// Exception: hybrid, raw-window, and kb are never skipped.
// hybrid/raw-window are backstop lanes (always have data after any event write).
// kb is populated by a separate ingestion path, not writeEventAndProject,
// so lane coverage has no signal for it.
const NEVER_SKIP_LANES = new Set<RetrievalPath>(["hybrid", "raw-window", "kb"]);
const skippedLanes: string[] = [];
if (context.laneCoverage) {
  for (const [path, score] of Object.entries(scores) as [RetrievalPath, number][]) {
    if (NEVER_SKIP_LANES.has(path)) continue;
    const coverage = context.laneCoverage[path];
    if (coverage && !coverage.hasData) {
      scores[path] = -1; // Mark for exclusion
      skippedLanes.push(path);
    }
  }
  if (skippedLanes.length > 0) {
    reasons.push(`skipped empty lanes: ${skippedLanes.join(", ")}`);
  }
}
```

Then in the `sorted` filter, also exclude negative scores:

```typescript
    const sorted = (Object.entries(scores) as [RetrievalPath, number][])
      .filter(([path, score]) => context.availablePaths.has(path) && score >= 0)
      .toSorted(...)
```

**Step 3: Add coverage metadata to RetrievalPlan type:**

```typescript
export type RetrievalPlan = {
  paths: RetrievalPath[];
  classification: "direct" | "family" | "comparison" | "temporal" | "scoped" | "multi-hop";
  confidence: "high" | "medium" | "low";
  reasoning: string;
  constraints?: RetrievalConstraints;
  skippedLanes?: string[];
};
```

**Step 4: Return skippedLanes in the plan:**

```typescript
    return {
      paths: finalPaths,
      classification,
      confidence,
      reasoning: ...,
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
      ...(skippedLanes.length > 0 ? { skippedLanes } : {}),
    };
```

**Step 5: Run tests**

Run: `pnpm test -- src/memory/mongodb-retrieval-planner.test.ts --reporter=verbose`
Expected: PASS (all existing + 8 new)

### Task 5.3: Wire coverage into searchV2

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (function `searchV2`, around line 2938)

Before the `planRetrieval` call, load lane coverage:

```typescript
// Load lane coverage for planner (non-blocking: fallback to no coverage on error)
let laneCoverage:
  | Record<string, { hasData: boolean; count: number; lastUpdated: Date | null }>
  | undefined;
try {
  const coverageDoc = await getLaneCoverage({ db, prefix, agentId });
  if (coverageDoc) {
    laneCoverage = coverageDoc.lanes;
  }
} catch (err) {
  log.warn("Failed to load lane coverage for planner", { error: err, agentId });
}
```

Add import:

```typescript
import { getLaneCoverage } from "./mongodb-lane-coverage.js";
```

Pass to planRetrieval:

```typescript
const rawPlan = planRetrieval(query, {
  availablePaths: context.availablePaths,
  knownEntityNames: graphQueryCandidates,
  hasEpisodes: context.hasEpisodes,
  hasGraphData: context.hasGraphData,
  laneCoverage,
});
```

**Step 1: Run search tests**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts -t "searchV2" --reporter=verbose`
Expected: No regressions (laneCoverage is optional, backward compatible)

---

## Phase 6: Update System Prompt

> **Exit Criteria:** System prompt's MongoDB Memory section is honest about automatic extraction. Existing `prompt-section.test.ts` tests updated and passing. `pnpm check` PASS.

### Task 6.1: Update buildMongoDBBridgeSection -- add extraction honesty

**Files:**

- Modify: `src/agents/system-prompt.ts` (function `buildMongoDBBridgeSection`, around line 26)

In the full (non-minimal) branch, **after the existing capability lines** (look for the last `lines.push(...)` in the "MongoDB Memory" section, around line 48), **add two new lines.push calls:**

```typescript
lines.push(
  "- Automatic extraction: every event is analyzed for structured facts (preferences, decisions, identities, project context, critical context), entities (people, organizations, locations), and procedures (step-by-step workflows). This happens automatically -- you do not need to explicitly store routine observations.",
);
lines.push(
  "- Use memory_write for HIGH-IMPORTANCE facts the agent should never forget, or for corrections/updates to previously stored facts. Automatic extraction handles routine observations.",
);
```

### Task 6.2: Update Memory Recall section -- memory_search description

**Files:**

- Modify: `src/agents/system-prompt.ts` (Memory Recall section, around line 102-118)

**Find the existing line** that describes `memory_search` (currently reads something like `"- **memory_search** -- ..."` in the "When to use each tool" section). **Replace that entire line** with:

```typescript
lines.push(
  "- **memory_search** -- Your primary runtime recall tool. Searches across all populated MongoDB-backed retrieval lanes (conversation history, structured facts, entities/graph, episodes, procedures, knowledge base). Coverage varies by agent -- the planner automatically skips empty lanes.",
);
```

### Task 6.3: Update Memory Recall section -- memory_write description

**Files:**

- Modify: `src/agents/system-prompt.ts` (same Memory Recall section)

**Find the existing line** that describes `memory_write` (currently reads something like `"- **memory_write** -- ..."` in the same section). **Replace that entire line** with:

```typescript
lines.push(
  [
    "- **memory_write** -- Store high-importance structured observations to persistent memory. Routine facts are auto-extracted from events, so use this for:",
    '  - **decision**: choices made that should persist (e.g., "We chose TypeScript for the backend")',
    '  - **preference**: user likes/dislikes worth remembering (e.g., "User prefers concise responses")',
    '  - **fact**: important information (e.g., "API rate limit is 100 req/min")',
    '  - **person**: info about people (e.g., "Alice is the project manager")',
    '  - **todo**: action items (e.g., "Migrate auth to OAuth2 by March")',
    '  - **project**: project context (e.g., "Building ClawMongo with MongoDB 8.2")',
    "  - corrections or updates to auto-extracted facts",
  ].join("\n"),
);
```

### Task 6.4: Update prompt section tests

**Files:**

- Modify: `src/memory/prompt-section.test.ts` (if test assertions reference old prompt text)

Identify any existing test assertions that check the exact text of the `memory_search` or `memory_write` lines (e.g., snapshot tests or `.toContain()` calls). Update those assertions to match the new text. If tests use `.toContain("memory_search")` without checking the full description, they should already pass.

**Step 1: Run tests**

Run: `pnpm test -- src/memory/prompt-section.test.ts --reporter=verbose`
Expected: PASS

**Step 2: Run full check**

Run: `pnpm check`
Expected: PASS

---

## Phase 7: Verify Error Handling Consistency (Verify-Only)

> **Exit Criteria:** All extraction calls in `writeEventAndProject()` use the same try/catch pattern (not `.catch()`). No code changes expected -- this phase verifies Phase 4 (Task 4.1) left the codebase consistent.

### Task 7.1: Verify entity extraction refactor from Phase 4

**NOTE:** The entity extraction refactor from `.catch()` to `try/catch` was done in Phase 4 (Task 4.1). This phase is verify-only -- confirm the final shape in `writeEventAndProject()`:

1. **Entity extraction** -- uses `try { ... entityCount = entityResult.entities.length; } catch { log.warn(...) }` (refactored in Phase 4, Task 4.1)
2. **Structured/procedure extraction** -- uses `try { ... structuredCreated/proceduresCreated from derivedResult } catch { log.warn(...) }` (wired in Phase 2, captured in Phase 4 Task 4.2)
3. **Episode trigger** -- uses `try { ... episodeTriggered = episodeResult.triggered; } catch { log.warn(...) }` (Phase 3)
4. **Lane coverage** -- uses `try { ... updateLaneCoverage(...) } catch { log.warn(...) }` (Phase 4, Task 4.4)

All four blocks follow the same pattern: declare mutable variable before try, capture result inside try, log.warn inside catch, continue execution regardless.

**If any block still uses `.catch()` instead of try/catch, refactor it now.** Otherwise, no changes needed.

**Step 1: Run tests to confirm no regressions**

Run: `pnpm test -- src/memory/mongodb-manager.test.ts --reporter=verbose`
Expected: No regressions

---

## Phase 8: E2E Tests (Production Readiness)

> **Exit Criteria:** 3 new e2e phases (19, 20, 21) pass against real MongoDB. All existing phases still pass. `pnpm build` PASS.

### Task 8.1: Add Phase 19 - Extraction Pipeline E2E

**Files:**

- Modify: `src/memory/production-readiness.e2e.test.ts`

Add `describe("Phase 19: Extraction Pipeline")` with these tests:

1. `writeEventAndProject populates structured_mem collection via auto-extraction`
   - Write an event with body "I prefer dark mode for all code editors"
   - Verify structured_mem has a preference entry for this agent
2. `writeEventAndProject populates entities collection via auto-extraction`
   - Write events mentioning "John Smith works at MongoDB"
   - Verify entities collection has entries
3. `writeEventAndProject populates procedures collection via auto-extraction`
   - Write assistant event with "For deploying: 1. Build image 2. Push to registry 3. Update service"
   - Verify procedures collection has an entry
4. `extraction failure does not block event write`
   - Write a normal event (extraction may or may not find candidates)
   - Verify event is in events collection regardless
5. `active-critical facts are extracted from crisis-related events`
   - Write event "There is a war happening nearby, we need to evacuate"
   - Verify structured_mem has a salience="critical" entry

### Task 8.2: Add Phase 20 - Lane Coverage E2E

**Files:**

- Modify: `src/memory/production-readiness.e2e.test.ts`

Add `describe("Phase 20: Lane Coverage Tracking")` with these tests:

1. `lane_coverage document exists after writeEventAndProject`
   - After Phase 19 events, verify lane_coverage collection has a document for the agent
2. `raw-window and hybrid lanes show hasData=true`
   - Verify coverage doc has `lanes.raw-window.hasData === true`
3. `structured lane shows hasData=true when facts were extracted`
   - Verify coverage doc has `lanes.structured.hasData === true` (from Phase 19 events)
4. `planner skips empty lanes based on coverage`
   - Create a fresh agent with only 1 event (no structured facts)
   - Call searchV2 and verify the plan skips appropriate lanes

### Task 8.3: Add Phase 21 - Episode Auto-Materialization E2E

**Files:**

- Modify: `src/memory/production-readiness.e2e.test.ts`

Add `describe("Phase 21: Episode Auto-Materialization")` with these tests:

1. `episode materializes after event count threshold`
   - Write 55+ events for a single agent (above default threshold of 50)
   - Call writeEventAndProject for the last one
   - Verify episodes collection has at least 1 episode for the agent
2. `episodic lane coverage updated after materialization`
   - Verify lane_coverage has `lanes.episodic.hasData === true`
   - **HOW THIS WORKS:** `checkAutoEpisodeTriggers` returns `{ triggered: true }` when the episode is materialized. Phase 3 captures this into `episodeTriggered`. Phase 4 increments `episodic` lane when `episodeTriggered === true`. The E2E validates the full pipeline: 55+ events -> episode trigger fires -> lane coverage episodic incremented.

### Task 8.4: Final validation

**Step 1: Build**

Run: `pnpm build`
Expected: PASS (exit 0)

**Step 2: Run check**

Run: `pnpm check`
Expected: PASS

**Step 3: Run e2e (requires live MongoDB)**

Run: `MONGODB_TEST_URI='mongodb://localhost:27018/?directConnection=true' VOYAGE_API_KEY=... pnpm test -- src/memory/production-readiness.e2e.test.ts --reporter=verbose`
Expected: All existing phases PASS + 3 new phases PASS

---

## Risks

| Risk                                                                                  | Dimension | P   | I   | Score | Mitigation                                                                                                         |
| ------------------------------------------------------------------------------------- | --------- | --- | --- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| Double extraction call (structured candidates checked twice for coverage + promotion) | Technical | 3   | 1   | 3     | Pure function, <1ms. Acceptable.                                                                                   |
| `checkAutoEpisodeTriggers` calls LLM summarizer in hot path                           | Technical | 3   | 3   | 9     | Uses `heuristicEpisodeSummarizer` (no LLM). Rate limited to 1/hour. Only triggers after 50+ unconsolidated events. |
| Entity count in coverage stale after entity dedup                                     | Quality   | 2   | 1   | 2     | Coverage is approximate hint, not authoritative count. Planner uses hasData boolean not exact count.               |
| Lane coverage document grows unbounded                                                | Technical | 1   | 1   | 1     | Fixed 8-lane structure per agent. Document is ~500 bytes.                                                          |
| System prompt change breaks existing agent behavior                                   | Quality   | 2   | 2   | 4     | Change is additive (adds information), does not remove or contradict existing instructions.                        |
| `writeEventAndProject` latency increases                                              | Technical | 3   | 2   | 6     | All extraction is sync rule-based (<5ms). Episode trigger is rate-limited and only fires rarely.                   |
| EXPECTED_STANDARD_INDEX_COUNT drift                                                   | Quality   | 2   | 2   | 4     | Updated explicitly in Phase 1 from 63 to 64. Verified in e2e Phase 19-21.                                          |

---

## Success Criteria

- [ ] `writeEventAndProject()` triggers sync extraction (structured, entities, episode check)
- [ ] All 8 planner lanes return real data when appropriate
- [ ] Planner reports coverage/freshness per lane, skips empty lanes
- [ ] System prompt matches reality
- [ ] Unit + e2e tests for each extraction path
- [ ] `pnpm build` PASS
- [ ] Live MongoDB gate PASS

---

## Context References

### Patterns to Follow

- `src/memory/mongodb-manager.ts:2598-2712` -- existing `writeEventAndProject` function (standalone function pattern)
- `src/memory/mongodb-derived-memory.ts:153-274` -- `extractStructuredCandidatesFromEvent` (pure function, regex patterns)
- `src/memory/mongodb-derived-memory.ts:314-355` -- `extractProcedureCandidatesFromEvent` (pure function, regex patterns)
- `src/memory/mongodb-derived-memory.ts:357-452` -- `promoteDerivedMemoryFromEvent` (try/catch per extraction, records projection runs)
- `src/memory/mongodb-graph.ts:987-1268` -- `extractAndUpsertEntities` (rule-based via RegexEntityExtractor)
- `src/memory/mongodb-episodes.ts:533-663` -- `checkAutoEpisodeTriggers` (multi-signal trigger check)
- `src/memory/mongodb-retrieval-planner.ts:423-562` -- `planRetrieval` (pure function, keyword heuristic scoring)
- `src/memory/mongodb-schema.ts:37-127` -- collection helper functions + `ensureStandardIndexes`
- `src/agents/system-prompt.ts:26-148` -- `buildMongoDBBridgeSection` + Memory Recall section

### Existing Imports Already Available in mongodb-manager.ts

- `promoteDerivedMemoryFromEvent` (line 19)
- `heuristicEpisodeSummarizer` (line 18)
- `checkAutoEpisodeTriggers` (line 24)
- `mongodbGraph.extractAndUpsertEntities` (line 26, via namespace import)
- `mongodbEvents.writeEvent`, `mongodbEvents.projectEventChunk` (line 25, via namespace import)

### Configuration Files

- `vitest.e2e.config.ts` -- e2e test config (requires `MONGODB_TEST_URI`)
- `src/memory/mongodb-e2e.e2e.test.ts:63-88` -- `EXPECTED_COLLECTION_SUFFIXES` and `EXPECTED_STANDARD_INDEX_COUNT`

### Related Documentation

- `docs/plans/2026-03-30-memory-extraction-pipeline-design.md` -- design doc
- `docs/research/2026-03-30-memory-extraction-pipeline-web.md` -- web research
- `docs/research/2026-03-30-memory-extraction-pipeline-github.md` -- GitHub research
