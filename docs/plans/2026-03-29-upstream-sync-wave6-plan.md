# Upstream Sync Wave 6 -- Absorb ~1,098 Commits (Memory Plugin Refactor)

> **For Claude:** REQUIRED: Follow this plan phase-by-phase. Do NOT switch branches, stash, or run `git checkout` on modified files during uncommitted merge state. The MongoDB-first contract is inviolable: no QMD, SQLite, LanceDB, or Markdown memory truth may enter. When resolving conflicts, use `git show HEAD:path > /tmp/copy` instead of `git checkout` for inspection.
> **Design:** See `docs/plans/2026-03-29-upstream-sync-wave6-design.md` for full specification.
> **Prior Art:** Waves 1-5 absorbed ~2,160 upstream commits total -- all successful. Wave 6 is the most complex wave yet due to upstream's memory-to-plugin architectural refactor.

**Goal:** Merge ~1,098 upstream commits into ClawMongo via `git merge upstream/main --no-commit`, resolve 183 predicted conflicts using the HYBRID strategy (accept upstream plugin infrastructure as dead code, preserve our MongoDB memory intact), wire our MongoDB manager through upstream's new plugin bridge, and ship a clean build+test.

**Architecture:** Single merge, phased conflict resolution. HYBRID approach: accept upstream's new plugin system + `packages/memory-host-sdk/` + `extensions/memory-core/` as-is, keep our entire `src/memory/` directory (146 files: 72 mongodb-\*.ts + 74 shared/embedding/utility) alive alongside them, register our MongoDB manager as the plugin runtime via `registerMemoryRuntime()` so upstream callers of `getActiveMemorySearchManager()` get our MongoDB manager.

**Tech Stack:** Git merge, pnpm, TypeScript, Vitest, MongoDB

**Prerequisites:**

- `git fetch upstream` done (308 ahead / ~1,098 behind confirmed)
- Working tree clean (confirmed via git status)
- All prior agentic search hardening work committed on main
- Backup branch created before merge
- Last published: `@romiluz/clawmongo@2026.3.33`

**Durable Decisions:**

- MongoDB is the sole runtime backend. Upstream plugin code exists in repo but never executes.
- `src/memory/` directory is sacred. All 146 files stay at their current paths.
- Embedding files remain in `src/memory/` (not moved to `packages/memory-host-sdk/`). Upstream's copies in `memory-host-sdk` are their plugin infrastructure -- ours stay.
- `memory-tool.ts` + `memory-tool.runtime.ts` stay as our tool registration path (upstream deleted them and moved to plugin `api.registerTool()`).
- `server-startup-memory.ts` keeps importing from `../memory/` paths (not `../plugins/memory-runtime.js`). It ALSO registers our MongoDB manager as the `MemoryPluginRuntime` via `registerMemoryRuntime()` so upstream callers of `getActiveMemorySearchManager()` get MongoDB.
- `system-prompt.ts` keeps our inline `buildMemorySection` + `buildMongoDBBridgeSection` (upstream moved to plugin `buildMemoryPromptSection`).
- `extensions/memory-lancedb/`: Accept upstream version as dead code (same treatment as `extensions/memory-core/`). It never runs in ClawMongo but keeping it minimizes future sync friction.
- `src/memory/prompt-section.ts`: Protected path. Restored from HEAD by Phase 2. Our version is a minimal singleton builder for memory prompt sections.

---

## What Changed Upstream (THE BIG PICTURE)

### The Nuclear Change: Memory Became a Plugin

Upstream gutted `src/memory/` entirely (all files deleted or renamed) and refactored memory into:

| New Location                    | What                                                    | Details                                        |
| ------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| `packages/memory-host-sdk/`     | Embedding, batch, host SDK (new package)                | Embedding/batch files moved from `src/memory/` |
| `extensions/memory-core/`       | Bundled SQLite memory plugin (renamed from src/memory/) | Manager, search, QMD files moved here          |
| `extensions/memory-lancedb/`    | LanceDB alternative plugin (updated)                    | Minor                                          |
| `src/plugins/memory-state.ts`   | Plugin bridge (runtime singleton)                       | New: 124 lines, registers prompt/flush/runtime |
| `src/plugins/memory-runtime.ts` | Active memory manager accessor                          | New: routes through plugin bridge              |

Memory tools (`memory_search`, `memory_get`) now register via `extensions/memory-core/index.ts` using `api.registerTool()` instead of our direct `src/agents/tools/memory-tool.ts`.

### Non-Memory Changes (3,300+ files)

- Provider plugin refactor: XAI, Bedrock, Mistral moved into plugins
- Channel metadata derivation from manifests
- 14K-line generated channel config
- ACP harness improvements (cursor support)
- Security fixes (HTTP scope checks, web search key audit)
- Telegram fixes (empty reply guard, long message splitting, reply validation)
- CLI improvements (zsh compdef, dashboard UX)
- Test infrastructure (vitest configs, topology analyzer)
- Plugin SDK expansion (215 files changed)

---

## The HYBRID Strategy

### What We ACCEPT from upstream:

1. `packages/memory-host-sdk/` -- take as-is (new package, embedding files at new location)
2. `extensions/memory-core/` -- take as-is (their SQLite plugin, not ours)
3. `extensions/memory-lancedb/` -- ACCEPT UPSTREAM version (dead code for us, but keeps future syncs clean)
4. `src/plugins/memory-state.ts` and `memory-runtime.ts` -- take as-is (we register our MongoDB manager as the runtime via `registerMemoryRuntime()` so upstream callers work)
5. ALL non-memory changes (channels, providers, config, agents, UI, tests, etc.)
6. The plugin slot architecture (`plugins.slots.memory`)

### What We KEEP (MongoDB-first, non-negotiable):

1. ALL 72 `src/memory/mongodb-*.ts` files UNTOUCHED
2. ALL 74 shared/embedding/utility files in `src/memory/` (types.ts, internal.ts, search-utils.ts, embeddings.ts, batch-\*.ts, etc.)
3. `src/memory/search-manager.ts` -- our MongoDB-only version (114 lines)
4. `src/memory/index.ts` -- our barrel exports (158 lines)
5. `src/memory/backend-config.ts` -- our MongoDB backend resolver
6. `src/agents/tools/memory-tool.ts` + `memory-tool.runtime.ts` -- our tool registration
7. `src/agents/system-prompt.ts` -- our inline `buildMemorySection` + `buildMongoDBBridgeSection`
8. `src/gateway/server-startup-memory.ts` -- our `../memory/` import paths

### What We WIRE (the bridge):

1. Register our MongoDB manager as the `MemoryPluginRuntime` in `src/gateway/server-startup-memory.ts` by calling `registerMemoryRuntime()` from `src/plugins/memory-state.ts`. This ensures 5 upstream production callers of `getActiveMemorySearchManager()` (compaction-hooks.ts, doctor-memory-search.ts, status.scan.deps.runtime.ts, doctor.ts, server-startup-memory.ts) get our MongoDB manager instead of null.
2. Keep `src/gateway/server-startup-memory.ts` importing from `../memory/` paths (not `../plugins/memory-runtime.js`)
3. Ensure `src/agents/tools/memory-tool.ts` remains the tool registration path
4. Keep `buildMongoDBBridgeSection` in system-prompt for sub-agent wiring
5. Accept `src/plugins/memory-state.ts` as-is (no patch needed -- it's a registry, we register into it)

---

## Context References

### Verified Codebase Facts (from dry-run merge-tree)

**Conflict summary (183 total):**

| Conflict Type                                      | Count | Resolution                                     |
| -------------------------------------------------- | ----- | ---------------------------------------------- |
| `file location` (git suggests moves)               | 79    | REJECT suggestion, keep files in `src/memory/` |
| `rename/delete` (we deleted, upstream renamed)     | 38    | ACCEPT UPSTREAM at new location                |
| `modify/delete` (one side deleted, other modified) | 35    | Case-by-case: 6 KEEP OURS, 29 ACCEPT UPSTREAM  |
| `content` (both sides modified)                    | 31    | Case-by-case manual resolution                 |

**CRITICAL: File Location Conflicts (79)**

Git detected that upstream renamed `src/memory/` to `packages/memory-host-sdk/src/host/` and suggests our mongodb-\*.ts files should move there too. This is WRONG. Resolution for ALL 79:

```bash
# Keep our files at src/memory/, tell git they are NOT renamed
git checkout HEAD -- src/memory/mongodb-*.ts
git checkout HEAD -- src/memory/production-readiness.e2e.test.ts
git checkout HEAD -- src/memory/real-e2e-v2.e2e.test.ts
git checkout HEAD -- src/memory/runtime-write.e2e.test.ts
git checkout HEAD -- src/memory/runtime-write.ts
git checkout HEAD -- src/memory/search-utils.ts
git checkout HEAD -- src/memory/embedding-model-limits.test.ts
git checkout HEAD -- src/memory/memory-md-deprecation.test.ts
git add src/memory/
```

**Content Conflicts (31 files):**

| File                                                       | Resolution                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `CHANGELOG.md`                                             | MANUAL: merge both sides                                        |
| `docs/.generated/config-baseline.jsonl`                    | ACCEPT UPSTREAM                                                 |
| `docs/.generated/plugin-sdk-api-baseline.json`             | ACCEPT UPSTREAM                                                 |
| `docs/.generated/plugin-sdk-api-baseline.jsonl`            | ACCEPT UPSTREAM                                                 |
| `docs/reference/memory-config.md`                          | MANUAL: accept upstream + re-add MongoDB sections               |
| `extensions/memory-core/index.test.ts`                     | ACCEPT UPSTREAM                                                 |
| `extensions/memory-core/index.ts`                          | ACCEPT UPSTREAM                                                 |
| `extensions/memory-core/src/memory/index.ts`               | ACCEPT UPSTREAM                                                 |
| `extensions/memory-core/src/memory/search-manager.test.ts` | ACCEPT UPSTREAM                                                 |
| `extensions/memory-core/src/memory/search-manager.ts`      | ACCEPT UPSTREAM (their plugin's SM, not ours)                   |
| `extensions/memory-core/src/tools.citations.test.ts`       | ACCEPT UPSTREAM                                                 |
| `package.json`                                             | MANUAL: accept upstream + re-apply ClawMongo overrides          |
| `packages/memory-host-sdk/src/host/backend-config.test.ts` | ACCEPT UPSTREAM                                                 |
| `packages/memory-host-sdk/src/host/backend-config.ts`      | ACCEPT UPSTREAM                                                 |
| `pnpm-lock.yaml`                                           | DELETE AND REGENERATE                                           |
| `src/agents/memory-search.ts`                              | MANUAL: merge carefully, preserve our MongoDB paths             |
| `src/agents/pi-embedded-runner/usage-reporting.test.ts`    | ACCEPT UPSTREAM                                                 |
| `src/agents/system-prompt.ts`                              | MANUAL: keep our buildMemorySection + buildMongoDBBridgeSection |
| `src/auto-reply/reply/memory-flush.ts`                     | MANUAL: merge, verify memory flush paths                        |
| `src/auto-reply/reply/reply-state.test.ts`                 | MANUAL: merge                                                   |
| `src/commands/doctor-memory-search.test.ts`                | MANUAL: keep our MongoDB search-manager imports                 |
| `src/commands/doctor-memory-search.ts`                     | MANUAL: keep our MongoDB imports                                |
| `src/commands/doctor.ts`                                   | MANUAL: merge, check memory references                          |
| `src/config/schema.base.generated.ts`                      | ACCEPT UPSTREAM (regenerate later)                              |
| `src/gateway/server-startup-memory.test.ts`                | MANUAL: keep our import paths                                   |
| `src/gateway/server-startup-memory.ts`                     | MANUAL: keep `../memory/` imports                               |
| `src/plugins/bundled-plugin-metadata.generated.ts`         | ACCEPT UPSTREAM                                                 |
| `src/plugins/provider-auth-choice-preference.ts`           | ACCEPT UPSTREAM                                                 |
| `src/plugins/provider-runtime.test.ts`                     | ACCEPT UPSTREAM                                                 |
| `src/plugins/runtime/types-core.ts`                        | ACCEPT UPSTREAM                                                 |
| `test/helpers/extensions/plugin-runtime-mock.ts`           | ACCEPT UPSTREAM                                                 |

**Modify/Delete Conflicts -- KEEP OURS (6 files):**

Files upstream deleted but we modified. We must KEEP OURS:

| File                                                      | Why                           |
| --------------------------------------------------------- | ----------------------------- |
| `src/agents/tools/memory-tool.ts`                         | Our MongoDB tool registration |
| `src/agents/tools/memory-tool.runtime.ts`                 | Our MongoDB tool runtime      |
| `src/auto-reply/reply/memory-flush.test.ts`               | Our test for memory flush     |
| `src/plugins/bundled-runtime-deps.test.ts`                | Our test                      |
| `src/plugins/install-min-host-version-guardrails.test.ts` | Our test                      |
| `src/plugins/runtime/runtime-tools.ts`                    | Our tool runtime              |

**Modify/Delete Conflicts -- ACCEPT UPSTREAM (29 files):**

Files we previously deleted from `extensions/memory-core/` or `packages/memory-host-sdk/` that upstream modified. Accept upstream's version at the new location:

- 22 files in `extensions/memory-core/src/memory/` (manager, mmr, qmd, test helpers)
- 3 files in `extensions/memory-lancedb/` (index.ts, index.test.ts, package.json)
- 4 files in `packages/memory-host-sdk/src/host/` (qmd-\*.ts, sqlite.ts)

**Rename/Delete Conflicts (38 files):**

Files upstream renamed from `src/memory/` to new locations that we already deleted. Accept upstream version at destination:

- 20 files to `extensions/memory-core/src/memory/` (manager, hybrid, mmr, temporal-decay, test files)
- 14 files to `packages/memory-host-sdk/src/host/` (qmd-_, sqlite-_, memory-schema)
- 4 files to `extensions/memory-core/src/memory/` (test-runtime-mocks, manager-runtime, etc.)

### Our MongoDB Files -- Import Dependencies

Our 72 `mongodb-*.ts` files import from these shared files (MUST be restored):

- `./types.js` -- 26 MongoDB files import from here (MemorySearchResult, etc.)
- `./internal.js` -- mongodb-sync.ts, mongodb-kb.ts, mongodb-manager.ts
- `./search-utils.js` -- mongodb-search-executor.ts, mongodb-schema.ts
- `./mongodb-embedding-retry.js` -- mongodb-analytics.ts, mongodb-structured-memory.ts, mongodb-kb.ts, mongodb-sync.ts

Our MongoDB files do NOT import from `./embedding*.js` or `./batch*.js` directly. Embedding dependencies only flow through `mongodb-embedding-retry.ts` which is itself a `mongodb-*.ts` file.

### Excluded Paths (current state)

File: `scripts/upstream-excluded-paths.txt` currently has:

- `extensions/memory-lancedb/` (RECONSIDER: upstream updated it, now a proper plugin)
- `scripts/sqlite-vec-smoke.mjs`
- `src/memory/index.test.ts` (upstream renamed to `extensions/memory-core/`)
- `src/memory/manager-embedding-ops.ts` (upstream renamed)
- `src/memory/manager-sync-ops.ts` (upstream renamed)
- `src/memory/manager.ts` (upstream renamed)
- `src/memory/manager.watcher-config.test.ts` (upstream renamed)
- `src/memory/qmd-manager.ts` (upstream renamed)
- `src/memory/qmd-process.ts` (upstream renamed)
- `src/plugin-sdk/memory-lancedb.ts`

**Updates needed:** Remove entries for files that no longer exist at their old `src/memory/` paths (upstream renamed them). These are no longer "excluded" because they live at new canonical paths. Keep: `scripts/sqlite-vec-smoke.mjs`, `src/plugin-sdk/memory-lancedb.ts`. Add any new exclusions identified during merge.

### Protected Paths (current state)

File: `scripts/upstream-protected-paths.txt` currently has 38 entries. Key ones:

- `src/memory/search-manager.ts` -- KEEP (still critical)
- `src/memory/backend-config.ts` -- KEEP (still critical)
- `src/memory/internal.ts` -- KEEP (still critical)
- `src/memory/mongodb-*.ts` (6 specific ones listed)

**Updates needed:** Add `src/plugins/memory-state.ts` and `src/plugins/memory-runtime.ts`. All existing entries for `src/memory/` paths remain valid since we keep these files.

---

## Fresh Review Resolution

**Review Pass 1 Findings (2 BLOCKING, 5 ADVISORY):**

### Accepted Findings:

1. **BLOCKING 1: memory-state.ts contradiction** -- ACCEPTED and RESOLVED.
   - Root cause: Plan said "patch memory-state.ts" in WIRE section but "accept as-is" in Phase 6.
   - Investigation: `git grep` on upstream/main found 5 production callers of `getActiveMemorySearchManager()`.
   - Resolution: Neither "patch" nor "accept as-is" was correct. The correct approach is to REGISTER our MongoDB manager into the existing registry via `registerMemoryRuntime()`. Updated WIRE section, Durable Decisions, Phase 6, and commit message.

2. **BLOCKING 2: 16 unreviewed protected paths** -- ACCEPTED and RESOLVED.
   - Added comprehensive Step 9 to Phase 7 that enumerates all 38+ protected paths, checks upstream changes, and provides explicit review guidance for each changed file.
   - Pre-verified: 6 mongodb-\*.ts files are auto-restored by Phase 2. 2 files (`deliver.ts`, `outbound-send-service.ts`) are UNCHANGED. 12 files need explicit review.
   - Added behavioral invariant #22 requiring all protected paths accounted for.

3. **ADVISORY 3: Design file count 79 vs 72** -- ACCEPTED. Fixed both design success criteria and architecture diagram to use 72.

4. **ADVISORY 4: LanceDB checkpoint ordering** -- ACCEPTED. Moved `extensions/memory-lancedb/` decision to Durable Decisions (accept as dead code). Removed CHECKPOINT marker from Phase 7.

5. **ADVISORY 5: Missing patch code** -- ACCEPTED. Added implementation guidance in Phase 6 step 3 showing the `registerMemoryRuntime()` adapter pattern with code skeleton.

6. **ADVISORY 6: Phase 2 new-file check** -- ACCEPTED. Added step 3 to Phase 2 that verifies no unexpected new upstream files landed in `src/memory/`. Pre-verified: upstream added zero new files.

7. **ADVISORY 7: prompt-section.ts unprotected** -- ACCEPTED. Added to Durable Decisions and to `scripts/upstream-protected-paths.txt` update in Phase 7 step 7.

### Rejected Findings:

- None. All findings were valid.

---

## Phase 0: Pre-Flight and Backup

**Objective:** Create safety net, verify state, record baselines.

**Inputs:** Clean working tree, upstream fetched.
**Files:** None modified.
**Dependencies:** None.
**Allowed scope:** Read-only verification + backup branch creation.
**Out-of-scope drift:** No code changes, no merging.

**Steps:**

1. Verify clean working tree: `git status`
2. Fetch upstream: `git fetch upstream`
3. Confirm drift: `git rev-list --count HEAD..upstream/main` (expect ~1,098)
4. Confirm ahead count: `git rev-list --count upstream/main..HEAD` (expect ~308)
5. Create backup branch: `git branch pre-upstream-merge-wave6-backup`
6. Record current test baseline: `pnpm test -- src/memory/ --reporter=verbose 2>&1 | tail -20`
7. Record MongoDB file count: `ls src/memory/mongodb-*.ts | wc -l` (expect 72)
8. Record total memory file count: `ls src/memory/*.ts | wc -l` (expect 146)

**Expected artifacts:** Backup branch, baseline counts recorded.
**Required checks:** Backup branch exists, working tree clean, upstream fetched.
**Checkpoint type:** none
**Exit criteria:** `git branch --list pre-upstream-merge-wave6-backup` returns a result. `git rev-list --count HEAD..upstream/main` returns ~1,098. Working tree is clean.

---

## Phase 1: Execute Merge (No Commit)

**Objective:** Start the merge and capture the full conflict list.

**Inputs:** Clean working tree, upstream fetched, backup branch exists.
**Files:** All files in working tree (merge operation).
**Dependencies:** Phase 0 complete.
**Allowed scope:** Only the merge command and conflict recording.
**Out-of-scope drift:** No conflict resolution in this phase.

**Steps:**

1. Execute: `git merge upstream/main --no-commit --no-ff`
2. Record all CONFLICT lines: `git merge upstream/main --no-commit --no-ff 2>&1 | grep "CONFLICT" > /tmp/wave6-conflicts.txt`
3. Count conflicts: `wc -l /tmp/wave6-conflicts.txt` (expect ~183)
4. Verify our 72 MongoDB files still exist: `ls src/memory/mongodb-*.ts | wc -l` (expect 72)
5. Verify `packages/memory-host-sdk/` arrived: `ls packages/memory-host-sdk/package.json`
6. Verify `src/plugins/memory-state.ts` arrived: `ls src/plugins/memory-state.ts`

**Expected artifacts:** `/tmp/wave6-conflicts.txt` with full conflict list.
**Required checks:** Merge in progress, conflict list captured, MongoDB files present.
**Checkpoint type:** none
**Exit criteria:** `git diff --name-only --diff-filter=U | wc -l` returns >0. MongoDB files exist. `packages/memory-host-sdk/package.json` exists.

---

## Phase 2: Resolve File Location Conflicts (KEEP IN src/memory/)

**Objective:** Tell git our mongodb-\*.ts files and shared files are NOT renames. Keep them at `src/memory/`.

**Inputs:** Merge in progress with 79 file-location conflicts.
**Files:** All 79 `file location` conflict files.
**Dependencies:** Phase 1 complete.
**Allowed scope:** Only resolving file-location conflicts.
**Out-of-scope drift:** Do not resolve content/rename/modify conflicts.

**Steps:**

1. Restore ALL our `src/memory/` files from HEAD:

   ```bash
   git checkout HEAD -- src/memory/
   git add src/memory/
   ```

   This restores all 146 files (72 mongodb + 74 shared) from our HEAD, overriding any merge suggestions to move them.

2. Verify file counts:

   ```bash
   ls src/memory/mongodb-*.ts | wc -l   # Expect 72
   ls src/memory/*.ts | wc -l            # Expect 146
   ```

3. Verify no unexpected new files landed from upstream in `src/memory/`:
   ```bash
   # Compare our file list against baseline -- any files NOT in our HEAD should be investigated
   git diff --name-only --diff-filter=A HEAD -- src/memory/ 2>/dev/null
   # Expect: empty (upstream added zero new files to src/memory/ -- they only deleted/renamed out)
   # If non-empty: investigate each file. If it's an upstream addition, decide keep or remove.
   ```

**Expected artifacts:** All `src/memory/` files at their original paths, no unexpected new files.
**Required checks:** File counts match baseline. No surprise additions.
**Checkpoint type:** none
**Exit criteria:** `ls src/memory/mongodb-*.ts | wc -l` = 72. `ls src/memory/*.ts | wc -l` = 146. No unexpected new files in `src/memory/`.

---

## Phase 3: Resolve Rename/Delete Conflicts (ACCEPT UPSTREAM at New Locations)

**Objective:** Accept all files that upstream renamed from `src/memory/` to new locations that we had already deleted.

**Inputs:** 38 rename/delete conflicts.
**Files:** Files in `extensions/memory-core/src/memory/`, `packages/memory-host-sdk/src/host/`.
**Dependencies:** Phase 2 complete.
**Allowed scope:** Only resolving rename/delete conflicts.
**Out-of-scope drift:** Do not touch content conflicts.

**Steps:**

For all rename/delete conflicts where "deleted in HEAD":

```bash
# Accept upstream's version at the new destination
git checkout --theirs extensions/memory-core/src/memory/hybrid.ts
git checkout --theirs extensions/memory-core/src/memory/hybrid.test.ts
# ... repeat for all 38 files
```

Batch approach:

```bash
# Accept all upstream versions for files in extensions/memory-core/
git checkout --theirs -- extensions/memory-core/src/memory/
git add extensions/memory-core/src/memory/

# Accept all upstream versions for files in packages/memory-host-sdk/
git checkout --theirs -- packages/memory-host-sdk/src/host/memory-schema.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-process.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-process.test.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-query-parser.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-query-parser.test.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-scope.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-scope.test.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/sqlite-vec.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/sqlite.ts
git add packages/memory-host-sdk/
```

Handle the `extensions/memory-core/src/memory/test-runtime-mocks.ts` and `manager-runtime.ts` rename/delete similarly.

**Expected artifacts:** All 38 files resolved at their upstream locations.
**Required checks:** `git diff --name-only --diff-filter=U | grep -c "rename/delete"` = 0.
**Checkpoint type:** none
**Exit criteria:** No rename/delete conflicts remain. Files exist at upstream destinations.

---

## Phase 4: Resolve Modify/Delete Conflicts

**Objective:** Handle files where one side deleted and the other modified.

**Inputs:** 35 modify/delete conflicts.
**Files:** 6 KEEP OURS + 29 ACCEPT UPSTREAM.
**Dependencies:** Phase 3 complete.
**Allowed scope:** Only resolving modify/delete conflicts.
**Out-of-scope drift:** Do not resolve content conflicts.

**Steps:**

### 4A: KEEP OURS (6 files -- upstream deleted, we modified)

```bash
git checkout HEAD -- src/agents/tools/memory-tool.ts
git checkout HEAD -- src/agents/tools/memory-tool.runtime.ts
git checkout HEAD -- src/auto-reply/reply/memory-flush.test.ts
git checkout HEAD -- src/plugins/bundled-runtime-deps.test.ts
git checkout HEAD -- src/plugins/install-min-host-version-guardrails.test.ts
git checkout HEAD -- src/plugins/runtime/runtime-tools.ts
git add src/agents/tools/memory-tool.ts src/agents/tools/memory-tool.runtime.ts
git add src/auto-reply/reply/memory-flush.test.ts
git add src/plugins/bundled-runtime-deps.test.ts
git add src/plugins/install-min-host-version-guardrails.test.ts
git add src/plugins/runtime/runtime-tools.ts
```

### 4B: ACCEPT UPSTREAM (29 files -- we deleted, upstream modified)

```bash
# extensions/memory-core/ files (22)
git checkout --theirs -- extensions/memory-core/src/memory/embedding-manager.test-harness.ts
git checkout --theirs -- extensions/memory-core/src/memory/index.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager-embedding-ops.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager-search.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager-sync-ops.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.async-search.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.atomic-reindex.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.batch.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.embedding-batches.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.get-concurrency.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.mistral-provider.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.read-file.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.readonly-recovery.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.vector-dedupe.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/manager.watcher-config.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/mmr.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/mmr.ts
git checkout --theirs -- extensions/memory-core/src/memory/qmd-manager.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/qmd-manager.ts
git checkout --theirs -- extensions/memory-core/src/memory/test-manager-helpers.ts
git checkout --theirs -- extensions/memory-core/src/memory/test-manager.ts
git add extensions/memory-core/

# extensions/memory-lancedb/ files (3)
git checkout --theirs -- extensions/memory-lancedb/index.test.ts
git checkout --theirs -- extensions/memory-lancedb/index.ts
git checkout --theirs -- extensions/memory-lancedb/package.json
git add extensions/memory-lancedb/

# packages/memory-host-sdk/ files (4)
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-process.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-query-parser.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/qmd-scope.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/sqlite.ts
git add packages/memory-host-sdk/
```

**Expected artifacts:** All 35 modify/delete conflicts resolved.
**Required checks:** No modify/delete conflicts remain.
**Checkpoint type:** none
**Exit criteria:** `git diff --name-only --diff-filter=U` shows only content conflicts (no modify/delete).

---

## Phase 5: Resolve Content Conflicts

**Objective:** Resolve the 31 content merge conflicts through case-by-case analysis.

**Inputs:** 31 content conflicts.
**Files:** See conflict table above.
**Dependencies:** Phase 4 complete.
**Allowed scope:** Only resolving content conflicts.
**Out-of-scope drift:** No new features, no refactoring.

**Steps:**

### 5A: ACCEPT UPSTREAM (16 files -- no ClawMongo-specific content)

```bash
# Generated baselines (3)
git checkout --theirs -- docs/.generated/config-baseline.jsonl
git checkout --theirs -- docs/.generated/plugin-sdk-api-baseline.json
git checkout --theirs -- docs/.generated/plugin-sdk-api-baseline.jsonl
git add docs/.generated/

# extensions/memory-core/ (6)
git checkout --theirs -- extensions/memory-core/index.test.ts
git checkout --theirs -- extensions/memory-core/index.ts
git checkout --theirs -- extensions/memory-core/src/memory/index.ts
git checkout --theirs -- extensions/memory-core/src/memory/search-manager.test.ts
git checkout --theirs -- extensions/memory-core/src/memory/search-manager.ts
git checkout --theirs -- extensions/memory-core/src/tools.citations.test.ts
git add extensions/memory-core/

# packages/memory-host-sdk/ (2)
git checkout --theirs -- packages/memory-host-sdk/src/host/backend-config.test.ts
git checkout --theirs -- packages/memory-host-sdk/src/host/backend-config.ts
git add packages/memory-host-sdk/

# Generated/plugin files (4)
git checkout --theirs -- src/config/schema.base.generated.ts
git checkout --theirs -- src/plugins/bundled-plugin-metadata.generated.ts
git checkout --theirs -- src/plugins/provider-auth-choice-preference.ts
git add src/config/ src/plugins/

# Test/mock files (1)
git checkout --theirs -- test/helpers/extensions/plugin-runtime-mock.ts
git add test/helpers/
```

### 5B: ACCEPT UPSTREAM then manually patch (1 file)

```bash
git checkout --theirs -- src/agents/pi-embedded-runner/usage-reporting.test.ts
git add src/agents/pi-embedded-runner/usage-reporting.test.ts
```

### 5C: MANUAL resolution (14 files)

**5C.1: `CHANGELOG.md`** -- Merge both sides. Keep our entries, add upstream entries.

**5C.2: `docs/reference/memory-config.md`** -- Accept upstream, then re-add MongoDB configuration sections.

**5C.3: `package.json`** -- Accept upstream, then re-apply:

- `"name": "@romiluz/clawmongo"`
- ClawMongo version
- `"mongodb"` in `dependencies`
- Remove any LanceDB exports if present
- Verify `packages/memory-host-sdk` is in `workspaces`

**5C.4: `pnpm-lock.yaml`** -- Delete entirely: `rm pnpm-lock.yaml`

**5C.5: `src/agents/memory-search.ts`** -- CRITICAL. This file has content conflicts.

- Accept upstream changes (new imports from plugin-sdk, updated types)
- But verify our MongoDB-relevant function signatures survive
- Key: `resolveMemorySearchConfig` must still work with our MongoDB config
- Watch for new imports from `../plugin-sdk/memory-core-host-multimodal.js` and `../plugins/memory-embedding-providers.js` -- accept these

**5C.6: `src/agents/system-prompt.ts`** -- CRITICAL.

- Upstream changed import to `from "../plugins/memory-state.js"`
- We keep our inline `buildMemorySection()` (defined at line ~78) and `buildMongoDBBridgeSection()` (defined at line ~26)
- Strategy: Accept upstream's other changes (non-memory), but preserve our inline functions and their call sites
- DO NOT import `buildMemoryPromptSection` from `../plugins/memory-state.js` -- we build memory prompts directly

**5C.7: `src/auto-reply/reply/memory-flush.ts`** -- Accept upstream structure, verify memory flush path resolves through our MongoDB code.

**5C.8: `src/auto-reply/reply/reply-state.test.ts`** -- Accept upstream, verify test mocks still work.

**5C.9: `src/commands/doctor-memory-search.ts`** -- Keep our MongoDB imports (`../memory/search-manager.js`). Accept upstream UI/logic changes.

**5C.10: `src/commands/doctor-memory-search.test.ts`** -- Keep our imports. Accept upstream test structure changes.

**5C.11: `src/commands/doctor.ts`** -- Accept upstream, verify memory references use our paths.

**5C.12: `src/gateway/server-startup-memory.ts`** -- CRITICAL.

- Upstream changed imports to `from "../plugins/memory-runtime.js"`
- We keep `from "../memory/backend-config.js"` and `from "../memory/index.js"`
- Accept upstream logic changes, restore our import paths
- Verify `getMemorySearchManager` and `resolveMemoryBackendConfig` still come from our modules

**5C.13: `src/gateway/server-startup-memory.test.ts`** -- Keep our import paths in test mocks.

**5C.14: `src/plugins/provider-runtime.test.ts`** -- Accept upstream changes, verify no MongoDB-breaking mocks.

After resolving all 31:

```bash
git diff --name-only --diff-filter=U | wc -l  # Must be 0
```

**Expected artifacts:** All 31 content conflicts resolved. Zero unresolved conflicts.
**Required checks:** `git diff --name-only --diff-filter=U` returns empty.
**Checkpoint type:** human_verify (before proceeding -- verify critical files look correct)
**Exit criteria:** Zero unresolved conflicts. `git diff --name-only --diff-filter=U | wc -l` = 0.

---

## Phase 6: Plugin Bridge Registration and Verification

**Objective:** Register our MongoDB manager as the `MemoryPluginRuntime` and verify all plugin bridge paths resolve to MongoDB.

**Inputs:** All conflicts resolved.
**Files:** `src/plugins/memory-state.ts`, `src/plugins/memory-runtime.ts`, `src/agents/system-prompt.ts`, `src/gateway/server-startup-memory.ts`
**Dependencies:** Phase 5 complete.
**Allowed scope:** Register MongoDB runtime + verify plugin bridge paths.
**Out-of-scope drift:** No touching MongoDB memory files (except adding the `registerMemoryRuntime()` call to startup).

**Steps:**

1. **Read and verify `src/plugins/memory-state.ts`:**
   - It's a plugin registry singleton (124 lines) with `registerMemoryRuntime()`, `getMemoryRuntime()`, `buildMemoryPromptSection()`, etc.
   - Accept it as-is. It is a clean registry -- no patching needed.
   - Our job is to REGISTER into it, not modify it.

2. **Read and verify `src/plugins/memory-runtime.ts`:**
   - It's a wrapper that calls `getMemoryRuntime()` from `memory-state.ts`
   - Accept it as-is.
   - **CRITICAL FINDING:** 5 upstream production files now call `getActiveMemorySearchManager()` from this module:
     - `src/agents/pi-embedded-runner/compaction-hooks.ts`
     - `src/commands/doctor-memory-search.ts`
     - `src/commands/status.scan.deps.runtime.ts`
     - `src/gateway/server-methods/doctor.ts`
     - `src/gateway/server-startup-memory.ts` (itself)
   - If no runtime is registered, these callers get `{ manager: null, error: "memory plugin unavailable" }`.
   - Therefore we MUST register our MongoDB manager as the `MemoryPluginRuntime`.

3. **Register MongoDB as the MemoryPluginRuntime in `src/gateway/server-startup-memory.ts`:**
   - Add import: `import { registerMemoryRuntime } from "../plugins/memory-state.js";`
   - Also import `closeAllMemorySearchManagers` from `../memory/search-manager.js` (already exported at line 73).
   - During startup (after MongoDB manager initialization), call:
     ```typescript
     // NOTE: This is a structural skeleton. The builder MUST adapt types at build time.
     // Key facts:
     //   - Our getMemorySearchManager() is async and returns { manager, error }
     //   - Upstream expects RegisteredMemorySearchManager with status(), probeEmbeddingAvailability(),
     //     probeVectorAvailability(), sync?(), close?() methods
     //   - Our MemorySearchManager type does NOT have these methods
     //   - The builder must create a thin adapter wrapper
     registerMemoryRuntime({
       async getMemorySearchManager(params) {
         const result = await getMemorySearchManager(params);
         if (!result.manager)
           return { manager: null, error: result.error ?? "MongoDB manager not initialized" };
         // Wrap our MemorySearchManager to satisfy RegisteredMemorySearchManager interface:
         // - status(): return a MemoryProviderStatus (check upstream type)
         // - probeEmbeddingAvailability(): resolve from our manager's embedding config
         // - probeVectorAvailability(): return true (MongoDB Atlas Search is always vector-capable)
         // - sync?(): delegate to our manager.sync() if it exists
         // - close?(): delegate to our manager.close() if it exists
         // The exact wrapper depends on what MemoryProviderStatus and MemoryEmbeddingProbeResult look like.
         // BUILD-TIME TASK: inspect these types and write the adapter.
         return { manager: wrapForPluginBridge(result.manager), error: undefined };
       },
       resolveMemoryBackendConfig(_params) {
         return { backend: "builtin" as const, qmd: undefined };
       },
       async closeAllMemorySearchManagers() {
         await closeAllMemorySearchManagers();
       },
     });
     ```
   - This ensures upstream callers of `getActiveMemorySearchManager()` get our MongoDB manager.
   - The `getMemorySearchManager`, `resolveMemoryBackendConfig`, and `closeAllMemorySearchManagers` functions are already exported from `../memory/search-manager.ts` and `../memory/backend-config.ts`.
   - **BUILD-TIME TASK:** The `wrapForPluginBridge()` adapter function must be written at build time. It wraps our `MemorySearchManager` to satisfy upstream's `RegisteredMemorySearchManager` interface (imported from `../plugins/memory-state.js`). The adapter needs:
     - `status()` returning `MemoryProviderStatus` -- inspect the upstream type to determine the shape
     - `probeEmbeddingAvailability()` -- return a result reflecting our Voyage AI embedding status
     - `probeVectorAvailability()` -- return `true` (MongoDB Atlas Search is vector-capable)
     - `sync?(params)` -- delegate to our manager's sync if available, or no-op
     - `close?()` -- delegate to `manager.close()`

4. **Verify `src/agents/system-prompt.ts`:**
   - Our `buildMemorySection()` function is defined inline (not imported from plugin)
   - Our `buildMongoDBBridgeSection()` is defined inline
   - These must NOT be replaced by `buildMemoryPromptSection` from `../plugins/memory-state.js`
   - Verify call chain: `buildEmbeddedSystemPrompt()` -> `buildMemorySection()` -> `buildMongoDBBridgeSection()`

5. **Verify `src/gateway/server-startup-memory.ts`:**
   - Our imports from `../memory/backend-config.js` and `../memory/index.js` must be intact
   - The NEW import from `../plugins/memory-state.js` for `registerMemoryRuntime` is additive (not replacing)
   - NOT using `../plugins/memory-runtime.js` for our own calls

6. **Verify `src/agents/tools/memory-tool.ts`:**
   - Our tool imports from `../../memory/types.js` must be intact
   - Tool is registered directly, not via plugin `api.registerTool()`

7. **Verify upstream callers work via plugin bridge:**
   ```bash
   grep -r "getActiveMemorySearchManager\|resolveActiveMemoryBackendConfig" src/ --include="*.ts" | grep -v "node_modules\|memory-runtime\.ts\|\.test\." | head -20
   ```
   All callers must resolve through our registered `MemoryPluginRuntime`. No caller should get `null` when MongoDB is configured.

**Expected artifacts:** Plugin bridge registered with MongoDB adapter. All upstream callers verified.
**Required checks:** `registerMemoryRuntime()` call exists in startup. Import paths intact. Upstream callers get MongoDB manager.
**Checkpoint type:** none
**Exit criteria:** All 7 verification checks pass. `registerMemoryRuntime()` call exists in `server-startup-memory.ts`. Build passes with the adapter.

---

## Phase 7: Protected Seam Review

**Objective:** Review all protected seam files changed upstream for MongoDB integration integrity.

**Inputs:** Conflicts resolved, plugin bridge verified.
**Files:** Protected seam files from `scripts/upstream-protected-paths.txt`.
**Dependencies:** Phase 6 complete.
**Allowed scope:** Review and patch protected seams only.
**Out-of-scope drift:** No feature additions.

**Steps:**

1. **`src/agents/pi-embedded-runner/compact.ts`:**
   - Verify `sessionId` guard in guardSessionManager calls (pattern: `expect 31+ hits for "sessionId"`)
   - Verify `memoryBackend` check wiring through `buildEmbeddedSystemPrompt`
   - Accept upstream improvements (compaction hooks, timeout triggers)

2. **`src/agents/pi-embedded-runner/run/attempt.ts`:**
   - Verify `sessionId` in guardSessionManager calls (pattern: `expect 54+ hits`)
   - Accept upstream refactors (new sub-files)

3. **`src/agents/pi-tools.ts`:**
   - Verify MongoDB tool registration path still works
   - Accept upstream tool wiring changes

4. **`src/config/zod-schema.ts`:**
   - Verify MongoDB memory config schema survives
   - Accept upstream config additions

5. **`package.json` (already patched in Phase 5C.3):**
   - Verify `mongodb` is in `dependencies`
   - Verify `name: "@romiluz/clawmongo"`
   - Verify `packages/memory-host-sdk` in workspaces if upstream added it
   - Verify no LanceDB in production exports

6. **Lockfile:**
   - `rm pnpm-lock.yaml && pnpm install`
   - Verify `pnpm install` succeeds

7. **Update `scripts/upstream-protected-paths.txt`:**
   - Add: `src/plugins/memory-state.ts`
   - Add: `src/plugins/memory-runtime.ts`
   - Add: `src/memory/prompt-section.ts`
   - Keep all existing entries

8. **Update `scripts/upstream-excluded-paths.txt`:**
   - Remove stale entries for files that no longer exist at old `src/memory/` paths
   - Keep: `scripts/sqlite-vec-smoke.mjs`, `src/plugin-sdk/memory-lancedb.ts`
   - `extensions/memory-lancedb/`: Accept as dead code (decided in Durable Decisions). Remove from excluded list.

9. **Comprehensive protected-path verification (ALL 38+3 paths):**

   Run a verification pass over EVERY file in `scripts/upstream-protected-paths.txt`. For each file, check whether upstream changed it:

   ```bash
   while IFS= read -r path; do
     [[ "$path" =~ ^# ]] && continue
     [[ -z "$path" ]] && continue
     changed=$(git diff --stat HEAD..upstream/main -- "$path" 2>/dev/null | tail -1)
     if [ -n "$changed" ]; then
       echo "CHANGED: $path -- $changed"
     else
       echo "UNCHANGED: $path"
     fi
   done < scripts/upstream-protected-paths.txt
   ```

   **Pre-verified results (from planning investigation):**

   Files inside `src/memory/` (auto-restored by Phase 2 -- safe):
   - `src/memory/mongodb-episodes.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-events.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-graph.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-scope.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-structured-memory.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-sync.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-manager.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/mongodb-schema.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/runtime-write.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/prompt-section.ts` -- DELETED by upstream, RESTORED from HEAD
   - `src/memory/search-manager.ts` -- already reviewed
   - `src/memory/backend-config.ts` -- already reviewed
   - `src/memory/internal.ts` -- already reviewed

   Files UNCHANGED by upstream (no review needed):
   - `src/infra/outbound/deliver.ts` -- UNCHANGED
   - `src/infra/outbound/outbound-send-service.ts` -- UNCHANGED

   Files CHANGED by upstream (require explicit review):
   - `src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts` -- 3 deletions. Review: verify memory flush idle check still works with MongoDB.
   - `src/agents/session-tool-result-guard-wrapper.ts` -- 21 deletions. Review: verify guard wrapper still passes sessionId and memory context.
   - `src/agents/session-tool-result-guard.ts` -- 19 ins, 74 del. Review: verify guard still validates memory tool results correctly.
   - `src/commands/configure-memory.ts` -- 446 deletions (upstream gutted it for plugin system). Review: verify our MongoDB config path survives. If upstream deleted the MongoDB config flow, we may need to restore from HEAD.
   - `src/config/types.memory.ts` -- 57 ins, 169 del. Review: CRITICAL. Verify our MongoDB-specific memory config types survive (MemoryScope, mongo_v2 runtimeMode types we added). If upstream stripped them, restore from HEAD.
   - `src/config/sessions/transcript.ts` -- 5 deletions. Review: verify transcript session handling still works.
   - `src/config/validation.ts` -- 260 ins, 29 del. Review: verify MongoDB memory validation rules survive.
   - `src/gateway/server-methods/chat-transcript-inject.ts` -- 3 deletions. Review: verify chat injection still works.
   - `src/gateway/server-methods/chat.ts` -- 166 ins, 45 del. Review: verify chat method still routes memory through MongoDB paths.
   - `src/gateway/tools-invoke-http.ts` -- 5 ins, 2 del. Review: minor, verify tool invoke still works.
   - `src/wizard/onboarding-memory.ts` -- 417 deletions (upstream gutted it for plugin system). Review: if upstream deleted MongoDB onboarding flow, restore from HEAD or accept simplified version.

   For each CHANGED file above:
   - Read the merged version
   - Verify MongoDB behavior is preserved (imports from `../memory/`, no forced plugin routing)
   - If MongoDB-critical content was removed by upstream, restore from HEAD: `git checkout HEAD -- <file>`
   - If upstream changes are additive and don't break MongoDB, accept them

**Expected artifacts:** All protected seams verified. Path config files updated. Every CHANGED protected path explicitly reviewed.
**Required checks:** sessionId guards verified. Package.json correct. pnpm install succeeds. All 38+ protected paths accounted for.
**Checkpoint type:** none
**Exit criteria:** All 9 steps verified. `pnpm install` succeeds without errors. Every protected path either confirmed unchanged, auto-restored from HEAD, or explicitly reviewed and patched.

---

## Phase 8: Build and Type Check

**Objective:** Ensure the merged code compiles.

**Inputs:** All conflicts resolved, seams verified, deps installed.
**Files:** Entire project.
**Dependencies:** Phase 7 complete.
**Allowed scope:** Fix build errors caused by merge only.
**Out-of-scope drift:** No feature additions. No unnecessary refactors.

**Steps:**

1. `pnpm build`
2. If TypeScript errors occur, classify each:
   - **Missing import (file moved):** Fix import path to point to correct location
   - **Changed interface (upstream plugin types):** Add compatibility layer or adapt
   - **New type requirement:** Add MongoDB equivalent
   - **Pre-existing TS error in test file:** Document and ignore (known baseline)

**Expected issues:**

- Imports referencing `src/memory/` from upstream-changed code may need fixing
- New plugin type requirements may need MongoDB adapter types
- `src/agents/memory-search.ts` may have new import from `../plugin-sdk/memory-core-host-multimodal.js` that needs the package to exist
- `memory-tool.ts` or `memory-tool.runtime.ts` may reference types that upstream changed

3. Record error count. If errors are ONLY in pre-existing test file baseline, proceed.

**Expected artifacts:** Build output log. Error classification list if any.
**Required checks:** `pnpm build` exit code 0.
**Checkpoint type:** none
**Exit criteria:** `pnpm build` exits with code 0. No new TS errors outside pre-existing test file baseline.

---

## Phase 9: Test Suite

**Objective:** Verify all tests pass.

**Inputs:** Successful build.
**Files:** Test files.
**Dependencies:** Phase 8 complete.
**Allowed scope:** Fix test failures caused by merge only.
**Out-of-scope drift:** No new tests, no feature additions.

**Steps:**

1. Run full test suite: `pnpm test`
2. Run MongoDB-specific tests: `pnpm test -- src/memory/mongodb`
3. Run search manager tests: `pnpm test -- src/memory/search-manager`
4. Classify any failures:
   - **Failure in `src/memory/mongodb-*.ts`:** BLOCKER. Fix immediately.
   - **Failure in `src/memory/search-manager.ts`:** BLOCKER. Fix immediately.
   - **Failure in `extensions/memory-core/`:** OK -- upstream's plugin, not our code.
   - **Failure in `packages/memory-host-sdk/`:** OK if not importing our code.
   - **Failure in other upstream-only code:** Accept if clearly not MongoDB-related.
5. Run lint/format: `pnpm check`
6. Run format fix if needed: `pnpm format:fix`

**Expected artifacts:** Test results log with pass/fail counts.
**Required checks:** All MongoDB tests pass. All search-manager tests pass.
**Checkpoint type:** none
**Exit criteria:** All existing MongoDB tests pass. `pnpm check` passes (or only pre-existing lint issues remain). Any new upstream test failures are clearly in upstream-only paths.

---

## Phase 10: Commit and Verify

**Objective:** Finalize the merge commit and verify integrity.

**Inputs:** All tests pass, build clean.
**Files:** Entire working tree.
**Dependencies:** Phase 9 complete.
**Allowed scope:** Commit only.
**Out-of-scope drift:** No code changes after commit.

**Steps:**

1. Final state verification:

   ```bash
   # MongoDB files intact
   ls src/memory/mongodb-*.ts | wc -l   # Must be 72

   # Total memory files intact
   ls src/memory/*.ts | wc -l            # Must be 146

   # search-manager.ts is ours
   wc -l src/memory/search-manager.ts    # Must be 114

   # Upstream plugin system present
   ls packages/memory-host-sdk/package.json
   ls extensions/memory-core/package.json
   ls src/plugins/memory-state.ts
   ls src/plugins/memory-runtime.ts

   # Our tool registration intact
   ls src/agents/tools/memory-tool.ts
   ls src/agents/tools/memory-tool.runtime.ts

   # Build passes
   pnpm build

   # Tests pass
   pnpm test
   ```

2. Commit the merge with `git commit` (NOT `scripts/committer` -- merge commits must use `git commit` directly to finalize the merge state):

   ```bash
   git commit -m "$(cat <<'EOF'
   Upstream sync wave 6: absorb ~1,098 commits (memory plugin refactor)

   Adopted upstream's memory-to-plugin architecture refactor while preserving
   ClawMongo's MongoDB-first memory system. HYBRID approach:

   - ACCEPTED: packages/memory-host-sdk/, extensions/memory-core/ (upstream's plugins)
   - PRESERVED: src/memory/ (146 files: 72 mongodb + 74 shared)
   - KEPT: memory-tool.ts, memory-tool.runtime.ts (direct tool registration)
   - WIRED: server-startup-memory.ts registers MongoDB via registerMemoryRuntime()
   - KEPT: system-prompt.ts keeps inline buildMemorySection/buildMongoDBBridgeSection

   MongoDB-first contract: 23 collections, 63+ indexes, 90+ e2e tests preserved.
   No QMD, SQLite, or LanceDB in production paths.
   EOF
   )"
   ```

3. Verify it is a 2-parent merge commit:

   ```bash
   git cat-file -p HEAD | head -5   # Must show two "parent" lines
   ```

4. Verify drift state:
   ```bash
   git rev-list --count HEAD..upstream/main    # Must be 0
   git rev-list --count upstream/main..HEAD    # Must be >308
   ```

**Expected artifacts:** Clean 2-parent merge commit.
**Required checks:** Commit is 2-parent. 0 behind upstream. Build and tests pass.
**Checkpoint type:** none
**Exit criteria:** 2-parent merge commit exists. `git rev-list --count HEAD..upstream/main` = 0. `pnpm build` and `pnpm test` pass.

---

## Phase 11: Post-Merge Cleanup (Same Session)

**Objective:** Clean up formatting, update baselines, verify excluded/protected paths.

**Inputs:** Clean merge commit.
**Files:** Generated/config files, path lists.
**Dependencies:** Phase 10 complete.
**Allowed scope:** Cleanup commits only.
**Out-of-scope drift:** No feature additions.

**Steps:**

1. `pnpm format:fix` if formatting drift, then `pnpm check`
2. Update `EXPECTED_STANDARD_INDEX_COUNT` if upstream added indexes
3. Update `EXPECTED_COLLECTION_SUFFIXES` if upstream added collections
4. Verify excluded paths: `bash scripts/sync-upstream.sh --ref HEAD --fail-if-excluded-present` (or manual check)
5. Verify protected paths reflect new architecture
6. Update `scripts/upstream-drift-baseline.txt` and `scripts/upstream-drift-allowlist.txt`
7. Commit cleanup as separate commit (not amending the merge)

**Expected artifacts:** Clean formatting. Updated baselines.
**Required checks:** `pnpm check` passes.
**Checkpoint type:** none
**Exit criteria:** `pnpm check` passes. Excluded/protected path files current.

---

## Post-Merge Follow-Up (Separate Sessions)

### Near-term:

1. npm publish: `@romiluz/clawmongo@2026.3.34`
2. Run live e2e validation against MongoDB Docker stack
3. Consider registering MongoDB memory as a proper plugin via `api.registerMemoryRuntime()` (future optimization, not required)

### Skills update (dedicated session):

1. Update `clawmongo-upstream-sync` skill for new plugin architecture
2. Update `clawmongo-live-validation` skill
3. Update `clawmongo-test-triage` skill

---

## Risk Matrix

| Risk                                                                    | P (1-5) | I (1-5) | Score | Mitigation                                                                    |
| ----------------------------------------------------------------------- | ------- | ------- | ----- | ----------------------------------------------------------------------------- |
| File location conflicts cause mongodb-\*.ts to appear at wrong paths    | 4       | 5       | 20    | Phase 2: `git checkout HEAD -- src/memory/` restores ALL                      |
| Import breakage from files upstream moved to packages/memory-host-sdk   | 4       | 3       | 12    | Phase 8: build catches all TS errors                                          |
| system-prompt.ts loses buildMongoDBBridgeSection                        | 3       | 5       | 15    | Phase 5: explicit manual merge preserving our functions                       |
| server-startup-memory.ts switches to plugin imports                     | 3       | 5       | 15    | Phase 5: explicit manual merge keeping our imports                            |
| memory-tool.ts deletion breaks tool registration                        | 4       | 4       | 16    | Phase 4: KEEP OURS for all 6 deleted-upstream files                           |
| Plugin bridge forces memory through upstream code path                  | 2       | 5       | 10    | Phase 6: verify no forced routing                                             |
| sessionId guards lost in compact.ts/attempt.ts                          | 2       | 5       | 10    | Phase 7: explicit sessionId hit-count verification                            |
| pnpm-lock.yaml irrecoverable                                            | 4       | 2       | 8     | Delete and regenerate                                                         |
| Upstream tests fail in our tree (plugin tests)                          | 5       | 1       | 5     | Accept -- upstream plugin tests, not our code                                 |
| MongoDB test regression                                                 | 1       | 5       | 5     | Phase 9: full MongoDB test suite                                              |
| New config types missing MongoDB fields                                 | 2       | 3       | 6     | Phase 7: config schema review                                                 |
| 183 conflicts overwhelm resolution process                              | 3       | 3       | 9     | Phased approach: 79 bulk, 38 bulk, 35 case-by-case, 31 manual                 |
| MongoDB manager doesn't satisfy RegisteredMemorySearchManager interface | 3       | 4       | 12    | Phase 6 step 3: build thin adapter wrapper with status/probe/sync/close stubs |
| Protected path changes silently break MongoDB behavior                  | 2       | 4       | 8     | Phase 7 step 9: exhaustive protected-path audit against upstream diff         |

---

## Behavioral Contract (22 Invariants)

After merge completion, ALL must hold true:

1. `ls src/memory/mongodb-*.ts | wc -l` = 72 (all MongoDB files intact)
2. `ls src/memory/*.ts | wc -l` = 146 (all memory files intact)
3. `src/memory/search-manager.ts` is our MongoDB-only version (114 lines, no QMD)
4. `src/memory/types.ts` exists with `MemorySearchManager` interface (211 lines)
5. `src/memory/index.ts` exports all MongoDB memory symbols (158 lines)
6. `packages/memory-host-sdk/` exists (from upstream)
7. `extensions/memory-core/` exists (upstream's SQLite plugin)
8. `src/plugins/memory-state.ts` exists (upstream's plugin bridge, 124 lines)
9. `pnpm build` passes
10. `pnpm test -- src/memory/mongodb` passes (all MongoDB tests)
11. `pnpm test -- src/memory/search-manager` passes
12. No QMD, SQLite, or LanceDB imports in `src/memory/mongodb-*.ts` files
13. `mongodb` is in `package.json` dependencies
14. `buildMongoDBBridgeSection` call exists in `src/agents/system-prompt.ts`
15. `sessionId` guards exist in `compact.ts` (31+ hits) and `attempt.ts` (54+ hits)
16. `src/agents/tools/memory-tool.ts` exists (our direct tool registration)
17. `src/gateway/server-startup-memory.ts` imports from `../memory/` (not `../plugins/`) for its own memory calls
18. `src/gateway/server-startup-memory.ts` calls `registerMemoryRuntime()` to register MongoDB as the plugin runtime
19. `git rev-list --count HEAD..upstream/main` = 0
20. Merge commit has 2 parents
21. No `src/memory/manager.ts` (QMD) outside `extensions/memory-core/`
22. All 38+ protected paths in `scripts/upstream-protected-paths.txt` explicitly accounted for (unchanged, auto-restored, or reviewed)

---

## Phase Dependency Map

- Phase 0: depends on [clean working tree], creates [backup branch, baselines], enables [Phase 1]
- Phase 1: depends on [Phase 0], creates [merge state, conflict list], enables [Phase 2-5]
- Phase 2: depends on [Phase 1], creates [resolved file-location conflicts], enables [Phase 3]
- Phase 3: depends on [Phase 2], creates [resolved rename/delete conflicts], enables [Phase 4]
- Phase 4: depends on [Phase 3], creates [resolved modify/delete conflicts], enables [Phase 5]
- Phase 5: depends on [Phase 4], creates [zero unresolved conflicts], enables [Phase 6]
- Phase 6: depends on [Phase 5], creates [MongoDB registered as plugin runtime, verified plugin bridge], enables [Phase 7]
- Phase 7: depends on [Phase 6], creates [verified seams, installed deps], enables [Phase 8]
- Phase 8: depends on [Phase 7], creates [passing build], enables [Phase 9]
- Phase 9: depends on [Phase 8], creates [passing tests], enables [Phase 10]
- Phase 10: depends on [Phase 9], creates [2-parent merge commit], enables [Phase 11]
- Phase 11: depends on [Phase 10], creates [clean formatting, updated baselines], enables [post-merge]

## Phase Autonomy Classification

| Phase | Checkpoint Type | Classification | Reason                                                      |
| ----- | --------------- | -------------- | ----------------------------------------------------------- |
| 0     | none            | AFK            | Read-only verification                                      |
| 1     | none            | AFK            | Single git command                                          |
| 2     | none            | AFK            | Bulk git checkout HEAD for our files                        |
| 3     | none            | AFK            | Batch accept upstream at new locations                      |
| 4     | none            | AFK            | Clear KEEP OURS vs ACCEPT UPSTREAM rules                    |
| 5     | human_verify    | HITL           | 14 manual merges require human judgment on conflict content |
| 6     | none            | AFK            | Verification checks, no judgment needed                     |
| 7     | none            | AFK            | Clear verification criteria                                 |
| 8     | none            | AFK            | Build and fix errors by rules                               |
| 9     | none            | AFK            | Run tests, classify failures by rules                       |
| 10    | none            | AFK            | Commit and verify                                           |
| 11    | none            | AFK            | Cleanup                                                     |
