# Memory v2 Consolidation — Make v2 the Sole Architecture

> **For Claude:** REQUIRED: Follow this plan task-by-task. Each task has explicit file paths, exact code changes, and test commands.
> **Design:** See `docs/plans/2026-03-15-memory-architecture-v2-design.md` for the full v2 specification.

**Goal:** Remove the mongo_canonical/mongo_v2 split entirely so v2 IS the only memory architecture. No feature flags, no runtimeMode choice, no dead code.

**Architecture:** The memory system currently has a transitional `runtimeMode` field that toggles between `mongo_canonical` (v1) and `mongo_v2` behavior. This plan removes that toggle, makes episodes/graph default to enabled, wires the 3 stub search paths in `searchV2()` to real implementations, fixes the KB source naming test mismatch, and corrects README inaccuracies about embeddings.

**Tech Stack:** TypeScript ESM, MongoDB, Vitest

**Prerequisites:** Memory v2 base + enhancements already built and passing (205 unit tests, 54 E2E tests).

---

## Relevant Codebase Files

### Patterns to Follow

- `src/memory/mongodb-manager.ts` (lines 459-635) - Production search path (manager.search)
- `src/memory/mongodb-manager.ts` (lines 1637-1775) - searchV2() with 6 retrieval paths
- `src/memory/backend-config.ts` (lines 102-381) - resolveMemoryBackendConfig

### Config Type Files

- `src/config/types.memory.ts:8` - MemoryRuntimeMode type definition
- `src/config/types.memory.ts:120` - runtimeMode field on MemoryConfig
- `src/config/zod-schema.ts:159-170` - Zod schema blocking mongo_v2

### Test Files (Memory-Specific runtimeMode)

- `src/memory/backend-config.test.ts:470-572` - 7 runtimeMode-specific tests
- `src/memory/mongodb-manager.test.ts:562` - expects runtimeMode in V2Status
- `src/memory/search-manager.test.ts:49` - fixture uses runtimeMode
- `src/memory/real-e2e-v2.e2e.test.ts:1063,1076` - e2e checks runtimeMode

### NON-MEMORY runtimeMode (DO NOT TOUCH)

- `src/config/sessions/types.ts:55` - ACP session runtimeMode (plan/normal/auto)
- `src/agents/acp-spawn.ts` - ACP spawn mode
- `src/auto-reply/reply/commands-acp/*` - ACP runtime mode
- `src/acp/control-plane/*` - ACP control plane
- `src/gateway/session-utils.ts` - Model resolution (uses "runtimeModel" variable name, not memory runtimeMode)
- `src/sessions/model-overrides.ts` - Model overrides

### KB Source Naming

- `src/memory/mongodb-kb-search.ts:28` - Returns `source: "reference"` (CORRECT)
- `src/memory/mongodb-kb-search.test.ts:70` - Expects `source: "kb"` (WRONG - fix to "reference")
- `src/memory/mongodb-kb-search.test.ts:122` - Expects `source: "kb"` (WRONG - fix to "reference")

---

## Phase 1: Remove runtimeMode from Memory Config Types and Backend Config

> **Exit Criteria:** `pnpm build` succeeds with no runtimeMode in memory config types. Episodes/graph default to enabled. No runtime mode validation. Config backward-compatible (old configs with runtimeMode field are silently ignored).

### Task 1.1: Remove MemoryRuntimeMode type and runtimeMode field from types

**Files:**

- Modify: `src/config/types.memory.ts:8` (delete MemoryRuntimeMode type)
- Modify: `src/config/types.memory.ts:120` (delete runtimeMode field)
- Modify: `src/config/types.memory.ts:65-67` (update episodes/graph JSDoc — remove "v2 only")

**Step 1: Remove MemoryRuntimeMode type**

In `src/config/types.memory.ts`, delete line 8:

```typescript
// DELETE this line:
export type MemoryRuntimeMode = "mongo_canonical" | "mongo_v2";
```

**Step 2: Remove runtimeMode field from MemoryConfig**

In `src/config/types.memory.ts`, delete line 120:

```typescript
// DELETE this line from MemoryConfig:
runtimeMode?: MemoryRuntimeMode;
```

**Step 3: Update episodes/graph JSDoc comments**

Change line 65 from:

```typescript
/** Episode materialization config (v2 only) */
```

to:

```typescript
/** Episode materialization config */
```

Change line 73 from:

```typescript
/** Graph projection config (v2 only) */
```

to:

```typescript
/** Graph projection config */
```

### Task 1.2: Remove runtimeMode from ResolvedMongoDBConfig and resolution logic

**Files:**

- Modify: `src/memory/backend-config.ts:7` (remove MemoryRuntimeMode import)
- Modify: `src/memory/backend-config.ts:74` (remove runtimeMode from ResolvedMongoDBConfig)
- Modify: `src/memory/backend-config.ts:94` (remove DEFAULT_RUNTIME_MODE constant)
- Modify: `src/memory/backend-config.ts:108` (remove runtimeMode resolution from params)
- Modify: `src/memory/backend-config.ts:115-119` (remove runtimeMode validation block)
- Modify: `src/memory/backend-config.ts:319` (remove runtimeMode from resolved object)
- Modify: `src/memory/backend-config.ts:321-324` (episodes.enabled defaults to true)
- Modify: `src/memory/backend-config.ts:333-336` (graph.enabled defaults to true)

**Step 1: Remove MemoryRuntimeMode import from backend-config.ts**

In `src/memory/backend-config.ts`, remove `MemoryRuntimeMode` from the import on line 7. Keep the other imports.

**Step 2: Remove runtimeMode from ResolvedMongoDBConfig type**

Delete line 74:

```typescript
// DELETE this line:
runtimeMode: MemoryRuntimeMode;
```

**Step 3: Remove DEFAULT_RUNTIME_MODE constant**

Delete line 94:

```typescript
// DELETE this line:
const DEFAULT_RUNTIME_MODE = "mongo_canonical" as const;
```

**Step 4: Remove runtimeMode resolution and validation**

Delete line 108:

```typescript
// DELETE this line:
const runtimeMode = params.cfg.memory?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
```

Delete lines 115-119 (the runtimeMode validation block):

```typescript
// DELETE this block:
if (runtimeMode !== "mongo_canonical" && runtimeMode !== "mongo_v2") {
  throw new Error(
    `Unsupported memory.runtimeMode "${String(runtimeMode)}". ClawMongo supports "mongo_canonical" or "mongo_v2".`,
  );
}
```

**Step 5: Remove runtimeMode from resolved config object**

Delete line 319:

```typescript
// DELETE this line:
runtimeMode,
```

**Step 6: Default episodes.enabled to true**

Change the episodes.enabled default (lines 321-324) from:

```typescript
enabled:
  mongoCfg?.episodes?.enabled !== undefined
    ? mongoCfg.episodes.enabled
    : runtimeMode === "mongo_v2",
```

to:

```typescript
enabled: mongoCfg?.episodes?.enabled !== false,
```

This means: enabled by default (true), user can explicitly set `false` to disable.

**Step 7: Default graph.enabled to true**

Change the graph.enabled default (lines 333-336) from:

```typescript
enabled:
  mongoCfg?.graph?.enabled !== undefined
    ? mongoCfg.graph.enabled
    : runtimeMode === "mongo_v2",
```

to:

```typescript
enabled: mongoCfg?.graph?.enabled !== false,
```

### Task 1.3: Remove runtimeMode Zod schema blocking

**Files:**

- Modify: `src/config/zod-schema.ts:159-170`

**Step 1: Remove the runtimeMode field from Zod MemorySchema**

Replace the runtimeMode schema block (lines 159-170):

```typescript
// REPLACE THIS:
runtimeMode: z
  .string()
  .optional()
  .superRefine((value, ctx) => {
    if (value === undefined || value === "mongo_canonical") {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `runtimeMode "${value}" is not supported in ClawMongo. Use runtimeMode "mongo_canonical".`,
    });
  }),
```

with a simple passthrough that silently ignores old configs:

```typescript
runtimeMode: z.string().optional(),
```

Why keep the field at all? Backward compatibility. Old config files with `runtimeMode: "mongo_v2"` or `runtimeMode: "mongo_canonical"` should not cause validation errors. The field is simply ignored at runtime since `resolveMemoryBackendConfig` no longer reads it.

### Task 1.4: Update backend-config tests

**Files:**

- Modify: `src/memory/backend-config.test.ts:469-572`

**Step 1: Rewrite the runtimeMode test section**

Replace the 7 runtimeMode tests (lines 469-572) with tests that verify:

1. Episodes default to enabled when not configured
2. Graph defaults to enabled when not configured
3. Episodes/graph can be explicitly disabled
4. Custom episode/graph config is respected
5. Old runtimeMode field in config does not cause errors (backward compat)
6. Resolved config does NOT have a runtimeMode field

Example test structure:

```typescript
// ---------------------------------------------------------------------------
// v2 architecture defaults (episodes + graph enabled by default)
// ---------------------------------------------------------------------------

it("enables episodes by default", () => {
  const cfg = {
    agents: { defaults: { workspace: "/tmp/memory-test" } },
    memory: {
      backend: "mongodb",
      mongodb: { uri: "mongodb://localhost:27017" },
    },
  } as unknown as OpenClawConfig;
  const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
  expect(resolved.mongodb!.episodes.enabled).toBe(true);
  expect(resolved.mongodb!.graph.enabled).toBe(true);
});

it("allows disabling episodes explicitly", () => {
  const cfg = {
    agents: { defaults: { workspace: "/tmp/memory-test" } },
    memory: {
      backend: "mongodb",
      mongodb: { uri: "mongodb://localhost:27017", episodes: { enabled: false } },
    },
  } as unknown as OpenClawConfig;
  const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
  expect(resolved.mongodb!.episodes.enabled).toBe(false);
});

it("allows disabling graph explicitly", () => {
  const cfg = {
    agents: { defaults: { workspace: "/tmp/memory-test" } },
    memory: {
      backend: "mongodb",
      mongodb: { uri: "mongodb://localhost:27017", graph: { enabled: false } },
    },
  } as unknown as OpenClawConfig;
  const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
  expect(resolved.mongodb!.graph.enabled).toBe(false);
});

it("ignores old runtimeMode field without error (backward compat)", () => {
  const cfg = {
    agents: { defaults: { workspace: "/tmp/memory-test" } },
    memory: {
      backend: "mongodb",
      runtimeMode: "mongo_v2",
      mongodb: { uri: "mongodb://localhost:27017" },
    },
  } as unknown as OpenClawConfig;
  // Should not throw
  const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
  expect(resolved.mongodb).toBeDefined();
  // runtimeMode should NOT exist on resolved config
  expect("runtimeMode" in resolved.mongodb!).toBe(false);
});

it("resolves custom episode and graph config", () => {
  // Keep existing test from line 556, but remove runtimeMode from config fixture
  const cfg = {
    agents: { defaults: { workspace: "/tmp/memory-test" } },
    memory: {
      backend: "mongodb",
      mongodb: {
        uri: "mongodb://localhost:27017",
        episodes: { enabled: false, minEventsForEpisode: 20 },
        graph: { enabled: false, maxGraphDepth: 5 },
      },
    },
  } as unknown as OpenClawConfig;
  const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
  expect(resolved.mongodb!.episodes).toEqual({ enabled: false, minEventsForEpisode: 20 });
  expect(resolved.mongodb!.graph).toEqual({ enabled: false, maxGraphDepth: 5 });
});
```

**Step 2: Run tests**

Run: `pnpm vitest run src/memory/backend-config.test.ts`
Expected: ALL PASS

### Task 1.5: Build check

Run: `pnpm build`
Expected: Exit 0. If TS errors arise from removing `runtimeMode` from `ResolvedMongoDBConfig`, fix the downstream references (Phase 2 handles the known ones).

---

## Phase 2: Remove runtimeMode from V2Status, Manager Tests, and E2E Tests

> **Exit Criteria:** All V2Status references use v2-native shape without runtimeMode. All memory module unit tests pass.

### Task 2.1: Remove runtimeMode from V2Status type and getV2Status function

**Files:**

- Modify: `src/memory/mongodb-manager.ts:1781-1782` (V2Status type)
- Modify: `src/memory/mongodb-manager.ts:1838` (getV2Status return)

**Step 1: Remove runtimeMode from V2Status type**

Change V2Status (line 1781-1789) from:

```typescript
export type V2Status = {
  runtimeMode: "mongo_v2";
  events: { count: number; latestTimestamp?: Date };
  ...
```

to:

```typescript
export type V2Status = {
  events: { count: number; latestTimestamp?: Date };
  ...
```

**Step 2: Remove runtimeMode from getV2Status return value**

In `getV2Status()`, remove line 1838:

```typescript
// DELETE this line from the return object:
runtimeMode: "mongo_v2",
```

### Task 2.2: Update mongodb-manager.test.ts

**Files:**

- Modify: `src/memory/mongodb-manager.test.ts:562`

**Step 1: Remove runtimeMode assertion**

Delete or comment out line 562:

```typescript
// DELETE this line:
expect(status.runtimeMode).toBe("mongo_v2");
```

### Task 2.3: Update search-manager.test.ts fixture

**Files:**

- Modify: `src/memory/search-manager.test.ts:49`

**Step 1: Remove runtimeMode from test fixture**

Delete line 49:

```typescript
// DELETE this line from the mock config:
runtimeMode: "mongo_canonical",
```

### Task 2.4: Update real-e2e-v2.e2e.test.ts

**Files:**

- Modify: `src/memory/real-e2e-v2.e2e.test.ts:1063,1076`

**Step 1: Remove runtimeMode console.log**

Delete or update line 1063:

```typescript
// DELETE this line:
console.log(`  Runtime mode: ${status.runtimeMode}`);
```

**Step 2: Remove runtimeMode assertion**

Delete line 1076:

```typescript
// DELETE this line:
expect(status.runtimeMode).toBe("mongo_v2");
```

### Task 2.5: Run all memory tests

Run: `pnpm vitest run src/memory/`
Expected: All tests pass except the 2 pre-existing KB source failures (fixed in Phase 3).

---

## Phase 3: Fix KB Source Naming Tests

> **Exit Criteria:** The 2 previously-failing KB tests now pass. Zero pre-existing test failures in the memory module.

### Task 3.1: Fix KB test source assertions

**Files:**

- Modify: `src/memory/mongodb-kb-search.test.ts:70`
- Modify: `src/memory/mongodb-kb-search.test.ts:122`

The implementation in `mongodb-kb-search.ts:28` correctly returns `source: "reference"`. The tests incorrectly expect `source: "kb"`.

**Step 1: Fix line 70**

Change:

```typescript
expect(results[0].source).toBe("kb");
```

to:

```typescript
expect(results[0].source).toBe("reference");
```

**Step 2: Fix line 122**

Change:

```typescript
expect(results[0].source).toBe("kb");
```

to:

```typescript
expect(results[0].source).toBe("reference");
```

**Step 3: Run KB search tests**

Run: `pnpm vitest run src/memory/mongodb-kb-search.test.ts`
Expected: ALL PASS (previously 2 failures, now 0)

---

## Phase 4: Wire searchV2 Stub Paths to Real Implementations

> **Exit Criteria:** All 6 searchV2 paths execute real code (no debug-log stubs). manager.search() remains the primary production search. searchV2 is the v2-native retrieval pipeline.

### Task 4.1: Wire the "structured" path in searchV2

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (searchV2 function, "structured" case)

The "structured" case currently just logs "delegated to caller". Wire it to call `searchStructuredMemory` from `mongodb-structured-memory.ts`.

**Step 1: Add import for searchStructuredMemory**

Ensure `searchStructuredMemory` is imported from `./mongodb-structured-memory.js` at the top of `mongodb-manager.ts`. Check if it is already imported (it is used in manager.search()).

**Step 2: Wire the structured path**

Replace the structured case:

```typescript
case "structured":
  log.debug("searchV2: structured path delegated to caller");
  break;
```

with:

```typescript
case "structured": {
  const structuredHits = await searchStructuredMemory(
    structuredMemCollection(db, prefix),
    query,
    null, // queryVector: null for automated embedding mode
    {
      maxResults: context.maxResults ?? 10,
      minScore: 0.1,
      filter: { agentId },
      numCandidates: 200,
      capabilities: { vectorSearch: true, textSearch: true, scoreFusion: true, rankFusion: false },
      vectorIndexName: `${prefix}structured_mem_vector`,
      embeddingMode: "automated",
    },
  ).catch((err) => {
    log.warn(`searchV2 structured path failed: ${String(err)}`);
    return [] as MemorySearchResult[];
  });
  pathResults = structuredHits;
  break;
}
```

Note: `DetectedCapabilities` has fields `{ vectorSearch, textSearch, scoreFusion, rankFusion }`. The plan uses optimistic defaults. If the caller has specific capabilities, they can be passed through `context` in a future enhancement.

[CHECKPOINT] The structured search needs `capabilities` and `vectorIndexName`. These should use the same naming convention as `manager.search()`. The prefix-based naming (`${prefix}structured_mem_vector`) follows the existing pattern.

### Task 4.2: Wire the "hybrid" path in searchV2

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (searchV2 function, "hybrid" case)

The hybrid path should call `mongoSearch` (the same function used by `manager.search()` for conversation chunks).

**Step 1: Wire the hybrid path**

Replace:

```typescript
case "hybrid":
  log.debug("searchV2: hybrid path delegated to existing search infrastructure");
  break;
```

with:

```typescript
case "hybrid": {
  const hybridHits = await mongoSearch(
    chunksCollection(db, prefix),
    query,
    null, // queryVector: null for automated embedding mode
    {
      maxResults: context.maxResults ?? 10,
      minScore: 0.1,
      numCandidates: 200,
      fusionMethod: "scoreFusion",
      capabilities: { vectorSearch: true, textSearch: true, scoreFusion: true, rankFusion: false },
      vectorIndexName: `${prefix}chunks_vector`,
      textIndexName: `${prefix}chunks_text`,
      vectorWeight: 0.7,
      textWeight: 0.3,
      embeddingMode: "automated",
    },
  ).catch((err) => {
    log.warn(`searchV2 hybrid path failed: ${String(err)}`);
    return [] as MemorySearchResult[];
  });
  pathResults = hybridHits;
  break;
}
```

### Task 4.3: Wire the "kb" path in searchV2

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (searchV2 function, "kb" case)

**Step 1: Ensure searchKB import exists**

Check that `searchKB` is imported from `./mongodb-kb-search.js` and `kbChunksCollection` / `kbCollection` from `./mongodb-schema.js`.

**Step 2: Wire the kb path**

Replace:

```typescript
case "kb":
  log.debug("searchV2: kb path delegated to existing search infrastructure");
  break;
```

with:

```typescript
case "kb": {
  const kbHits = await searchKB(
    kbChunksCollection(db, prefix),
    query,
    null, // queryVector: null for automated embedding mode
    {
      maxResults: Math.max(3, Math.floor((context.maxResults ?? 10) / 3)),
      minScore: 0.1,
      numCandidates: 200,
      vectorIndexName: `${prefix}kb_chunks_vector`,
      textIndexName: `${prefix}kb_chunks_text`,
      capabilities: { vectorSearch: true, textSearch: true, scoreFusion: true, rankFusion: false },
      embeddingMode: "automated",
      kbDocs: kbCollection(db, prefix),
    },
  ).catch((err) => {
    log.warn(`searchV2 kb path failed: ${String(err)}`);
    return [] as MemorySearchResult[];
  });
  pathResults = kbHits;
  break;
}
```

### Task 4.4: Verify imports are present

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (top-level imports)

Ensure these are imported at the top of `mongodb-manager.ts`:

- `searchStructuredMemory` from `./mongodb-structured-memory.js`
- `mongoSearch` from `./mongodb-search.js`
- `searchKB` from `./mongodb-kb-search.js`
- `kbChunksCollection`, `kbCollection`, `chunksCollection`, `structuredMemCollection` from `./mongodb-schema.js`

Most of these should already be imported since `manager.search()` uses them. Verify and add any missing ones.

### Task 4.5: Run tests

Run: `pnpm vitest run src/memory/mongodb-manager.test.ts`
Expected: ALL PASS

Run: `pnpm build`
Expected: Exit 0

---

## Phase 5: Dead Code Cleanup

> **Exit Criteria:** No references to `mongo_canonical`, `MemoryRuntimeMode`, or `DEFAULT_RUNTIME_MODE` remain in memory module source files. All tests pass.

### Task 5.1: Search and verify all runtimeMode references removed from memory code

Run these grep commands to verify:

```bash
grep -rn "MemoryRuntimeMode" src/
grep -rn "mongo_canonical" src/memory/ src/config/types.memory.ts src/config/zod-schema.ts
grep -rn "DEFAULT_RUNTIME_MODE" src/
```

Expected: Zero matches in memory-related files. ACP/session files may still have their own `runtimeMode` (that is correct and expected).

### Task 5.2: Check for any orphaned runtimeMode in memory barrel exports

**Files:**

- Check: `src/memory/index.ts` — ensure no `MemoryRuntimeMode` re-export

### Task 5.3: Full test suite

Run: `pnpm vitest run src/memory/`
Expected: ALL PASS (including the 2 KB tests fixed in Phase 3)

Run: `pnpm build`
Expected: Exit 0

---

## Phase 6: README Accuracy

> **Exit Criteria:** README correctly describes mongot + Voyage AI relationship. No misleading "no external provider" claims.

### Task 6.1: Clarify the Voyage AI relationship in README

**Files:**

- Modify: `README.md`

The README currently says things like "No separate embedding service" and "No application-side embedding code". This is technically correct — there is no application-side code — but the framing can mislead readers into thinking no external API is involved.

**Step 1: Update the Voyage AI autoEmbed section (around line 110-117)**

Change:

```
- **No application-side embedding code** — the entire embedding pipeline is handled by mongot + Voyage AI
```

to:

```
- **No application-side embedding code** — mongot delegates to the Voyage AI API for embedding generation. You need a Voyage AI API key configured in mongot, but no embedding code in the application layer.
```

**Step 2: Update the summary line (around line 36)**

Change:

```
- **Voyage AI autoEmbed (voyage-4-large)**: with `memory.mongodb.embeddingMode = "automated"`, mongot auto-generates embeddings at index time and query time via Voyage AI. No separate embedding service, no manual vector management.
```

to:

```
- **Voyage AI autoEmbed (voyage-4-large)**: with `memory.mongodb.embeddingMode = "automated"`, mongot delegates to the Voyage AI API for embedding generation at index time and query time. No application-side embedding code or manual vector management.
```

**Step 3: Update the TL;DR line (around line 303)**

Change:

```
- **Voyage AI autoEmbed**: `voyage-4-large` automatic embeddings via `mongot` on chunks, kb_chunks, and structured_mem. `$vectorSearch` with `query: { text: "..." }` — zero application-side embedding code.
```

to:

```
- **Voyage AI autoEmbed**: `voyage-4-large` embeddings via `mongot` (which delegates to the Voyage AI API) on chunks, kb_chunks, and structured_mem. `$vectorSearch` with `query: { text: "..." }` — zero application-side embedding code.
```

---

## Risks

| Risk                                                           | P (1-5) | I (1-5) | Score | Mitigation                                                                                 |
| -------------------------------------------------------------- | ------- | ------- | ----- | ------------------------------------------------------------------------------------------ |
| Removing runtimeMode breaks downstream consumers               | 2       | 4       | 8     | Zod schema keeps field as optional passthrough; resolved config simply drops it            |
| Old config files with runtimeMode cause errors                 | 3       | 3       | 9     | Zod schema accepts and ignores old values; backward compat test verifies                   |
| searchV2 wired paths hit runtime errors (missing capabilities) | 3       | 3       | 9     | Each path has try/catch with graceful fallback; capabilities default to full               |
| ACP runtimeMode accidentally touched                           | 1       | 5       | 5     | Explicit DO NOT TOUCH list; grep verification in Phase 5                                   |
| Episodes/graph enabled by default breaks existing deployments  | 2       | 3       | 6     | Both can be explicitly disabled via config; existing behavior preserved for custom configs |

---

## Success Criteria

- [ ] `MemoryRuntimeMode` type deleted from `src/config/types.memory.ts`
- [ ] `runtimeMode` field removed from `MemoryConfig` and `ResolvedMongoDBConfig`
- [ ] Zod schema accepts and ignores old `runtimeMode` values (no validation errors)
- [ ] Episodes and graph default to enabled (true) when not explicitly configured
- [ ] `V2Status` type no longer has `runtimeMode` field
- [ ] All 6 searchV2 paths execute real code (no debug-log stubs)
- [ ] KB tests expect `source: "reference"` (both passing)
- [ ] README accurately describes mongot delegating to Voyage AI
- [ ] ACP runtimeMode completely untouched (verified by grep)
- [ ] `pnpm build` exits 0
- [ ] `pnpm vitest run src/memory/` — all tests pass (0 pre-existing failures after KB fix)
- [ ] `pnpm check` — no new lint/format issues
