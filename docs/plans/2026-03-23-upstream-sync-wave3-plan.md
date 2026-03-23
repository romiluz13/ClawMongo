# Upstream Sync Wave 3 -- Absorb 768 Commits

> **For Claude:** REQUIRED: Follow this plan phase-by-phase. Do NOT switch branches or stash during uncommitted merge state. Do NOT auto-accept upstream changes to MongoDB persistence paths without verifying cfg/sessionId wiring. The MongoDB-first contract is inviolable: no QMD, SQLite, LanceDB, or Markdown memory truth may enter.
> **Prior Art:** Wave 1 absorbed 729+13 commits, Wave 2 absorbed 50 commits -- both successful. This plan follows the same proven strategy at 10x scale.

**Goal:** Merge 768 upstream commits into ClawMongo via a single `git merge upstream/main --no-commit`, resolve 46 predicted conflicts by classification in a phased order, preserve all 23 MongoDB collections and 62+ indexes, and ship a clean build+test.

**Architecture:** Single merge, phased conflict resolution (memory truth first, then runtime, then everything else), multiple validation gates within the uncommitted merge state.

**Tech Stack:** Git merge, pnpm, TypeScript, Vitest, MongoDB

**Prerequisites:**

- `git fetch upstream` done (290 ahead / 768 behind confirmed)
- Working tree clean (confirmed via git status)
- All prior Almost Perfect Sprint work committed on main
- Backup branch created before merge

---

## Context References

### Protected Seam Files (MUST survive intact after merge)

62 MongoDB files in `src/memory/mongodb-*.ts` (production + test) -- upstream NEVER touches these.

Critical integration seams:

- `src/memory/search-manager.ts` -- HAS CONFLICT (2 upstream commits: `46876edd86` status manager, `2c919078e1` singleton state)
- `src/memory/search-manager.test.ts` -- HAS CONFLICT (upstream rewrites status-only test)
- `src/memory/backend-config.ts` -- NOT conflicted (safe)
- `src/memory/types.ts` -- NOT conflicted (safe)
- `src/memory/index.ts` -- NOT conflicted but must verify exports survive
- `src/config/types.memory.ts` -- NOT conflicted (safe)

### Conflict Classification (46 total)

**Tier 1 -- Memory Truth Boundary (4 files):**

1. `src/memory/search-manager.ts` -- CRITICAL: our MongoDB-only version vs upstream QMD+global-singleton refactor
2. `src/memory/search-manager.test.ts` -- our MongoDB tests vs upstream QMD test rewrites
3. `src/agents/tools/memory-tool.ts` -- upstream lazy-load + runtime split; must verify our MongoDB backend wiring
4. `src/hooks/bundled/session-memory/handler.ts` -- upstream extracted transcript.ts; our changes may conflict

**Tier 2 -- Memory-Adjacent (KEEP DELETED, 19 files):**
All modify/delete conflicts where we deleted QMD/LanceDB files and upstream modified them:

- `extensions/memory-lancedb/index.test.ts` -- KEEP DELETED
- `extensions/memory-lancedb/package.json` -- KEEP DELETED
- `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test.ts` -- upstream DELETED, we MODIFIED (926 lines); accept upstream deletion since upstream refactored spawn-workspace tests into separate fixtures
- `src/memory/index.test.ts` -- KEEP DELETED (we have our own test structure)
- `src/memory/manager-sync-ops.ts` -- KEEP DELETED (QMD-specific)
- `src/memory/manager.async-search.test.ts` -- KEEP DELETED
- `src/memory/manager.atomic-reindex.test.ts` -- KEEP DELETED
- `src/memory/manager.get-concurrency.test.ts` -- KEEP DELETED
- `src/memory/manager.mistral-provider.test.ts` -- KEEP DELETED
- `src/memory/manager.read-file.test.ts` -- KEEP DELETED
- `src/memory/manager.readonly-recovery.test.ts` -- KEEP DELETED
- `src/memory/manager.sync-errors-do-not-crash.test.ts` -- KEEP DELETED
- `src/memory/manager.ts` -- KEEP DELETED (QMD manager)
- `src/memory/manager.vector-dedupe.test.ts` -- KEEP DELETED
- `src/memory/manager.watcher-config.test.ts` -- KEEP DELETED
- `src/memory/memory-schema.ts` -- KEEP DELETED (QMD schema)
- `src/memory/qmd-manager.test.ts` -- KEEP DELETED
- `src/memory/qmd-manager.ts` -- KEEP DELETED
- `src/memory/test-manager-helpers.ts` -- KEEP DELETED

**Tier 3 -- Content Conflicts (23 files):**

- `docs/automation/hooks.md` -- accept upstream (docs)
- `docs/cli/hooks.md` -- accept upstream (docs)
- `docs/concepts/memory.md` -- accept upstream then verify no MongoDB-contradicting language
- `extensions/memory-core/index.test.ts` -- merge both test suites (proven pattern from Wave 2)
- `package.json` -- MANUAL: accept upstream + re-apply our overrides (name, version, mongodb dep)
- `pnpm-lock.yaml` -- regenerate
- `src/agents/pi-extensions/compaction-safeguard.ts` -- accept upstream (deps injection refactor, backend-agnostic)
- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts` -- accept upstream
- `src/cli/memory-cli.test.ts` -- accept upstream (memory-cli became thin shell importing runtime)
- `src/cli/memory-cli.ts` -- accept upstream (lazy-load refactor, backend-agnostic)
- `src/commands/auth-choice.preferred-provider.test.ts` -- accept upstream
- `src/commands/onboard-hooks.ts` -- accept upstream
- `src/commands/status.command.ts` -- accept upstream (writeRuntimeJson refactor)
- `src/commands/status.test.ts` -- accept upstream
- `src/config/schema.ts` -- accept upstream (GENERATED_BASE_CONFIG_SCHEMA refactor)
- `src/gateway/server-methods/agents.ts` -- accept upstream (deps injection for tests)
- `src/hooks/bundled/session-memory/HOOK.md` -- accept upstream (docs)
- `src/infra/outbound/delivery-queue.ts` -- accept upstream (massive refactor to thin shell)
- `src/plugin-sdk/index.test.ts` -- accept upstream
- `src/plugins/loader.test.ts` -- accept upstream
- `src/plugins/provider-runtime.ts` -- accept upstream (import path + cache clear rename)
- `src/plugins/provider-wizard.ts` -- accept upstream (import path + cache layer)
- `src/utils/message-channel.ts` -- accept upstream (registry refactor)

### 7 Memory-Critical Upstream Commits (Review Required)

| Commit       | Description                                | Action                                                                         |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `b186d9847c` | memory tools decoupled registration        | MERGE -- backend-agnostic, prevents coupled failure                            |
| `cfd9242e5d` | lazy-load memory runtime surfaces          | MERGE -- perf improvement, backend-agnostic                                    |
| `46876edd86` | lightweight memory status manager          | MERGE WITH CARE -- adds QmdStatusOnlyManager to search-manager.ts              |
| `2ef4d472f2` | restore memory-core workspace link         | MERGE -- package.json fix                                                      |
| `13c239039a` | consolidate QMD mcporter state             | IGNORE -- touches files we deleted                                             |
| `2c919078e1` | share memory/discord singleton state       | MERGE WITH CARE -- changes global cache to Symbol.for + resolveGlobalSingleton |
| `d2e8ed3632` | transcript pointers fresh after compaction | MERGE -- backend-agnostic                                                      |

### New Upstream Files (accept all, ~200+ new files)

- DuckDuckGo + Exa web search plugins
- ClawhHub native plugin installs
- Multi-session UI selection
- DeepSeek provider refactor
- Model catalog updates (Mistral, MiniMax, xAI fast mode)
- Slash plugin installs
- Release automation scripts
- Matrix extension
- Various new test files and fixtures

---

## Phase 0: Pre-Flight and Backup

**Objective:** Create safety net, verify state, configure merge protections.

**Inputs:** Clean working tree on main branch.

**Files/Surfaces:**

- `.gitattributes` (temporary, NOT committed)
- Git config (temporary merge driver)

**Steps:**

**Step 1: Verify clean state and counts**

```bash
git status --short
git rev-list --left-right --count HEAD...upstream/main
```

Expected: Clean working tree, `290 768`.

**Step 2: Create backup branch**

```bash
git branch pre-upstream-merge-wave3-backup
```

Verify: `git rev-parse pre-upstream-merge-wave3-backup` matches `git rev-parse HEAD`.

**Step 3: Configure temporary merge=ours driver for protected seams**

```bash
git config merge.ours.driver true
```

Append to `.gitattributes` (do NOT commit these lines):

```
src/memory/backend-config.ts merge=ours
src/memory/types.ts merge=ours
src/memory/index.ts merge=ours
src/config/types.memory.ts merge=ours
src/agents/session-tool-result-guard-wrapper.ts merge=ours
src/agents/session-tool-result-guard.ts merge=ours
```

Note: `search-manager.ts` is NOT in this list because it has a real conflict that needs manual resolution. The merge=ours driver would silently discard upstream changes we actually want to evaluate.

**Step 4: Run `git merge-tree` for authoritative conflict prediction**

```bash
git merge-tree --write-tree HEAD upstream/main 2>&1 | head -100
```

Compare against the 46 predicted conflicts. If unexpected conflicts appear in mongodb-\* files: STOP and re-evaluate before proceeding.

**Expected Artifacts:** Backup branch, merge driver configured, .gitattributes modified, conflict prediction verified.

**Required Checks:**

- `git branch --list pre-upstream-merge-wave3-backup` shows branch
- `git config merge.ours.driver` returns `true`
- Conflict prediction matches or is subset of 46 predicted

**Checkpoint Type:** Automatic (abort if unexpected mongodb-\* conflicts)

**Exit Criteria:** Backup exists, merge protections active, conflict prediction aligned.

---

## Phase 1: Execute Merge (No-Commit)

**Objective:** Run the single merge and enter conflict resolution state.

**Inputs:** Phase 0 complete, backup branch exists.

**Files/Surfaces:** Entire working tree (768 upstream commits incoming).

**Steps:**

**Step 1: Execute merge**

```bash
git merge upstream/main --no-commit
```

Expected: Merge pauses with conflicts. Git reports "Automatic merge failed; fix conflicts and then commit the result." This may take 30-60 seconds given 768 commits.

**Step 2: Count and classify conflicts**

```bash
git diff --name-only --diff-filter=U | wc -l
git diff --name-only --diff-filter=U | sort
```

Expected: ~46 conflicted files (may be fewer if some auto-resolve). Classify each against the three tiers.

**Step 3: CRITICAL -- Verify no unexpected mongodb-\* conflicts**

```bash
git diff --name-only --diff-filter=U | grep -E "^src/memory/mongodb-" && echo "DANGER: mongodb file conflict" || echo "OK: mongodb files clean"
```

Expected: "OK: mongodb files clean". If ANY mongodb-\* file appears: `git merge --abort` and escalate.

**Step 4: Verify protected seams survived (merge=ours files)**

```bash
git diff --name-only --diff-filter=U | grep -E "(backend-config|memory/types|memory/index\.ts|types\.memory|guard-wrapper|guard\.ts)" && echo "DANGER: protected seam conflict" || echo "OK: protected seams clean"
```

Expected: "OK: protected seams clean" (merge=ours driver prevented conflicts in these files).

**Expected Artifacts:** Working tree in merge state with ~46 conflicted files.

**Required Checks:**

- Conflict count approximately matches prediction
- Zero mongodb-\* files in conflict list
- Protected seam files (with merge=ours) not in conflict list
- search-manager.ts IS in conflict list (expected, handled in Phase 2)

**Checkpoint Type:** Automatic (abort if unexpected conflicts in protected surfaces)

**Exit Criteria:** Merge state active, conflict landscape matches predictions.

---

## Phase 2: Memory Truth Boundary Resolution (Tier 1 -- 4 files)

**Objective:** Resolve the 4 memory-touching conflict files with surgical precision, preserving MongoDB-first contract.

**Inputs:** Active merge state from Phase 1.

**Files/Surfaces:** The 4 Tier 1 conflict files.

### Resolution 2A: src/memory/search-manager.ts -- KEEP OURS (MongoDB-only)

**Classification:** KEEP OURS -- this is the MOST CRITICAL file in the merge.

**Context:**

- **Our version (114 lines):** Pure MongoDB path. Imports `resolveMemoryBackendConfig` returning `{ mongodb: ResolvedMongoDBConfig }`. Uses `MONGODB_MANAGER_CACHE` (simple Map). Calls `MongoDBMemoryManager.create()`. No QMD, no QmdStatusOnlyManager, no FallbackMemoryManager, no manager-runtime.js.
- **Upstream version (~300+ lines):** QMD-first with fallback. Imports `ResolvedQmdConfig`. Uses `QMD_MANAGER_CACHE` via `resolveGlobalSingleton`. Adds `QmdStatusOnlyManager` class (~80 lines). Uses `FallbackMemoryManager` wrapper. Imports `manager-runtime.js` (which we deleted). Adds `loadManagerRuntime()` lazy-load pattern.

**What upstream added (that we need):**

1. `resolveGlobalSingleton` pattern for cache isolation across `vi.resetModules()` -- ADOPT (good engineering, backend-agnostic)
2. `purpose: "status"` lightweight manager pattern -- ALREADY HAVE (our version supports it via our MongoDB manager)
3. `closeAllMemorySearchManagers` improvements -- CHECK if our version needs updates

**Strategy:** Keep our file as-is, but selectively adopt the `resolveGlobalSingleton` cache pattern if it improves test isolation. Do NOT adopt the QMD/QmdStatusOnlyManager/FallbackMemoryManager/manager-runtime.js imports.

**Steps:**

1. `git checkout --ours src/memory/search-manager.ts`
2. Review whether to adopt `resolveGlobalSingleton` pattern (replacing our simple `new Map<string, MemorySearchManager>()`)
   - If adopting: add `import { resolveGlobalSingleton } from "../shared/global-singleton.js"` and refactor cache initialization
   - If not adopting: leave as-is (simple Map works fine for MongoDB singleton)
3. Verify `buildMongoDBCacheKey` export still present
4. `git add src/memory/search-manager.ts`

**[CHECKPOINT] Decision: Adopt resolveGlobalSingleton for MONGODB_MANAGER_CACHE?**

- Recommend: YES if `src/shared/global-singleton.ts` exists in upstream and is backend-agnostic
- Recommend: NO if it pulls in QMD dependencies

**Verification:** File must contain `MONGODB_MANAGER_CACHE`, `buildMongoDBCacheKey`, `MongoDBMemoryManager`, and must NOT contain `QmdMemoryManager`, `QMD_MANAGER_CACHE`, `manager-runtime`, `FallbackMemoryManager`, `QmdStatusOnlyManager`.

### Resolution 2B: src/memory/search-manager.test.ts -- KEEP OURS + PORT APPLICABLE TESTS

**Classification:** PORT (keep ours, selectively add upstream tests that are backend-agnostic)

**Context:**

- **Our version:** Tests MongoDB manager caching, `buildMongoDBCacheKey`, MongoDB-specific scenarios.
- **Upstream changes:** Rewrites "does not cache status-only qmd managers" to "uses lightweight cached managers for status-only qmd requests" with QmdStatusOnlyManager assertions.

**Strategy:**

1. `git checkout --ours src/memory/search-manager.test.ts`
2. Review upstream test changes -- if any test patterns are useful for testing our MongoDB cache behavior, port them
3. The upstream status-only test rewrite is QMD-specific and does NOT apply
4. `git add src/memory/search-manager.test.ts`

### Resolution 2C: src/agents/tools/memory-tool.ts -- ACCEPT UPSTREAM + VERIFY MONGODB PATH

**Classification:** PORT (accept upstream lazy-load refactor, verify MongoDB execution path)

**Context:**

- **Upstream changes:** Extracted memory tool runtime into `memory-tool.runtime.js` for lazy loading. Added `loadMemoryToolRuntime()`, `getMemoryManagerContextWithPurpose()`, and a builtin file-read fast path.
- **Our concern:** The `resolveMemoryBackendConfig` and `getMemorySearchManager` imports moved to lazy runtime. Our MongoDB backend MUST still be reachable through this path.

**Strategy:**

1. Accept upstream changes (they are backend-agnostic refactors)
2. Verify `memory-tool.runtime.ts` exists in upstream and re-exports `getMemorySearchManager` from our `src/memory/index.ts`
3. If `memory-tool.runtime.ts` imports from `src/memory/index.js`, our MongoDB manager will be reached correctly
4. If it imports from files we deleted (e.g., `manager-runtime.js`), we need a shim or redirect

**Steps:**

1. Accept upstream: `git checkout --theirs src/agents/tools/memory-tool.ts`
2. Check if `src/agents/tools/memory-tool.runtime.ts` exists in upstream
3. Verify it imports `getMemorySearchManager` from a path that resolves to our MongoDB implementation
4. If path broken: create `memory-tool.runtime.ts` that re-exports from our `src/memory/index.ts`
5. `git add src/agents/tools/memory-tool.ts`

**[CHECKPOINT] Decision: Does memory-tool.runtime.ts need a ClawMongo shim?**

- Check: `git show upstream/main:src/agents/tools/memory-tool.runtime.ts`
- If it imports from `../../memory/index.js` -- SAFE (our index.ts exports getMemorySearchManager)
- If it imports from `../../memory/manager-runtime.js` -- NEEDS SHIM (we deleted that file)

### Resolution 2D: src/hooks/bundled/session-memory/handler.ts -- ACCEPT UPSTREAM + VERIFY

**Classification:** PORT (accept upstream refactor)

**Context:**

- **Upstream changes:** Extracted `getRecentSessionContent`, `getRecentSessionContentWithResetFallback`, and `findPreviousSessionFile` into a separate `transcript.ts` module. The handler.ts became a thin shell importing from `./transcript.js`.
- **Our concern:** These functions are file-system based (read session JSONL), not memory-backend specific. Safe to accept.

**Strategy:**

1. Accept upstream: `git checkout --theirs src/hooks/bundled/session-memory/handler.ts`
2. Verify `src/hooks/bundled/session-memory/transcript.ts` came in with the merge (new upstream file)
3. `git add src/hooks/bundled/session-memory/handler.ts`

### Post-Tier-1 Verification

```bash
# Verify no QMD/SQLite/LanceDB truth in resolved files
grep -rn "QmdMemoryManager\|qmd-manager\|manager-runtime\|memory-schema\|lancedb" src/memory/search-manager.ts && echo "DANGER: QMD leak" || echo "OK: clean"
```

**Expected Artifacts:** 4 Tier 1 files resolved, MongoDB-first contract verified.

**Required Checks:**

- search-manager.ts contains ONLY MongoDB paths
- search-manager.ts does NOT import QMD/manager-runtime/lancedb
- memory-tool.ts lazy-load path resolves to our MongoDB manager
- session-memory handler.ts compiles with transcript.ts present

**Checkpoint Type:** Manual review of search-manager.ts (CRITICAL)

**Exit Criteria:** All 4 memory truth files resolved, zero QMD/SQLite/LanceDB imports in resolved files.

---

## Phase 3: Memory-Adjacent Deletions (Tier 2 -- 19 files)

**Objective:** Resolve all 19 modify/delete conflicts by keeping our deletions.

**Inputs:** Phase 2 complete, Tier 1 files resolved.

**Files/Surfaces:** The 19 Tier 2 conflict files (all KEEP DELETED).

**Steps:**

**Step 1: Batch-resolve all 19 delete-vs-modify conflicts**

For each file that we deleted and upstream modified, confirm deletion:

```bash
# LanceDB files -- KEEP DELETED
git rm extensions/memory-lancedb/index.test.ts 2>/dev/null; git add -u extensions/memory-lancedb/index.test.ts
git rm extensions/memory-lancedb/package.json 2>/dev/null; git add -u extensions/memory-lancedb/package.json

# Upstream DELETED, we MODIFIED -- accept upstream deletion (refactored into separate fixtures)
git rm src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test.ts 2>/dev/null; git add -u src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test.ts

# QMD memory files -- KEEP DELETED
git rm src/memory/index.test.ts 2>/dev/null; git add -u src/memory/index.test.ts
git rm src/memory/manager-sync-ops.ts 2>/dev/null; git add -u src/memory/manager-sync-ops.ts
git rm src/memory/manager.async-search.test.ts 2>/dev/null; git add -u src/memory/manager.async-search.test.ts
git rm src/memory/manager.atomic-reindex.test.ts 2>/dev/null; git add -u src/memory/manager.atomic-reindex.test.ts
git rm src/memory/manager.get-concurrency.test.ts 2>/dev/null; git add -u src/memory/manager.get-concurrency.test.ts
git rm src/memory/manager.mistral-provider.test.ts 2>/dev/null; git add -u src/memory/manager.mistral-provider.test.ts
git rm src/memory/manager.read-file.test.ts 2>/dev/null; git add -u src/memory/manager.read-file.test.ts
git rm src/memory/manager.readonly-recovery.test.ts 2>/dev/null; git add -u src/memory/manager.readonly-recovery.test.ts
git rm src/memory/manager.sync-errors-do-not-crash.test.ts 2>/dev/null; git add -u src/memory/manager.sync-errors-do-not-crash.test.ts
git rm src/memory/manager.ts 2>/dev/null; git add -u src/memory/manager.ts
git rm src/memory/manager.vector-dedupe.test.ts 2>/dev/null; git add -u src/memory/manager.vector-dedupe.test.ts
git rm src/memory/manager.watcher-config.test.ts 2>/dev/null; git add -u src/memory/manager.watcher-config.test.ts
git rm src/memory/memory-schema.ts 2>/dev/null; git add -u src/memory/memory-schema.ts
git rm src/memory/qmd-manager.test.ts 2>/dev/null; git add -u src/memory/qmd-manager.test.ts
git rm src/memory/qmd-manager.ts 2>/dev/null; git add -u src/memory/qmd-manager.ts
git rm src/memory/test-manager-helpers.ts 2>/dev/null; git add -u src/memory/test-manager-helpers.ts
```

**Step 2: Verify none of these files exist on disk**

```bash
ls src/memory/manager.ts src/memory/qmd-manager.ts src/memory/memory-schema.ts extensions/memory-lancedb/package.json 2>&1 | grep -v "No such file" && echo "DANGER: deleted files still exist" || echo "OK: all deleted"
```

**Step 3: Check if upstream added NEW files that import from deleted modules**

```bash
git diff --cached --name-only --diff-filter=A | head -50
# Then grep the newly added files for imports from deleted modules:
# grep -rn "manager-runtime\|qmd-manager\|memory-schema\|manager-sync-ops" <new files>
```

If new upstream files import deleted modules, they will cause build failures in Phase 5. Document them for fixing.

**Expected Artifacts:** All 19 Tier 2 files resolved (kept deleted).

**Required Checks:**

- 0 of the 19 deleted files exist on disk
- `git diff --name-only --diff-filter=U` count decreased by ~19

**Checkpoint Type:** Automatic

**Exit Criteria:** All modify/delete conflicts resolved, deleted files confirmed absent.

---

## Phase 4: Content Conflict Resolution (Tier 3 -- 23 files)

**Objective:** Resolve all remaining content conflicts.

**Inputs:** Phases 2-3 complete, only Tier 3 conflicts remain.

**Files/Surfaces:** The 23 Tier 3 conflict files.

### Resolution Group A: Accept Upstream (16 files -- safe, non-memory)

These files have upstream-only changes that do not touch MongoDB persistence. Accept theirs directly:

```bash
# Documentation
git checkout --theirs docs/automation/hooks.md && git add docs/automation/hooks.md
git checkout --theirs docs/cli/hooks.md && git add docs/cli/hooks.md
git checkout --theirs src/hooks/bundled/session-memory/HOOK.md && git add src/hooks/bundled/session-memory/HOOK.md

# CLI/Commands (lazy-load refactors, backend-agnostic)
git checkout --theirs src/cli/memory-cli.ts && git add src/cli/memory-cli.ts
git checkout --theirs src/cli/memory-cli.test.ts && git add src/cli/memory-cli.test.ts
git checkout --theirs src/commands/status.command.ts && git add src/commands/status.command.ts
git checkout --theirs src/commands/status.test.ts && git add src/commands/status.test.ts
git checkout --theirs src/commands/auth-choice.preferred-provider.test.ts && git add src/commands/auth-choice.preferred-provider.test.ts
git checkout --theirs src/commands/onboard-hooks.ts && git add src/commands/onboard-hooks.ts

# Config (generated schema refactor)
git checkout --theirs src/config/schema.ts && git add src/config/schema.ts

# Plugins (import path + cache refactors)
git checkout --theirs src/plugins/provider-runtime.ts && git add src/plugins/provider-runtime.ts
git checkout --theirs src/plugins/provider-wizard.ts && git add src/plugins/provider-wizard.ts
git checkout --theirs src/plugins/loader.test.ts && git add src/plugins/loader.test.ts
git checkout --theirs src/plugin-sdk/index.test.ts && git add src/plugin-sdk/index.test.ts

# Infrastructure (delivery-queue rewrite, gateway deps injection)
git checkout --theirs src/infra/outbound/delivery-queue.ts && git add src/infra/outbound/delivery-queue.ts
git checkout --theirs src/gateway/server-methods/agents.ts && git add src/gateway/server-methods/agents.ts
```

### Resolution Group B: Accept Upstream + Verify (3 files)

**B1: src/agents/pi-extensions/compaction-safeguard.ts**

Upstream added `compactionSafeguardDeps` injection pattern and `__testing.setSummarizeInStagesForTest`. This is backend-agnostic (test utility improvement). Accept.

```bash
git checkout --theirs src/agents/pi-extensions/compaction-safeguard.ts
git add src/agents/pi-extensions/compaction-safeguard.ts
```

Verify: our compaction MongoDB wiring (if any) is not in this file. Compaction-safeguard is about summarization strategy, not memory backend.

**B2: src/utils/message-channel.ts**

Upstream refactored plugin channel resolution from inline `globalThis[REGISTRY_STATE]` to `listRegisteredChannelPluginIds()` and `normalizeAnyChannelId()` from registry module. Backend-agnostic. Accept.

```bash
git checkout --theirs src/utils/message-channel.ts
git add src/utils/message-channel.ts
```

**B3: src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts**

Accept upstream test changes.

```bash
git checkout --theirs src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts
git add src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts
```

### Resolution Group C: Accept Upstream + Review Memory Language (1 file)

**C1: docs/concepts/memory.md**

Accept upstream but SCAN for language that contradicts MongoDB-first contract (e.g., "QMD is the default backend", "SQLite index", "LanceDB vectors").

```bash
git checkout --theirs docs/concepts/memory.md
# Review for QMD/SQLite/LanceDB references
grep -n "qmd\|sqlite\|lancedb\|markdown.*memory\|MEMORY\.md.*source" docs/concepts/memory.md
```

If QMD/SQLite/LanceDB references found: edit to generalize language or note ClawMongo uses MongoDB exclusively. Then `git add docs/concepts/memory.md`.

### Resolution Group D: Manual Merge (3 files)

**D1: extensions/memory-core/index.test.ts -- Merge both test suites (proven Wave 2 pattern)**

```bash
git checkout --ours extensions/memory-core/index.test.ts
```

Then append upstream's new test blocks (check for `buildPromptSection`, `buildToolSchemas`, or other new describe blocks). Import any new exports needed.

`git add extensions/memory-core/index.test.ts`

**D2: package.json -- MANUAL merge (proven pattern)**

```bash
git checkout --theirs package.json
```

Then re-apply our overrides:

- `"name": "@romiluz/clawmongo"`
- `"version"`: our current version (2026.3.28 or bump to 2026.3.23-sync)
- `"description"`: our ClawMongo description
- `"homepage"`: our homepage
- `"repository"`: our repository
- `"bin"`: our `clawmongo` alias
- `"dependencies"`: ensure `mongodb` is present (not just in pnpm.overrides)
- Remove: `"./plugin-sdk/memory-lancedb"` export if upstream re-added it

Verify new upstream exports are preserved:

- `./plugin-sdk/discord`
- `./plugin-sdk/memory-core`
- Any new `./plugin-sdk/*` exports from 768 commits

`git add package.json`

**D3: pnpm-lock.yaml -- Regenerate (proven pattern)**

```bash
git checkout --theirs pnpm-lock.yaml
git add pnpm-lock.yaml
```

Will be properly regenerated in Phase 5 via `pnpm install`.

### Post-Resolution Verification

```bash
# Verify no remaining conflicts
git diff --name-only --diff-filter=U
```

Expected: empty (0 conflicted files remaining).

```bash
# Verify all mongodb-* files unchanged
git diff --cached --name-only -- 'src/memory/mongodb-*'
```

Expected: empty (no mongodb files staged as changed).

**Expected Artifacts:** All 46 conflicts resolved.

**Required Checks:**

- 0 remaining conflicted files
- All mongodb-\* files unchanged
- package.json has `@romiluz/clawmongo` name + `mongodb` dependency
- No `./plugin-sdk/memory-lancedb` export in package.json
- docs/concepts/memory.md has no QMD-as-truth language

**Checkpoint Type:** Manual review of package.json and docs/concepts/memory.md

**Exit Criteria:** All conflicts resolved, MongoDB-first contract verified in all resolved files.

---

## Phase 5: Dependency Resolution and Build Gate

**Objective:** Regenerate lockfile, fix any new import breakage, achieve clean build.

**Inputs:** All 46 conflicts resolved, no unresolved markers.

**Files/Surfaces:** `pnpm-lock.yaml`, `node_modules/`, `dist/`, possibly new shim files.

**Steps:**

**Step 1: Regenerate lockfile**

```bash
pnpm install
```

Expected: Exit 0. If peer dependency issues, resolve them.

**Step 2: Stage updated lockfile**

```bash
git add pnpm-lock.yaml
```

**Step 3: CHECK -- `manager-runtime.ts` import chain (likely auto-resolves)**

`src/memory/manager-runtime.ts` existed at the merge base and re-exports from `./manager.js`.
We DELETED both `manager-runtime.ts` AND `manager.ts`. Upstream did NOT modify `manager-runtime.ts`
in these 768 commits, so git should auto-resolve it as deleted (our deletion wins).

However, IF git unexpectedly brings it back, it would break the build because `manager.ts` is gone.

**Resolution options (choose one):**

- **Option A (Preferred): Delete `manager-runtime.ts`** -- If nothing in production code imports it (check with grep). This is the cleanest solution.
- **Option B: Create a shim** -- If upstream files DO import `manager-runtime.js`, create a stub:
  ```ts
  // src/memory/manager-runtime.ts -- ClawMongo shim (no QMD)
  // Upstream expects MemoryIndexManager and closeAllMemoryIndexManagers from here.
  // ClawMongo uses MongoDB exclusively; provide no-op stubs.
  export class MemoryIndexManager {
    static async get(_params: unknown): Promise<null> {
      return null;
    }
  }
  export async function closeAllMemoryIndexManagers(): Promise<void> {}
  ```

**Pre-verified findings (from gate analysis):**

- `src/agents/tools/memory-tool.runtime.ts` imports from `../../memory/index.js` (SAFE -- our barrel)
- `src/cli/memory-cli.runtime.ts` imports from `../memory/index.js` (SAFE -- our barrel)
- `src/memory/manager-runtime.ts` imports from `./manager.js` (BROKEN -- we deleted manager.ts)
- Check: `grep -rn "manager-runtime" src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | grep -v "mongodb-"`
- If only `search-manager.ts` upstream version references it (and we kept ours): Option A (delete) is correct
- If other upstream files reference it: Option B (shim) is needed

**Step 4: Check for other dangling imports from deleted files**

768 upstream commits may have added new files that import from modules we deleted. Check:

```bash
grep -rn "manager-runtime\|qmd-manager\|memory-schema\|manager-sync-ops\|memory-lancedb" src/ extensions/ --include="*.ts" --include="*.js" | grep -v "node_modules" | grep -v ".test.ts" | grep -v "mongodb-"
```

For each hit:

- If it is a new upstream file importing a deleted module: create a shim that re-exports from our MongoDB equivalent, OR modify the import to use our path
- If it is in a file we do not own (e.g., upstream plugin): evaluate whether the plugin needs QMD and if so, stub it out

**Step 5: Verify new upstream lazy-load boundary files imported safely**

Pre-verified (gate confirmed these are SAFE):

- `src/agents/tools/memory-tool.runtime.ts` -- imports `../../memory/index.js` and `../../memory/backend-config.js` and `../../memory/read-file.js` (all exist or will auto-merge)
- `src/cli/memory-cli.runtime.ts` -- imports `../memory/index.js` (our barrel, safe)
- `src/hooks/bundled/session-memory/transcript.ts` -- new upstream file, auto-merges cleanly
- `src/memory/read-file.ts` -- NEW upstream file, auto-merges (no conflict)

**Step 5: Build**

```bash
pnpm build
```

Expected: Exit 0. If TS errors:

- Categorize as: (a) import-path errors from refactored upstream modules, (b) type errors from new upstream APIs, (c) errors from deleted modules
- Fix category (a) by updating import paths
- Fix category (b) by adding type annotations or adapters
- Fix category (c) by creating shims or removing dead imports

**Step 6: Check for INEFFECTIVE_DYNAMIC_IMPORT warnings**

Upstream made significant lazy-loading changes. Verify no boundary violations:

```bash
pnpm build 2>&1 | grep -i "INEFFECTIVE_DYNAMIC_IMPORT" || echo "OK: no lazy-load warnings"
```

**Expected Artifacts:** Clean `pnpm install` + `pnpm build`.

**Required Checks:**

- `pnpm install` exit 0
- `pnpm build` exit 0
- No INEFFECTIVE_DYNAMIC_IMPORT warnings
- No dangling imports from deleted modules

**Checkpoint Type:** Automatic (fix build errors iteratively)

**Exit Criteria:** Clean build with zero new TS errors.

---

## Phase 6: Test Gate

**Objective:** Verify all tests pass at or above pre-merge baseline.

**Inputs:** Clean build from Phase 5.

**Files/Surfaces:** All `*.test.ts` files.

**Steps:**

**Step 1: Run memory-specific tests first (highest priority)**

```bash
pnpm test -- src/memory/
```

Expected: All MongoDB memory tests pass. Pre-merge baseline numbers:

- 229/229 v2 unit tests (across 11 test files)
- Known pre-existing: a few TS type errors in test files (baseline, not failures)

**Step 2: Run agent tests (covers compaction, system-prompt, memory-tool)**

```bash
pnpm test -- src/agents/
```

Expected: Agent tests pass. Key areas to watch:

- `compaction-safeguard` (upstream refactored deps injection)
- `memory-tool` (upstream refactored to lazy-load)
- `system-prompt` (verify buildMongoDBBridgeSection still present and called)

**Step 3: Run plugin tests**

```bash
pnpm test -- src/plugins/ extensions/
```

Expected: Plugin tests pass. Key areas:

- `extensions/memory-core/index.test.ts` (merged both test suites)
- `src/plugins/provider-runtime.ts` (import path changed)
- `src/plugins/provider-wizard.ts` (cache layer added)

**Step 4: Run full test suite**

```bash
pnpm test
```

Expected: Pass at or above pre-merge baseline. Classify any failures:

- **Pre-existing:** Same as before merge (document, ignore)
- **New from upstream:** Upstream tests that rely on QMD files we deleted -- fix by stubbing or removing
- **Regression in our code:** Fix before committing

**Step 5: Run lint/format check**

```bash
pnpm check
```

Expected: Pass (or pre-existing baseline only). Upstream may have added new formatting rules.

**Step 6: Verify key protected seam behaviors**

```bash
# buildMongoDBBridgeSection still present
grep -c "buildMongoDBBridgeSection" src/agents/system-prompt.ts

# memoryBackend wiring in compact.ts
grep -c "memoryBackend" src/agents/pi-embedded-runner/compact.ts

# sessionId in guardSessionManager callers
grep -c "sessionId" src/agents/pi-embedded-runner/compact.ts
grep -c "sessionId" src/agents/pi-embedded-runner/run/attempt.ts

# All v2 modules still exported
grep -c "mongodb-events\|mongodb-graph\|mongodb-episodes\|mongodb-ops\|mongodb-retrieval-planner" src/memory/index.ts
```

**Expected Artifacts:** Full test results showing pass/fail counts.

**Required Checks:**

- Memory tests: >= pre-merge count, 0 new failures in mongodb-\* files
- Agent tests: pass
- Full suite: pass at or above baseline
- buildMongoDBBridgeSection present (>= 2 hits)
- memoryBackend wiring present
- sessionId present in BOTH compact.ts and attempt.ts
- All v2 module exports intact

**Checkpoint Type:** Automatic (fix test failures iteratively)

**Exit Criteria:** Tests pass at or above pre-merge baseline, protected seams verified.

---

## Phase 7: MongoDB-First Contract Audit

**Objective:** Final sweep to ensure no QMD/SQLite/LanceDB truth leaked into production code.

**Inputs:** Build and tests pass from Phases 5-6.

**Files/Surfaces:** Entire `src/` and `extensions/` tree.

**Steps:**

**Step 1: Scan for QMD/SQLite/LanceDB references in production code**

```bash
# Production files only (exclude tests, node_modules, dist)
grep -rn "qmd\|QMD\|QmdMemoryManager\|qmd-manager\|QmdStatusOnlyManager" src/ extensions/ --include="*.ts" | grep -v ".test.ts" | grep -v "node_modules" | grep -v "dist/" | grep -v "// upstream" | grep -v "CHANGELOG"
```

For each hit, classify:

- **Type reference only** (e.g., `ResolvedQmdConfig` in a union type): acceptable if our code never reaches that branch
- **Executable path** (e.g., `if (resolved.backend === "qmd")`): MUST be dead code or removed
- **Import of deleted module** (e.g., `import { QmdMemoryManager } from "./qmd-manager.js"`): build would have caught this, but verify

```bash
grep -rn "sqlite\|SQLite\|lancedb\|LanceDB" src/ extensions/ --include="*.ts" | grep -v ".test.ts" | grep -v "node_modules" | grep -v "dist/" | grep -v "// " | grep -v "CHANGELOG"
```

Expected: Zero hits for SQLite/LanceDB in production code (excluding comments).

**Step 2: Verify memory-lancedb export NOT in package.json**

```bash
grep "memory-lancedb" package.json && echo "DANGER: lancedb export present" || echo "OK: no lancedb export"
```

**Step 3: Verify mongodb dependency in package.json dependencies**

```bash
node -e "const p = require('./package.json'); console.log('mongodb in deps:', 'mongodb' in (p.dependencies || {})); console.log('name:', p.name)"
```

Expected: `mongodb in deps: true`, `name: @romiluz/clawmongo`

**Step 4: Verify 23 collections and 62+ indexes still defined**

```bash
grep -c "collectionName\|createIndex\|ensureIndex" src/memory/mongodb-schema.ts
```

This is a sanity check -- our schema file should be untouched by upstream.

**Expected Artifacts:** Clean audit report, zero QMD/SQLite/LanceDB truth in production paths.

**Required Checks:**

- Zero executable QMD paths in production code
- Zero SQLite/LanceDB references in production code
- `memory-lancedb` not in package.json exports
- `mongodb` in package.json dependencies
- mongodb-schema.ts unchanged

**Checkpoint Type:** Manual review if any QMD references found

**Exit Criteria:** MongoDB-first contract verified, zero foreign memory truth.

---

## Phase 8: Commit and Verification

**Objective:** Create proper merge commit, verify integrity, clean up.

**Inputs:** All phases 0-7 pass.

**Files/Surfaces:** Merge commit, `.gitattributes`, git config.

**Steps:**

**Step 1: Restore .gitattributes**

Remove the temporary `merge=ours` lines:

```bash
git checkout -- .gitattributes
```

**Step 2: Remove temporary merge driver**

```bash
git config --unset merge.ours.driver
```

**Step 3: Stage any remaining files**

```bash
git add -A
```

Review what is staged -- ensure no unexpected files:

```bash
git diff --cached --stat | tail -5
```

**Step 4: Create merge commit**

```bash
git commit --no-verify -m "Merge upstream/main: absorb 768 upstream commits (wave 3)

Wave 3 upstream sync: 768 commits from OpenClaw upstream.
Resolved 46 conflicts preserving MongoDB-first contract.
Protected seams: search-manager.ts (MongoDB-only), 62 mongodb-* files untouched.
Deleted surfaces: LanceDB extension, QMD manager, memory-schema (QMD).
New upstream features: DuckDuckGo, Exa, ClawhHub, Matrix, release automation.
"
```

Note: `--no-verify` used because pre-existing TS errors in test files trigger pre-commit hooks. Same pattern as Wave 1 and Wave 2.

**Step 5: Verify 2-parent merge commit**

```bash
git cat-file -p HEAD | grep "^parent" | wc -l
```

Expected: `2` (two parent lines).

```bash
git cat-file -p HEAD | head -5
```

Expected: tree hash, two parent hashes (our HEAD + upstream/main).

**Step 6: Verify ahead/behind counts**

```bash
git rev-list --left-right --count HEAD...upstream/main
```

Expected: `~291 0` (290 ours + 1 merge commit, 0 behind).

**Step 7: Final validation suite**

```bash
pnpm build && pnpm test && pnpm check
```

All three must pass.

**Step 8: Delete backup branch**

```bash
git update-ref -d refs/heads/pre-upstream-merge-wave3-backup
```

**Expected Artifacts:** Clean 2-parent merge commit, 0 behind upstream.

**Required Checks:**

- 2-parent merge commit
- 0 behind upstream/main
- `.gitattributes` restored
- `git config merge.ours.driver` returns empty/error
- `pnpm build` exit 0
- `pnpm test` passes
- `pnpm check` passes

**Checkpoint Type:** Automatic

**Exit Criteria:** Merge committed, verified, ready for push.

---

## Phase 9: Post-Merge Validation and Publish

**Objective:** Push, run live e2e if available, publish npm.

**Inputs:** Clean merge commit from Phase 8.

**Files/Surfaces:** Remote origin, npm registry.

**Steps:**

**Step 1: Push**

```bash
git push origin main
```

**Step 2: Run live e2e tests (if MongoDB available)**

```bash
MONGODB_TEST_URI=<uri> pnpm test -- src/memory/mongodb-e2e.e2e.test.ts
```

Expected: All e2e scenarios pass (event->chunk projection, structured scope, graph expansion, episode materialization, migration backfill, retrieval planner, semantic cache, telemetry).

If MONGODB_TEST_URI not set: skip and document as deferred.

**Step 3: Bump version and publish (if desired)**

```bash
# Update version in package.json
# npm publish
```

**Expected Artifacts:** Pushed merge commit, optionally published npm package.

**Required Checks:**

- Push succeeds
- Live e2e pass (or documented as deferred)

**Checkpoint Type:** Manual (push + optional publish)

**Exit Criteria:** Merged, built, tested, pushed. Upstream sync wave 3 complete.

---

## Critical Lessons (from prior syncs -- DO NOT VIOLATE)

1. **NEVER switch branches** (`git checkout <branch>`, `git stash`) during uncommitted merge state -- it destroys the merge
2. **NEVER auto-accept** upstream's guardSessionManager callers without checking cfg/sessionId restoration
3. **cfg and sessionId params** are CRITICAL for MongoDB persistence path -- verify after merge
4. **Source taxonomy**: `"memory"` -> `"conversation"`, backward-compat `$in` filters -- verify not reverted
5. **After merge**, verify 2-parent commit: `git cat-file -p HEAD` must show TWO parent lines
6. **Live e2e tests** catch real issues unit tests miss -- run if available
7. **Verification agents must NEVER run `git checkout`** on modified files
8. **memory-lancedb** must remain deleted on every upstream sync
9. **mongodb dependency** must be in package.json `dependencies` (not pnpm.overrides)
10. **compact.ts and attempt.ts** guardSessionManager calls must BOTH have sessionId
11. **extensions/memory-core/index.test.ts**: merge both test suites (proven pattern)
12. **git merge-tree --write-tree** is authoritative for conflict prediction

---

## Behavior Contract (Critical-Path Verification)

### Invariants That MUST Hold After Merge

| Property                          | Verification                                                                                             | Pass Criteria                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| MongoDB is sole memory backend    | `grep -rn "QmdMemoryManager\|FallbackMemoryManager" src/memory/search-manager.ts`                        | Zero hits                               |
| No QMD executable paths           | `grep -rn "backend.*qmd\|qmd-manager" src/ --include="*.ts" \| grep -v test \| grep -v node_modules`     | Zero executable hits                    |
| No LanceDB surfaces               | `grep -rn "lancedb\|LanceDB" package.json src/ extensions/ \| grep -v node_modules \| grep -v CHANGELOG` | Zero hits (or comments only)            |
| search-manager.ts is MongoDB-only | Manual review of entire file                                                                             | No QMD imports, no QMD class references |
| 62+ mongodb-\* files untouched    | `git diff --cached --name-only -- 'src/memory/mongodb-*'` during merge                                   | Empty                                   |
| Package name preserved            | `node -e "console.log(require('./package.json').name)"`                                                  | `@romiluz/clawmongo`                    |
| MongoDB in dependencies           | `node -e "console.log('mongodb' in require('./package.json').dependencies)"`                             | `true`                                  |
| sessionId in compact.ts           | `grep -c "sessionId" src/agents/pi-embedded-runner/compact.ts`                                           | >= 1                                    |
| sessionId in attempt.ts           | `grep -c "sessionId" src/agents/pi-embedded-runner/run/attempt.ts`                                       | >= 1                                    |
| buildMongoDBBridgeSection         | `grep -c "buildMongoDBBridgeSection" src/agents/system-prompt.ts`                                        | >= 2                                    |
| Build passes                      | `pnpm build`                                                                                             | exit 0                                  |
| Tests pass                        | `pnpm test`                                                                                              | >= pre-merge baseline                   |
| 2-parent merge commit             | `git cat-file -p HEAD \| grep "^parent" \| wc -l`                                                        | 2                                       |

### Edge-Case Catalog

| Edge Case                                                 | Handling                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| New upstream file imports deleted module                  | Create shim re-exporting from MongoDB equivalent               |
| Upstream added new memory-lancedb export to package.json  | Remove it                                                      |
| Upstream changed `resolveMemoryBackendConfig` return type | Our backend-config.ts is protected by merge=ours               |
| New upstream test file references QMD test helpers        | Delete or stub the test                                        |
| Upstream added new config key for QMD                     | Accepted via schema.ts but never exercised (dead code)         |
| `memory-tool.runtime.ts` imports `manager-runtime.js`     | Create shim that re-exports from our index.ts                  |
| `memory-cli.runtime.ts` imports QMD paths                 | Create shim or redirect to MongoDB paths                       |
| New upstream file uses `QMD_MANAGER_CACHE` symbol         | Irrelevant -- our search-manager.ts uses MONGODB_MANAGER_CACHE |

### Provable Properties

1. **No QMD execution**: After merge, no production code path can instantiate QmdMemoryManager (file deleted, no import path exists)
2. **No LanceDB execution**: After merge, LanceDB extension directory does not exist, no export in package.json
3. **MongoDB singleton**: search-manager.ts creates exactly one MongoDBMemoryManager per (agentId, config) tuple
4. **Protected seam integrity**: All 62 mongodb-\* files are byte-identical pre/post merge (merge=ours for non-conflicted, upstream never touches them)

---

## Risks and Mitigations

| Risk                                                                            | P   | I   | Score | Mitigation                                                                    |
| ------------------------------------------------------------------------------- | --- | --- | ----- | ----------------------------------------------------------------------------- |
| search-manager.ts loses MongoDB path during merge                               | 2   | 5   | 10    | KEEP OURS strategy, manual verification in Phase 2, behavioral contract check |
| New upstream lazy-load boundaries import deleted modules                        | 3   | 4   | 12    | Phase 5 Step 3-4 explicitly checks for dangling imports; shim creation        |
| package.json loses MongoDB dep or name                                          | 2   | 5   | 10    | Manual resolution (proven pattern); field-by-field verification               |
| memory-lancedb re-added by upstream                                             | 3   | 3   | 9     | Phase 7 audit; Phase 4 D2 removes export                                      |
| Unexpected conflict in mongodb-\* file                                          | 1   | 5   | 5     | Phase 1 Step 3 check; merge-tree prediction; merge=ours backup                |
| New upstream code calls `resolveMemoryBackendConfig` expecting QMD return shape | 3   | 3   | 9     | Build gate (Phase 5) catches type errors; shim if needed                      |
| 768 commits introduce subtle behavioral regressions                             | 2   | 3   | 6     | Full test suite gate; memory-specific test gate; live e2e                     |
| compact.ts/attempt.ts sessionId wiring lost                                     | 2   | 4   | 8     | Explicit grep check in Phase 6 Step 6                                         |
| pnpm install fails with 768 commits of dependency changes                       | 2   | 3   | 6     | Backup branch for rollback; accept --theirs lockfile then regenerate          |
| Pre-commit hooks block merge commit                                             | 3   | 1   | 3     | --no-verify flag (proven, pre-existing TS errors in test files)               |

---

## Success Criteria

- [ ] 0 behind upstream/main
- [ ] `pnpm build` exits 0
- [ ] `pnpm test` passes at or above pre-merge baseline
- [ ] 2-parent merge commit verified
- [ ] search-manager.ts is MongoDB-only (zero QMD/LanceDB imports)
- [ ] All 62+ mongodb-\* files unchanged
- [ ] Package.json has `@romiluz/clawmongo` name + `mongodb` dependency
- [ ] No `memory-lancedb` export in package.json
- [ ] `buildMongoDBBridgeSection` present in system-prompt.ts
- [ ] `memoryBackend` wiring present in compact.ts
- [ ] sessionId in BOTH compact.ts and attempt.ts
- [ ] Zero executable QMD/SQLite/LanceDB paths in production code
- [ ] 23 collections, 62+ indexes preserved in mongodb-schema.ts
- [ ] Pushed to origin/main

---

## Summary

- **Total commits:** 768 upstream
- **Predicted conflicts:** 46 (27 content + 19 modify/delete; 6 merge=ours files have no real conflicts)
- **Resolution tiers:** 3 (Memory Truth first, then Deletions, then Content)
- **Phases:** 10 (0-9)
- **Critical file:** `src/memory/search-manager.ts` (KEEP OURS, MongoDB-only)
- **Key risk:** New upstream lazy-load boundaries importing deleted QMD modules (Score: 12)
- **Proven pattern:** Same merge strategy as Wave 1 (729) and Wave 2 (50), scaled up
