# Upstream Sync Wave 5 -- Absorb 573 Commits

> **For Claude:** REQUIRED: Follow this plan phase-by-phase. Do NOT switch branches or stash during uncommitted merge state. Do NOT auto-accept upstream changes to MongoDB persistence paths without verifying cfg/sessionId wiring. The MongoDB-first contract is inviolable: no QMD, SQLite, LanceDB, or Markdown memory truth may enter.
> **Prior Art:** Wave 1 absorbed 729+13 commits, Wave 2 absorbed 50 commits, Wave 3 absorbed 768 commits, Wave 4 absorbed ~40 commits -- all successful. This plan follows the same proven strategy.

**Goal:** Merge 573 upstream commits into ClawMongo via a single `git merge upstream/main --no-commit`, resolve 20 predicted conflicts by classification in a phased order, preserve all 23 MongoDB collections and 62+ indexes, and ship a clean build+test.

**Architecture:** Single merge, phased conflict resolution (memory truth first, then deletions, then everything else), multiple validation gates within the uncommitted merge state.

**Tech Stack:** Git merge, pnpm, TypeScript, Vitest, MongoDB

**Prerequisites:**

- `git fetch upstream` done (301 ahead / 573 behind confirmed)
- Working tree clean (confirmed via git status)
- All prior Memory Retrieval Improvements work committed on main
- Backup branch created before merge
- Last published: `@romiluz/clawmongo@2026.3.30`

---

## Context References

### Protected Seam Files (MUST survive intact after merge)

70 MongoDB files in `src/memory/mongodb-*.ts` (production + test) -- upstream NEVER touches these.

Critical integration seams:

- `src/memory/search-manager.ts` -- HAS CONFLICT (2 upstream commits: `435e2c5967` avoid caching qmd status managers, `f56a79f838` report qmd status counts from real qmd manager)
- `src/memory/search-manager.test.ts` -- HAS CONFLICT (upstream rewrites status-only test)
- `src/memory/backend-config.ts` -- NOT conflicted (safe)
- `src/memory/types.ts` -- NOT conflicted (safe)
- `src/memory/index.ts` -- NOT conflicted but must verify exports survive
- `src/config/types.memory.ts` -- NOT conflicted (safe)
- `src/agents/pi-embedded-runner/compact.ts` -- CHANGED UPSTREAM (compaction logic improvements)
- `src/agents/pi-embedded-runner/run/attempt.ts` -- CHANGED UPSTREAM (session execution)
- `src/agents/pi-tools.ts` -- CHANGED UPSTREAM (agent tool wiring)
- `src/agents/system-prompt.ts` -- CHANGED UPSTREAM (prompt construction)
- `src/config/zod-schema.ts` -- CHANGED UPSTREAM (config validation)
- `src/gateway/tools-invoke-http.ts` -- CHANGED UPSTREAM (tool invocation transport)
- `src/infra/outbound/deliver.ts` -- CHANGED UPSTREAM (outbound persistence)
- `src/infra/outbound/outbound-send-service.ts` -- CHANGED UPSTREAM (outbound persistence)

### Conflict Classification (20 total)

**Tier 1 -- Memory Truth Boundary (2 files):**

1. `src/memory/search-manager.ts` -- CRITICAL: our MongoDB-only version (114 lines) vs upstream QMD+global-singleton refactor (310 lines)
2. `src/memory/search-manager.test.ts` -- our MongoDB tests (206 lines) vs upstream QMD test rewrites

**Tier 2 -- Memory-Adjacent Deletions (KEEP DELETED, 10 files):**
All modify/delete conflicts where we deleted QMD/LanceDB files and upstream modified them:

- `extensions/memory-lancedb/index.test.ts` -- KEEP DELETED
- `extensions/memory-lancedb/index.ts` -- KEEP DELETED
- `src/memory/index.test.ts` -- KEEP DELETED (we have our own test structure)
- `src/memory/manager-sync-ops.ts` -- KEEP DELETED (QMD-specific)
- `src/memory/manager.get-concurrency.test.ts` -- KEEP DELETED
- `src/memory/manager.mistral-provider.test.ts` -- KEEP DELETED
- `src/memory/manager.ts` -- KEEP DELETED (QMD manager)
- `src/memory/manager.vector-dedupe.test.ts` -- KEEP DELETED
- `src/plugin-sdk/memory-lancedb.ts` -- KEEP DELETED

Plus one special case:

- `extensions/whatsapp/src/setup-surface.test.ts` -- deleted upstream, we modified. ACCEPT UPSTREAM DELETION (upstream refactored/collapsed tests).

**Tier 3 -- Content Conflicts (8 files):**

- `README.md` -- MANUAL: accept upstream then re-apply our ClawMongo branding/description
- `docs/.generated/config-baseline.jsonl` -- accept upstream (generated file, regenerate later)
- `extensions/discord/src/monitor/message-handler.preflight.acp-bindings.test.ts` -- accept upstream
- `package.json` -- MANUAL: accept upstream + re-apply our overrides (name, version, mongodb dep, remove lancedb export)
- `pnpm-lock.yaml` -- regenerate
- `src/agents/pi-extensions/compaction-safeguard.test.ts` -- accept upstream (safeguard cancel reasons)
- `src/cli/command-format.ts` -- accept upstream (containerized instance targeting)
- `src/config/schema.base.generated.ts` -- accept upstream (generated config schema)

### 10 Protected Seams Changed Upstream (Review Required)

These files have NO conflict but were CHANGED upstream and touch MongoDB integration seams:

| File                                           | Upstream Change                                                                     | Review Action                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `package.json`                                 | deps/version updates                                                                | HAS CONFLICT -- handled in Phase 4                           |
| `src/agents/pi-embedded-runner/compact.ts`     | compaction on LLM timeout, safeguard cancel reasons, preflight transcript estimates | REVIEW: verify sessionId + memoryBackend wiring intact       |
| `src/agents/pi-embedded-runner/run/attempt.ts` | session execution improvements                                                      | REVIEW: verify sessionId + guardSessionManager wiring intact |
| `src/agents/pi-tools.ts`                       | agent tool wiring changes                                                           | REVIEW: verify MongoDB tool registration path                |
| `src/agents/system-prompt.ts`                  | prompt construction (ClawHub URL, embedded guards, heartbeat)                       | REVIEW: verify buildMongoDBBridgeSection call intact         |
| `src/config/zod-schema.ts`                     | config validation changes                                                           | REVIEW: verify MongoDB memory config schema intact           |
| `src/gateway/tools-invoke-http.ts`             | codex websocket responses, tool warnings                                            | REVIEW: minimal memory surface -- likely safe                |
| `src/infra/outbound/deliver.ts`                | media access policy alignment                                                       | REVIEW: verify outbound persistence for MongoDB              |
| `src/infra/outbound/outbound-send-service.ts`  | outbound persistence changes                                                        | REVIEW: minimal memory surface                               |
| `src/memory/search-manager.ts`                 | THE BIG ONE -- full QMD rewrite                                                     | HAS CONFLICT -- handled in Phase 2                           |

### Upstream Commits Touching search-manager.ts (THE MOST CRITICAL CONFLICT)

2 upstream commits:

- `435e2c5967` fix(memory): avoid caching qmd status managers
- `f56a79f838` fix: report qmd status counts from real qmd manager (#53683)

**Upstream version (310 lines):**

- Changed from `MONGODB_MANAGER_CACHE` to `QMD_MANAGER_CACHE` via `resolveGlobalSingleton`
- Uses `Symbol.for("openclaw.memorySearchManagerCache")` for cross-module cache survival
- Added `BorrowedMemoryManager` class pattern
- Added `FallbackMemoryManager` pattern
- Changed imports from `ResolvedMongoDBConfig` to `ResolvedQmdConfig`
- Added `loadManagerRuntime()` lazy-load pattern importing `manager-runtime.js`
- Changed `closeAllMemorySearchManagers` to close QMD managers
- Added `MemoryEmbeddingProbeResult`, `MemorySyncProgressUpdate` type imports

**Our version (114 lines):**

- Pure MongoDB path. Imports `resolveMemoryBackendConfig` returning `{ mongodb: ResolvedMongoDBConfig }`.
- Uses `MONGODB_MANAGER_CACHE` (simple Map). Calls `MongoDBMemoryManager.create()`.
- Includes `buildMongoDBCacheKey` with `stableSerialize` for source-policy-aware caching.
- No QMD, no QmdStatusOnlyManager, no FallbackMemoryManager, no manager-runtime.js.

**RESOLUTION: KEEP OURS.** Consider adopting `resolveGlobalSingleton` pattern if backend-agnostic utility exists at `src/shared/global-singleton.ts`.

### 16 Upstream Commits Touching Other Protected Seams

Key themes from these commits:

**Compaction (compact.ts):**

- Trigger compaction on LLM timeout
- Surface safeguard cancel reasons
- Preflight transcript estimates

**System Prompt (system-prompt.ts):**

- ClawHub URL fix
- Embedded prompt guards
- Heartbeat suppression

**Gateway (tools-invoke-http.ts):**

- Codex websocket responses
- Tool warnings

**Outbound (deliver.ts, outbound-send-service.ts):**

- Media access policy alignment

**Agent Tools (pi-tools.ts):**

- Tool registration changes

**Config (zod-schema.ts):**

- Config validation updates

### Excluded Backend Paths Changed Upstream (always delete after merge)

These files are in `scripts/upstream-excluded-paths.txt` and must be deleted if they reappear:

- `extensions/memory-lancedb/` (entire directory)
- `src/memory/index.test.ts`
- `src/memory/manager-sync-ops.ts`
- `src/memory/manager.ts`
- `src/memory/manager.watcher-config.test.ts`
- `src/memory/qmd-manager.ts`
- `src/plugin-sdk/memory-lancedb.ts`

### New Upstream Features (accept all, ~1900+ files changed)

Key themes from 573 upstream commits:

- Channel security hardening (Feishu, Telegram, Matrix, WhatsApp, Discord, MSTeams, BlueBubbles)
- New Microsoft Foundry provider
- Video generation infrastructure (added then reverted)
- Compaction improvements (LLM timeout trigger, safeguard cancel reasons, preflight transcript estimates)
- Sandbox and security fixes (localRoots, path traversal, env blocklist)
- Vitest config rewrites (5+ config files)
- Plugin SDK and lazy-load refactors
- Build/release tooling updates
- Rate limiting improvements

---

## Phase 0: Pre-Flight and Backup

**Objective:** Create safety net, verify state, configure merge protections.

**Inputs:** Clean working tree on main branch.

**Files/Surfaces:**

- `.gitattributes` (temporary, NOT committed)
- Git config (temporary merge driver)

**Dependencies:** None.

**Allowed Scope:** Git config and safety checks only.

**Out-of-scope Drift:** Do NOT modify source files, run build, or install deps.

**Steps:**

**Step 1: Verify clean state and counts**

```bash
git status --short
git rev-list --left-right --count HEAD...upstream/main
```

Expected: Clean working tree, `301 573`.

**Step 2: Create backup branch**

```bash
git branch pre-upstream-merge-wave5-backup
```

Verify: `git rev-parse pre-upstream-merge-wave5-backup` matches `git rev-parse HEAD`.

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
git merge-tree --write-tree HEAD upstream/main 2>&1 | head -200
```

Compare against the 20 predicted conflicts. If unexpected conflicts appear in mongodb-\* files: STOP and re-evaluate before proceeding.

**Expected Artifacts:** Backup branch, merge driver configured, .gitattributes modified, conflict prediction verified.

**Required Checks:**

- `git branch --list pre-upstream-merge-wave5-backup` shows branch
- `git config merge.ours.driver` returns `true`
- Conflict prediction matches or is subset of 20 predicted

**Checkpoint Type:** Automatic (abort if unexpected mongodb-\* conflicts)

**Exit Criteria:** Backup exists, merge protections active, conflict prediction aligned.

---

## Phase 1: Execute Merge (No-Commit)

**Objective:** Run the single merge and enter conflict resolution state.

**Inputs:** Phase 0 complete, backup branch exists.

**Files/Surfaces:** Entire working tree (573 upstream commits incoming).

**Dependencies:** Phase 0.

**Allowed Scope:** Git merge only.

**Out-of-scope Drift:** Do NOT resolve conflicts yet.

**Steps:**

**Step 1: Execute merge**

```bash
git merge upstream/main --no-commit
```

Expected: Merge pauses with conflicts. Git reports "Automatic merge failed; fix conflicts and then commit the result." This may take 30-60 seconds given 573 commits.

**Step 2: Count and classify conflicts**

```bash
git diff --name-only --diff-filter=U | wc -l
git diff --name-only --diff-filter=U | sort
```

Expected: ~20 conflicted files (may be fewer if some auto-resolve). Classify each against the three tiers.

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

**Expected Artifacts:** Working tree in merge state with ~20 conflicted files.

**Required Checks:**

- Conflict count approximately matches prediction (~20)
- Zero mongodb-\* files in conflict list
- Protected seam files (with merge=ours) not in conflict list
- search-manager.ts IS in conflict list (expected, handled in Phase 2)

**Checkpoint Type:** Automatic (abort if unexpected conflicts in protected surfaces)

**Exit Criteria:** Merge state active, conflict landscape matches predictions.

---

## Phase 2: Memory Truth Boundary Resolution (Tier 1 -- 2 files)

**Objective:** Resolve the 2 memory-touching conflict files with surgical precision, preserving MongoDB-first contract.

**Inputs:** Active merge state from Phase 1.

**Files/Surfaces:** The 2 Tier 1 conflict files.

**Dependencies:** Phase 1.

**Allowed Scope:** Only search-manager.ts and search-manager.test.ts.

**Out-of-scope Drift:** Do NOT touch any other conflicted files.

### Resolution 2A: src/memory/search-manager.ts -- KEEP OURS (MongoDB-only)

**Classification:** KEEP OURS -- this is the MOST CRITICAL file in the merge.

**Context:**

- **Our version (114 lines):** Pure MongoDB path. Imports `resolveMemoryBackendConfig` returning `{ mongodb: ResolvedMongoDBConfig }`. Uses `MONGODB_MANAGER_CACHE` (simple Map). Calls `MongoDBMemoryManager.create()`. Includes `buildMongoDBCacheKey` with `stableSerialize` for source-policy-aware caching. No QMD at all.
- **Upstream version (310 lines):** QMD-first with fallback. Imports `ResolvedQmdConfig`. Uses `QMD_MANAGER_CACHE` via `resolveGlobalSingleton` with `Symbol.for("openclaw.memorySearchManagerCache")`. Adds `BorrowedMemoryManager` class. Uses `FallbackMemoryManager` wrapper. Imports `manager-runtime.js` (which we deleted). Adds `loadManagerRuntime()` lazy-load pattern.

**What upstream added (that we might adopt later):**

1. `resolveGlobalSingleton` pattern for cache isolation across `vi.resetModules()` -- CONSIDER adopting (good engineering, backend-agnostic) but NOT in this sync. Our simple Map works fine.
2. `purpose: "status"` lightweight manager pattern -- ALREADY HAVE (our version supports it via our MongoDB manager)
3. `closeAllMemorySearchManagers` improvements -- CHECK if our version needs updates

**Strategy:** Keep our file as-is. Our `MONGODB_MANAGER_CACHE` with `buildMongoDBCacheKey` + `stableSerialize` is battle-tested across 4 waves. The `resolveGlobalSingleton` adoption is a post-sync improvement if desired.

**Steps:**

1. `git checkout --ours src/memory/search-manager.ts`
2. Verify `buildMongoDBCacheKey` export still present
3. Verify `closeAllMemorySearchManagers` still iterates and closes all managers
4. `git add src/memory/search-manager.ts`

**Verification:** File must contain `MONGODB_MANAGER_CACHE`, `buildMongoDBCacheKey`, `MongoDBMemoryManager`, `stableSerialize`, and must NOT contain `QmdMemoryManager`, `QMD_MANAGER_CACHE`, `manager-runtime`, `FallbackMemoryManager`, `QmdStatusOnlyManager`, `BorrowedMemoryManager`, `resolveGlobalSingleton`.

### Resolution 2B: src/memory/search-manager.test.ts -- KEEP OURS

**Classification:** KEEP OURS -- our MongoDB-specific tests are correct and complete.

**Context:**

- **Our version (206 lines):** Tests MongoDB manager caching, `buildMongoDBCacheKey`, MongoDB-specific scenarios, source policy enforcement.
- **Upstream changes:** Rewrites tests around QMD status-only manager caching behavior.

**Strategy:**

1. `git checkout --ours src/memory/search-manager.test.ts`
2. `git add src/memory/search-manager.test.ts`

Our tests are MongoDB-specific. Upstream's test changes are QMD-specific and do NOT apply.

### Post-Tier-1 Verification

```bash
# Verify no QMD/SQLite/LanceDB truth in resolved files
grep -rn "QmdMemoryManager\|qmd-manager\|manager-runtime\|memory-schema\|lancedb\|QMD_MANAGER_CACHE\|BorrowedMemoryManager\|FallbackMemoryManager" src/memory/search-manager.ts && echo "DANGER: QMD leak" || echo "OK: clean"
```

**Expected Artifacts:** 2 Tier 1 files resolved, MongoDB-first contract verified.

**Required Checks:**

- search-manager.ts contains ONLY MongoDB paths
- search-manager.ts does NOT import QMD/manager-runtime/lancedb
- search-manager.test.ts tests MongoDB behavior only

**Checkpoint Type:** Manual review of search-manager.ts (CRITICAL)

**Exit Criteria:** Both memory truth files resolved, zero QMD/SQLite/LanceDB imports in resolved files.

---

## Phase 3: Memory-Adjacent Deletions (Tier 2 -- 10 files)

**Objective:** Resolve all 10 modify/delete conflicts by keeping our deletions.

**Inputs:** Phase 2 complete, Tier 1 files resolved.

**Files/Surfaces:** The 10 Tier 2 conflict files (all KEEP DELETED or accept upstream deletion).

**Dependencies:** Phase 2.

**Allowed Scope:** Only Tier 2 conflict files.

**Out-of-scope Drift:** Do NOT touch Tier 3 files.

**Steps:**

**Step 1: Batch-resolve all modify/delete conflicts**

For each file that we deleted and upstream modified, confirm deletion:

```bash
# LanceDB files -- KEEP DELETED
git rm extensions/memory-lancedb/index.test.ts 2>/dev/null; git add -u extensions/memory-lancedb/index.test.ts
git rm extensions/memory-lancedb/index.ts 2>/dev/null; git add -u extensions/memory-lancedb/index.ts

# QMD memory files -- KEEP DELETED
git rm src/memory/index.test.ts 2>/dev/null; git add -u src/memory/index.test.ts
git rm src/memory/manager-sync-ops.ts 2>/dev/null; git add -u src/memory/manager-sync-ops.ts
git rm src/memory/manager.get-concurrency.test.ts 2>/dev/null; git add -u src/memory/manager.get-concurrency.test.ts
git rm src/memory/manager.mistral-provider.test.ts 2>/dev/null; git add -u src/memory/manager.mistral-provider.test.ts
git rm src/memory/manager.ts 2>/dev/null; git add -u src/memory/manager.ts
git rm src/memory/manager.vector-dedupe.test.ts 2>/dev/null; git add -u src/memory/manager.vector-dedupe.test.ts

# Plugin SDK LanceDB -- KEEP DELETED
git rm src/plugin-sdk/memory-lancedb.ts 2>/dev/null; git add -u src/plugin-sdk/memory-lancedb.ts

# WhatsApp test -- upstream DELETED, we MODIFIED -- accept upstream deletion
git rm extensions/whatsapp/src/setup-surface.test.ts 2>/dev/null; git add -u extensions/whatsapp/src/setup-surface.test.ts
```

**Step 2: Verify none of these files exist on disk**

```bash
ls src/memory/manager.ts src/memory/manager-sync-ops.ts extensions/memory-lancedb/index.ts src/plugin-sdk/memory-lancedb.ts extensions/whatsapp/src/setup-surface.test.ts 2>&1 | grep -v "No such file" && echo "DANGER: deleted files still exist" || echo "OK: all deleted"
```

**Step 3: Check if upstream added NEW files that import from deleted modules**

```bash
git diff --cached --name-only --diff-filter=A | head -50
# Then check for imports from deleted modules:
grep -rn "manager-runtime\|qmd-manager\|memory-schema\|manager-sync-ops" src/ extensions/ --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v ".test.ts" | grep -v "mongodb-" | head -20
```

If new upstream files import deleted modules, they will cause build failures in Phase 5. Document them for fixing.

**Expected Artifacts:** All 10 Tier 2 files resolved (kept deleted).

**Required Checks:**

- 0 of the 10 deleted files exist on disk
- `git diff --name-only --diff-filter=U` count decreased by ~10

**Checkpoint Type:** Automatic

**Exit Criteria:** All modify/delete conflicts resolved, deleted files confirmed absent.

---

## Phase 4: Content Conflict Resolution (Tier 3 -- 8 files)

**Objective:** Resolve all remaining content conflicts.

**Inputs:** Phases 2-3 complete, only Tier 3 conflicts remain.

**Files/Surfaces:** The 8 Tier 3 conflict files.

**Dependencies:** Phase 3.

**Allowed Scope:** Only Tier 3 conflict files.

**Out-of-scope Drift:** Do NOT modify non-conflicted files.

### Resolution Group A: Accept Upstream (5 files -- safe, non-memory)

These files have upstream-only changes that do not touch MongoDB persistence. Accept theirs directly:

```bash
# Generated files (regenerated by build/tooling)
git checkout --theirs docs/.generated/config-baseline.jsonl && git add docs/.generated/config-baseline.jsonl
git checkout --theirs src/config/schema.base.generated.ts && git add src/config/schema.base.generated.ts

# Test files (upstream improvements)
git checkout --theirs extensions/discord/src/monitor/message-handler.preflight.acp-bindings.test.ts && git add extensions/discord/src/monitor/message-handler.preflight.acp-bindings.test.ts
git checkout --theirs src/agents/pi-extensions/compaction-safeguard.test.ts && git add src/agents/pi-extensions/compaction-safeguard.test.ts

# CLI (containerized instance targeting)
git checkout --theirs src/cli/command-format.ts && git add src/cli/command-format.ts
```

### Resolution Group B: Manual Merge (3 files)

**B1: README.md -- MANUAL merge**

```bash
git checkout --theirs README.md
```

Then re-apply our ClawMongo branding:

- Title: ClawMongo (not OpenClaw)
- Description: MongoDB-native fork
- Badge/links: our npm package, our repo
- Keep upstream's feature descriptions, installation instructions, and documentation links where they apply generically

```bash
git add README.md
```

**B2: package.json -- MANUAL merge (proven pattern from all 4 prior waves)**

```bash
git checkout --theirs package.json
```

Then re-apply our overrides:

- `"name": "@romiluz/clawmongo"`
- `"version"`: our current version (2026.3.30) or bump to sync version
- `"description"`: our ClawMongo description
- `"homepage"`: our homepage
- `"repository"`: our repository
- `"bin"`: our `clawmongo` alias
- `"dependencies"`: ensure `mongodb` is present (not just in pnpm.overrides)
- Remove: `"./plugin-sdk/memory-lancedb"` export if upstream re-added it

Verify new upstream exports are preserved:

- `./plugin-sdk/discord`
- `./plugin-sdk/memory-core`
- Any new `./plugin-sdk/*` exports from 573 commits

```bash
git add package.json
```

**B3: pnpm-lock.yaml -- Regenerate (proven pattern)**

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

**Expected Artifacts:** All 20 conflicts resolved.

**Required Checks:**

- 0 remaining conflicted files
- All mongodb-\* files unchanged
- package.json has `@romiluz/clawmongo` name + `mongodb` dependency
- No `./plugin-sdk/memory-lancedb` export in package.json

**Checkpoint Type:** Manual review of package.json and README.md

**Exit Criteria:** All conflicts resolved, MongoDB-first contract verified in all resolved files.

---

## Phase 5: Dependency Resolution and Build Gate

**Objective:** Regenerate lockfile, fix any new import breakage, achieve clean build.

**Inputs:** All 20 conflicts resolved, no unresolved markers.

**Files/Surfaces:** `pnpm-lock.yaml`, `node_modules/`, `dist/`, possibly new shim files.

**Dependencies:** Phase 4.

**Allowed Scope:** Dependency resolution, shim creation, build fixes.

**Out-of-scope Drift:** Do NOT fix test failures yet (that is Phase 6).

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

**Step 3: CHECK -- `manager-runtime.ts` import chain**

`src/memory/manager-runtime.ts` existed at the merge base and re-exports from `./manager.js`. We DELETED both `manager-runtime.ts` AND `manager.ts`. Check whether git brought it back:

```bash
ls src/memory/manager-runtime.ts 2>&1 | grep -v "No such file" && echo "DANGER: manager-runtime.ts exists" || echo "OK: manager-runtime.ts absent"
```

If it reappeared:

- **Option A (Preferred): Delete it** -- If nothing in production code imports it:

  ```bash
  grep -rn "manager-runtime" src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | grep -v "mongodb-"
  ```

  If only our search-manager.ts (which we kept as-is) references it: safe to delete.

  ```bash
  rm src/memory/manager-runtime.ts
  git add -u src/memory/manager-runtime.ts
  ```

- **Option B: Create a shim** -- If upstream files DO import `manager-runtime.js`:
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

**Step 4: Check for other dangling imports from deleted files**

573 upstream commits may have added new files that import from modules we deleted. Check:

```bash
grep -rn "manager-runtime\|qmd-manager\|memory-schema\|manager-sync-ops\|memory-lancedb" src/ extensions/ --include="*.ts" --include="*.js" 2>/dev/null | grep -v "node_modules" | grep -v ".test.ts" | grep -v "mongodb-"
```

For each hit:

- If it is a new upstream file importing a deleted module: create a shim that re-exports from our MongoDB equivalent, OR modify the import to use our path
- If it is in a file we do not own (e.g., upstream plugin): evaluate whether the plugin needs QMD and if so, stub it out

**Step 5: Verify new upstream lazy-load boundary files import safely**

Check key runtime files resolve correctly:

```bash
# memory-tool.runtime.ts should import from ../../memory/index.js (our barrel)
grep -n "import.*memory" src/agents/tools/memory-tool.runtime.ts 2>/dev/null || echo "memory-tool.runtime.ts not found or no memory imports"

# memory-cli.runtime.ts should import from ../memory/index.js (our barrel)
grep -n "import.*memory" src/cli/memory-cli.runtime.ts 2>/dev/null || echo "memory-cli.runtime.ts not found or no memory imports"
```

If either imports from `manager-runtime.js` or `qmd-manager.js`: create shim or redirect.

**Step 6: Build**

```bash
pnpm build
```

Expected: Exit 0. If TS errors:

- Categorize as: (a) import-path errors from refactored upstream modules, (b) type errors from new upstream APIs, (c) errors from deleted modules
- Fix category (a) by updating import paths
- Fix category (b) by adding type annotations or adapters
- Fix category (c) by creating shims or removing dead imports

**Step 7: Check for INEFFECTIVE_DYNAMIC_IMPORT warnings**

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

**Dependencies:** Phase 5.

**Allowed Scope:** Run tests, fix test failures caused by the merge.

**Out-of-scope Drift:** Do NOT fix pre-existing test failures unrelated to the merge.

**Steps:**

**Step 1: Run memory-specific tests first (highest priority)**

```bash
pnpm test -- src/memory/
```

Expected: All MongoDB memory tests pass. Pre-merge baseline:

- 70 mongodb-\*.ts files (production + test)
- All v2 unit tests passing
- Known pre-existing: some TS type errors in test files (baseline, not runtime failures)

**Step 2: Run agent tests (covers compaction, system-prompt, memory-tool)**

```bash
pnpm test -- src/agents/
```

Expected: Agent tests pass. Key areas to watch:

- `compaction-safeguard` (upstream refactored cancel reasons)
- `memory-tool` (upstream lazy-load changes)
- `system-prompt` (verify buildMongoDBBridgeSection still present and called)

**Step 3: Run plugin and extension tests**

```bash
pnpm test -- src/plugins/ extensions/
```

Expected: Plugin tests pass. Key areas:

- `extensions/memory-core/` (verify no LanceDB leakage)
- `extensions/discord/` (upstream security hardening)

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

# All v2 modules still exported from barrel
grep -c "mongodb-events\|mongodb-graph\|mongodb-episodes\|mongodb-ops\|mongodb-retrieval-planner\|mongodb-mutations\|mongodb-analytics\|mongodb-entity-extractor" src/memory/index.ts

# MongoDB manager cache pattern intact
grep -c "MONGODB_MANAGER_CACHE" src/memory/search-manager.ts

# Source policy enforcement intact
grep -c "buildMongoDBCacheKey\|stableSerialize" src/memory/search-manager.ts
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
- MONGODB_MANAGER_CACHE present in search-manager.ts
- buildMongoDBCacheKey and stableSerialize present

**Checkpoint Type:** Automatic (fix test failures iteratively)

**Exit Criteria:** Tests pass at or above pre-merge baseline, protected seams verified.

---

## Phase 7: MongoDB-First Contract Audit

**Objective:** Final sweep to ensure no QMD/SQLite/LanceDB truth leaked into production code.

**Inputs:** Build and tests pass from Phases 5-6.

**Files/Surfaces:** Entire `src/` and `extensions/` tree.

**Dependencies:** Phase 6.

**Allowed Scope:** Read-only audit. Fix any violations found.

**Out-of-scope Drift:** Do NOT make feature changes.

**Steps:**

**Step 1: Scan for QMD/SQLite/LanceDB references in production code**

```bash
# Production files only (exclude tests, node_modules, dist)
grep -rn "qmd\|QMD\|QmdMemoryManager\|qmd-manager\|QmdStatusOnlyManager\|BorrowedMemoryManager\|FallbackMemoryManager" src/ extensions/ --include="*.ts" 2>/dev/null | grep -v ".test.ts" | grep -v "node_modules" | grep -v "dist/" | grep -v "// upstream" | grep -v "CHANGELOG"
```

For each hit, classify:

- **Type reference only** (e.g., `ResolvedQmdConfig` in a union type): acceptable if our code never reaches that branch
- **Executable path** (e.g., `if (resolved.backend === "qmd")`): MUST be dead code or removed
- **Import of deleted module** (e.g., `import { QmdMemoryManager } from "./qmd-manager.js"`): build would have caught this, but verify

```bash
grep -rn "sqlite\|SQLite\|lancedb\|LanceDB" src/ extensions/ --include="*.ts" 2>/dev/null | grep -v ".test.ts" | grep -v "node_modules" | grep -v "dist/" | grep -v "// " | grep -v "CHANGELOG"
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

**Step 5: Verify excluded paths are actually absent**

```bash
for f in "extensions/memory-lancedb/index.ts" "extensions/memory-lancedb/index.test.ts" "src/memory/manager.ts" "src/memory/manager-sync-ops.ts" "src/memory/qmd-manager.ts" "src/plugin-sdk/memory-lancedb.ts" "src/memory/index.test.ts"; do
  [ -f "$f" ] && echo "DANGER: $f still exists" || true
done
echo "OK: excluded paths scan complete"
```

**Expected Artifacts:** Clean audit report, zero QMD/SQLite/LanceDB truth in production paths.

**Required Checks:**

- Zero executable QMD paths in production code
- Zero SQLite/LanceDB references in production code
- `memory-lancedb` not in package.json exports
- `mongodb` in package.json dependencies
- mongodb-schema.ts unchanged (23 collections, 62+ indexes)
- All excluded paths absent

**Checkpoint Type:** Manual review if any QMD references found

**Exit Criteria:** MongoDB-first contract verified, zero foreign memory truth.

---

## Phase 8: Commit and Verification

**Objective:** Create proper merge commit, verify integrity, clean up.

**Inputs:** All phases 0-7 pass.

**Files/Surfaces:** Merge commit, `.gitattributes`, git config.

**Dependencies:** Phase 7.

**Allowed Scope:** Commit, verify, clean up.

**Out-of-scope Drift:** Do NOT push yet (that is Phase 9).

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
git diff --cached --stat | tail -10
```

**Step 4: Create merge commit**

```bash
git commit --no-verify -m "Merge upstream/main: absorb 573 upstream commits (wave 5)

Wave 5 upstream sync: 573 commits from OpenClaw upstream.
Resolved 20 conflicts preserving MongoDB-first contract.
Protected seams: search-manager.ts (MongoDB-only), 70 mongodb-* files untouched.
Deleted surfaces: LanceDB extension, QMD manager, memory-schema (QMD).
New upstream features: channel security hardening, Microsoft Foundry, compaction improvements, sandbox fixes, rate limiting.
"
```

Note: `--no-verify` used because pre-existing TS errors in test files trigger pre-commit hooks. Same pattern as Waves 1-4.

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

Expected: `~302 0` (301 ours + 1 merge commit, 0 behind).

**Step 7: Final validation suite**

```bash
pnpm build && pnpm test && pnpm check
```

All three must pass.

**Step 8: Delete backup branch**

```bash
git update-ref -d refs/heads/pre-upstream-merge-wave5-backup
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

**Dependencies:** Phase 8.

**Allowed Scope:** Push, test, publish.

**Out-of-scope Drift:** Do NOT make code changes. If issues found, create a follow-up task.

**Steps:**

**Step 1: Push**

```bash
git push origin main
```

**Step 2: Run live e2e tests (if MongoDB available)**

```bash
MONGODB_TEST_URI=<uri> pnpm test -- src/memory/mongodb-e2e.e2e.test.ts
```

Expected: All e2e scenarios pass (event->chunk projection, structured scope, graph expansion, episode materialization, migration backfill, retrieval planner, semantic cache, telemetry, mutations, procedures).

If MONGODB_TEST_URI not set: skip and document as deferred.

**Step 3: Bump version and publish (if desired)**

```bash
# Update version in package.json (e.g., 2026.3.26)
# npm publish
```

**Expected Artifacts:** Pushed merge commit, optionally published npm package.

**Required Checks:**

- Push succeeds
- Live e2e pass (or documented as deferred)

**Checkpoint Type:** Manual (push + optional publish)

**Exit Criteria:** Merged, built, tested, pushed. Upstream sync wave 5 complete.

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
11. **git merge-tree --write-tree** is authoritative for conflict prediction
12. **search-manager.ts** is ALWAYS KEEP OURS -- 114-line MongoDB-only version
13. **Package.json** is ALWAYS accept-theirs-then-reapply-overrides pattern
14. **pnpm-lock.yaml** is ALWAYS accept-theirs-then-regenerate pattern
15. **WhatsApp setup-surface.test.ts** was deleted upstream in this wave -- accept the deletion

---

## Behavior Contract (Critical-Path Verification)

### Invariants That MUST Hold After Merge

| #   | Property                          | Verification                                                                                             | Pass Criteria                           |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | MongoDB is sole memory backend    | `grep -rn "QmdMemoryManager\|FallbackMemoryManager\|BorrowedMemoryManager" src/memory/search-manager.ts` | Zero hits                               |
| 2   | No QMD executable paths           | `grep -rn "backend.*qmd\|qmd-manager" src/ --include="*.ts" \| grep -v test \| grep -v node_modules`     | Zero executable hits                    |
| 3   | No LanceDB surfaces               | `grep -rn "lancedb\|LanceDB" package.json src/ extensions/ \| grep -v node_modules \| grep -v CHANGELOG` | Zero hits (or comments only)            |
| 4   | search-manager.ts is MongoDB-only | Manual review of entire 114-line file                                                                    | No QMD imports, no QMD class references |
| 5   | 70 mongodb-\* files untouched     | `git diff --cached --name-only -- 'src/memory/mongodb-*'` during merge                                   | Empty                                   |
| 6   | Package name preserved            | `node -e "console.log(require('./package.json').name)"`                                                  | `@romiluz/clawmongo`                    |
| 7   | MongoDB in dependencies           | `node -e "console.log('mongodb' in require('./package.json').dependencies)"`                             | `true`                                  |
| 8   | sessionId in compact.ts           | `grep -c "sessionId" src/agents/pi-embedded-runner/compact.ts`                                           | >= 1                                    |
| 9   | sessionId in attempt.ts           | `grep -c "sessionId" src/agents/pi-embedded-runner/run/attempt.ts`                                       | >= 1                                    |
| 10  | buildMongoDBBridgeSection present | `grep -c "buildMongoDBBridgeSection" src/agents/system-prompt.ts`                                        | >= 2                                    |
| 11  | Build passes                      | `pnpm build`                                                                                             | exit 0                                  |
| 12  | Tests pass                        | `pnpm test`                                                                                              | >= pre-merge baseline                   |
| 13  | 2-parent merge commit             | `git cat-file -p HEAD \| grep "^parent" \| wc -l`                                                        | 2                                       |
| 14  | MONGODB_MANAGER_CACHE present     | `grep -c "MONGODB_MANAGER_CACHE" src/memory/search-manager.ts`                                           | >= 1                                    |
| 15  | buildMongoDBCacheKey exported     | `grep -c "buildMongoDBCacheKey" src/memory/search-manager.ts`                                            | >= 2                                    |
| 16  | stableSerialize present           | `grep -c "stableSerialize" src/memory/search-manager.ts`                                                 | >= 2                                    |
| 17  | 23 collections preserved          | `grep -c "23 collections" src/memory/mongodb-schema.test.ts`                                             | >= 1                                    |
| 18  | 62+ indexes preserved             | `grep "EXPECTED_STANDARD_INDEX_COUNT" src/memory/mongodb-e2e.e2e.test.ts`                                | = 62                                    |
| 19  | No memory-lancedb export          | `grep "memory-lancedb" package.json`                                                                     | Zero hits                               |
| 20  | Excluded paths absent             | `ls src/memory/manager.ts src/memory/qmd-manager.ts 2>&1`                                                | "No such file" for all                  |

### Edge-Case Catalog

| Edge Case                                                       | Handling                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| New upstream file imports deleted module (`manager-runtime.js`) | Create shim re-exporting from MongoDB equivalent (Phase 5 Step 3-4) |
| Upstream added new memory-lancedb export to package.json        | Remove it (Phase 4 B2)                                              |
| Upstream changed `resolveMemoryBackendConfig` return type       | Our backend-config.ts is protected by merge=ours                    |
| New upstream test file references QMD test helpers              | Delete or stub the test                                             |
| Upstream added new config key for QMD                           | Accepted via schema.ts but never exercised (dead code)              |
| `manager-runtime.ts` reappears after merge                      | Delete if no production imports; shim if needed (Phase 5)           |
| `memory-cli.runtime.ts` imports QMD paths                       | Create shim or redirect to MongoDB paths                            |
| New upstream file uses `QMD_MANAGER_CACHE` symbol               | Irrelevant -- our search-manager.ts uses MONGODB_MANAGER_CACHE      |
| Upstream added `resolveGlobalSingleton` dependency              | Accept as utility; do NOT wire into search-manager.ts during sync   |
| WhatsApp setup-surface.test.ts conflict                         | Accept upstream deletion (they refactored test suites)              |
| README.md conflict                                              | Accept theirs, re-apply ClawMongo branding                          |
| Generated config baseline conflict                              | Accept theirs (regenerated file)                                    |

### Provable Properties

1. **No QMD execution**: After merge, no production code path can instantiate QmdMemoryManager (file deleted, no import path exists)
2. **No LanceDB execution**: After merge, LanceDB extension directory does not exist, no export in package.json
3. **MongoDB singleton**: search-manager.ts creates exactly one MongoDBMemoryManager per (agentId, config) tuple via stableSerialize cache key
4. **Protected seam integrity**: All 70 mongodb-\* files are byte-identical pre/post merge (merge=ours for non-conflicted, upstream never touches them)
5. **Source policy preservation**: buildMongoDBCacheKey includes source config in cache key, ensuring policy changes produce cache misses

---

## Risks and Mitigations

| Risk                                                                            | P   | I   | Score | Mitigation                                                                       |
| ------------------------------------------------------------------------------- | --- | --- | ----- | -------------------------------------------------------------------------------- |
| search-manager.ts loses MongoDB path during merge                               | 2   | 5   | 10    | KEEP OURS strategy, manual verification in Phase 2, 6 behavioral contract checks |
| New upstream lazy-load boundaries import deleted modules                        | 3   | 4   | 12    | Phase 5 Steps 3-5 explicitly check for dangling imports; shim creation           |
| package.json loses MongoDB dep or name                                          | 2   | 5   | 10    | Manual resolution (proven pattern x4); field-by-field verification               |
| memory-lancedb re-added by upstream                                             | 3   | 3   | 9     | Phase 7 audit; Phase 4 B2 removes export                                         |
| Unexpected conflict in mongodb-\* file                                          | 1   | 5   | 5     | Phase 1 Step 3 check; merge-tree prediction; merge=ours backup                   |
| New upstream code calls `resolveMemoryBackendConfig` expecting QMD return shape | 3   | 3   | 9     | Build gate (Phase 5) catches type errors; shim if needed                         |
| 573 commits introduce subtle behavioral regressions                             | 2   | 3   | 6     | Full test suite gate; memory-specific test gate; live e2e                        |
| compact.ts/attempt.ts sessionId wiring lost                                     | 2   | 4   | 8     | Explicit grep check in Phase 6 Step 6                                            |
| pnpm install fails with 573 commits of dependency changes                       | 2   | 3   | 6     | Backup branch for rollback; accept --theirs lockfile then regenerate             |
| Pre-commit hooks block merge commit                                             | 3   | 1   | 3     | --no-verify flag (proven, pre-existing TS errors in test files)                  |
| WhatsApp test deletion causes test suite count drop                             | 1   | 1   | 1     | Expected -- upstream refactored these tests elsewhere                            |

---

## Success Criteria

- [ ] 0 behind upstream/main
- [ ] `pnpm build` exits 0
- [ ] `pnpm test` passes at or above pre-merge baseline
- [ ] 2-parent merge commit verified
- [ ] search-manager.ts is MongoDB-only (zero QMD/LanceDB imports)
- [ ] All 70 mongodb-\* files unchanged
- [ ] Package.json has `@romiluz/clawmongo` name + `mongodb` dependency
- [ ] No `memory-lancedb` export in package.json
- [ ] `buildMongoDBBridgeSection` present in system-prompt.ts
- [ ] `memoryBackend` wiring present in compact.ts
- [ ] sessionId in BOTH compact.ts and attempt.ts
- [ ] Zero executable QMD/SQLite/LanceDB paths in production code
- [ ] 23 collections, 62+ indexes preserved in mongodb-schema.ts
- [ ] MONGODB_MANAGER_CACHE + buildMongoDBCacheKey + stableSerialize intact
- [ ] All excluded paths (manager.ts, qmd-manager.ts, etc.) absent
- [ ] Pushed to origin/main

---

## Summary

- **Total commits:** 573 upstream
- **Predicted conflicts:** 20 (8 content + 2 memory truth + 10 modify/delete)
- **Resolution tiers:** 3 (Memory Truth first, then Deletions, then Content)
- **Phases:** 10 (0-9)
- **Critical file:** `src/memory/search-manager.ts` (KEEP OURS, MongoDB-only, 114 lines)
- **Key risk:** New upstream lazy-load boundaries importing deleted QMD modules (Score: 12)
- **Proven pattern:** Same merge strategy as Waves 1 (729), 2 (50), 3 (768), and 4 (~40), now at Wave 5
- **Post-sync:** 23 MongoDB collections, 62+ indexes, 70 mongodb-\* files preserved
