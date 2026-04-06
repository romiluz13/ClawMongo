# Upstream Sync Wave 7 -- Absorb 4,389 Commits (Dreaming + Wiki Evaluation)

> **For Claude:** REQUIRED: Follow this plan phase-by-phase. Do NOT switch branches, stash, or run `git checkout` on modified files during uncommitted merge state. The MongoDB-first contract is inviolable: no QMD, SQLite, LanceDB, Qdrant, Chroma, Redis, Pinecone, Weaviate, or ANY non-MongoDB backend may enter production paths. When resolving conflicts, use `git show HEAD:path > /tmp/copy` instead of `git checkout` for inspection.
> **Design:** See `docs/plans/2026-04-06-upstream-sync-wave7-design.md` for full specification.
> **Prior Art:** Waves 1-6 absorbed ~3,260 upstream commits total -- all successful. Wave 7 is the largest single merge (4,389 commits) but structurally simpler than Wave 6 (only 2 protected seams changed vs full memory-to-plugin gutting).

**Goal:** Merge 4,389 upstream commits into ClawMongo via `git merge upstream/main --no-commit`, resolve all conflicts using the HYBRID strategy, verify all 38 protected seams (plus 2 additional sacred seams not in the file), update baselines, and document an evaluation of upstream Dreaming + Wiki concepts for future MongoDB-native re-implementation.

**Architecture:** Single merge, phased conflict resolution by 4-tier classification. HYBRID-Continuous approach: accept upstream plugin dead code at upstream paths, MongoDB code stays at its own `src/memory/` paths, plugin bridge via `registerMemoryRuntime()` in `server-startup-memory.ts` remains the wiring mechanism.

**Tech Stack:** Git merge, pnpm, TypeScript, Vitest, MongoDB

**Prerequisites:**

- `git fetch upstream` done (current state: 328 ahead, 4,389 behind)
- Working tree clean (confirmed via git status)
- All prior extraction pipeline work committed on main
- Backup branch created before merge
- Last published: `@romiluz/clawmongo@2026.3.38`

**Durable Decisions:**

- MongoDB is the sole runtime backend. ANY other database (QMD, SQLite, LanceDB, Qdrant, Chroma, Redis, Pinecone, Weaviate, or any future non-MongoDB backend) must be rejected/ignored. Upstream plugin code exists in repo but never executes.
- `src/memory/` directory is sacred. All 149 files (75 mongodb-\*.ts + 74 shared/embedding/utility) stay at their current paths.
- Embedding files remain in `src/memory/` (not moved to `packages/memory-host-sdk/`).
- `memory-tool.ts` + `memory-tool.runtime.ts` stay as our tool registration path.
- `server-startup-memory.ts` keeps importing from `../memory/` paths and registers MongoDB via `registerMemoryRuntime()`.
- `system-prompt.ts` keeps our inline `buildMemorySection()` + `buildMongoDBBridgeSection()`.
- `extensions/memory-lancedb/`: Accept upstream version as dead code.
- `src/memory/prompt-section.ts`: Protected path. Restored from HEAD if upstream touches it.
- HYBRID strategy: accept upstream dead code at upstream paths, MongoDB owns 100% runtime.
- Plugin registration: last-write-wins via `registerMemoryRuntime()` AFTER plugin loading.
- `plugins.slots.memory: "none"` prevents memory-core from overwriting MongoDB adapter.
- Package.json metadata (name, description, homepage, bugs, repository, bin.clawmongo) must be re-applied after every upstream merge.
- Dreaming + Wiki: evaluate concepts for MongoDB mapping (document only, NO implementation).
- All sub-agents must load all 5 ClawMongo skills + all 7 MongoDB skills when touching database code.
- Single merge -- no sub-wave splitting.

---

## Current Baselines (Verified 2026-04-06)

| Metric                  | Value                        | Source                                                                 |
| ----------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| mongodb-\*.ts files     | 75                           | `ls src/memory/mongodb-*.ts \| wc -l`                                  |
| Total memory files      | 149                          | `ls src/memory/*.ts \| wc -l`                                          |
| search-manager.ts lines | 126                          | `wc -l src/memory/search-manager.ts`                                   |
| MongoDB collections     | 24                           | EXPECTED_COLLECTION_SUFFIXES in mongodb-e2e.e2e.test.ts                |
| MongoDB indexes         | 67                           | EXPECTED_STANDARD_INDEX_COUNT in mongodb-e2e.e2e.test.ts               |
| Protected paths         | 38                           | `scripts/upstream-protected-paths.txt` (non-blank non-comment entries) |
| Excluded paths          | 2                            | `scripts/upstream-excluded-paths.txt`                                  |
| Drift allowlist         | 108 entries                  | `scripts/upstream-drift-allowlist.txt`                                 |
| Drift baseline          | 133 entries                  | `scripts/upstream-drift-baseline.txt`                                  |
| Last npm publish        | @romiluz/clawmongo@2026.3.38 |                                                                        |
| Ahead/Behind            | 328 ahead / 4,389 behind     | git rev-list                                                           |

> **Note:** The design doc (`docs/plans/2026-04-06-upstream-sync-wave7-design.md`) contains stale baselines (72+/23+/66+). This plan supersedes those with verified values: 75 mongodb-\*.ts files, 24 collections, 67 indexes.

---

## What Changed Upstream (THE BIG PICTURE)

### Key Upstream Feature Additions (4,389 commits)

| Category                                                                                          | Est. Count | Action                                             |
| ------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| Non-MongoDB backends (QMD, SQLite, LanceDB, Qdrant, Chroma, Redis, Pinecone, Weaviate, ANY other) | 52+        | Auto-ignore (dead code accepted, NEVER adopt)      |
| Dreaming system (memory-core plugin)                                                              | ~25        | Accept as dead code, evaluate concepts in Phase 12 |
| Wiki system (memory-wiki plugin)                                                                  | ~10        | Accept as dead code, evaluate concepts in Phase 12 |
| Plugin infrastructure refactors                                                                   | ~20        | Accept (our bridge wires through)                  |
| Bedrock embedding provider                                                                        | ~5         | Accept as dead code (we use Voyage via mongot)     |
| Exec approval system                                                                              | ~5         | Accept as new feature                              |
| Provider replay                                                                                   | ~5         | Accept as new feature                              |
| Lint/test/docs cleanup                                                                            | ~19+       | Accept broadly                                     |
| All other (channels, providers, CLI, config, UI, etc.)                                            | ~4,248     | Accept broadly                                     |

### Protected Seam Status

**CHANGED upstream (2 files -- require merge review):**

- `src/plugins/memory-state.ts` -- plugin registry, verify MongoDB registration still works
- `src/infra/outbound/outbound-send-service.ts` -- outbound persistence, verify no backend assumptions

**UNTOUCHED upstream (3 sacred seams in protected-paths file -- verify intact after merge):**

- `src/memory/search-manager.ts` -- MongoDB-only factory (126 lines)
- `src/memory/backend-config.ts` -- MongoDB backend resolver
- `src/gateway/server-startup-memory.ts` -- MongoDB startup + plugin bridge

**Additional sacred seams (NOT in protected-paths file, but still verified):**

- `src/memory/types.ts` -- MemorySearchManager interface
- `src/memory/index.ts` -- barrel exports

**Remaining 33 protected paths:** verify all per `scripts/upstream-protected-paths.txt`

---

## Context References

### Key Files to Reference During Build

- `scripts/upstream-protected-paths.txt` -- 38 protected seam files
- `scripts/upstream-excluded-paths.txt` -- 2 excluded paths (sqlite-vec-smoke.mjs, plugin-sdk/memory-lancedb.ts)
- `scripts/upstream-steady-state.sh` -- guardrail script (calls sync-upstream.sh)
- `scripts/upstream-sync-report.ts` -- bounded sync report generator
- `scripts/upstream-drift-allowlist.txt` -- 108 allowed drift paths
- `scripts/upstream-drift-baseline.txt` -- 133 drift baseline entries
- `src/memory/mongodb-e2e.e2e.test.ts` -- EXPECTED_COLLECTION_SUFFIXES=24, EXPECTED_STANDARD_INDEX_COUNT=67
- `src/gateway/server-startup-memory.ts` -- plugin bridge registration site
- `src/plugins/memory-state.ts` -- plugin registry singleton
- `src/plugins/memory-runtime.ts` -- active memory manager accessor

### Prior Wave Pattern (from Wave 6)

The exact same 11-phase pattern was used in Wave 6 (docs/plans/2026-03-29-upstream-sync-wave6-plan.md) and is proven across 6 waves. This plan follows it with updated baselines and adds Phase 12 for Dreaming + Wiki evaluation.

---

## Phase 0: Pre-Flight and Backup

**Objective:** Create safety net, verify state, record baselines.

**Inputs:** Clean working tree, upstream not yet fetched for this wave.
**Files:** None modified.
**Dependencies:** None.
**Allowed scope:** Read-only verification + backup branch creation + guardrail script run.
**Out-of-scope drift:** No code changes, no merging.

**Steps:**

1. Verify clean working tree: `git status`
2. Fetch upstream: `git fetch upstream`
3. Confirm behind count: `git rev-list --count HEAD..upstream/main` (expect ~4,389)
4. Confirm ahead count: `git rev-list --count upstream/main..HEAD` (expect ~328)
5. Create backup branch: `git branch pre-upstream-merge-wave7-backup`
6. Run pre-flight guardrail scripts:
   ```bash
   # Steady-state check (will exit 2 because we are behind)
   bash scripts/upstream-steady-state.sh --max-commits 20 || true
   ```
7. Run bounded sync report:
   ```bash
   node --import tsx scripts/upstream-sync-report.ts \
     --base HEAD --target upstream/main --max-commits 20
   ```
8. Record current baselines:
   ```bash
   ls src/memory/mongodb-*.ts | wc -l       # Expect 75
   ls src/memory/*.ts | wc -l               # Expect 149
   wc -l src/memory/search-manager.ts       # Expect 126
   pnpm test -- src/memory/ --reporter=verbose 2>&1 | tail -30
   ```
9. Record memory-related upstream commits for later classification:
   ```bash
   git log HEAD..upstream/main --oneline -- src/memory/ src/plugins/memory-*.ts \
     extensions/memory-core/ extensions/memory-lancedb/ packages/memory-host-sdk/ | wc -l
   # Expect ~131
   ```

**Expected artifacts:** Backup branch, baseline counts recorded, sync report captured.
**Required checks:** Backup branch exists, working tree clean, upstream fetched.
**Checkpoint type:** none
**Exit criteria:** `git branch --list pre-upstream-merge-wave7-backup` returns a result. `git rev-list --count HEAD..upstream/main` returns ~4,389. Working tree is clean.

---

## Phase 1: Execute Merge (No Commit)

**Objective:** Start the merge and capture the full conflict list.

**Inputs:** Clean working tree, upstream fetched, backup branch exists.
**Files:** All files in working tree (merge operation).
**Dependencies:** Phase 0 complete.
**Allowed scope:** Only the merge command and conflict recording.
**Out-of-scope drift:** No conflict resolution in this phase.

**Steps:**

1. Configure merge-ours driver (already committed in .gitattributes but git config needed per session):

   ```bash
   git config merge.ours.driver true
   ```

2. Execute merge:

   ```bash
   git merge upstream/main --no-commit --no-ff 2>&1 | tee /tmp/wave7-merge-output.txt
   ```

3. Record all CONFLICT lines:

   ```bash
   grep "CONFLICT" /tmp/wave7-merge-output.txt > /tmp/wave7-conflicts.txt
   wc -l /tmp/wave7-conflicts.txt
   ```

4. Classify conflicts by type:

   ```bash
   grep -c "file location" /tmp/wave7-conflicts.txt || echo 0
   grep -c "rename/delete" /tmp/wave7-conflicts.txt || echo 0
   grep -c "modify/delete" /tmp/wave7-conflicts.txt || echo 0
   grep -c "content" /tmp/wave7-conflicts.txt || echo 0
   ```

5. Verify our 75 MongoDB files still exist:

   ```bash
   ls src/memory/mongodb-*.ts | wc -l   # Expect 75
   ```

6. Check for new upstream files in memory-relevant paths:
   ```bash
   git diff --name-only --diff-filter=A HEAD -- src/memory/ 2>/dev/null | head -20
   git diff --name-only --diff-filter=A HEAD -- extensions/memory-core/ 2>/dev/null | head -20
   git diff --name-only --diff-filter=A HEAD -- extensions/memory-wiki/ 2>/dev/null | head -20
   ```

**Expected artifacts:** `/tmp/wave7-conflicts.txt` with full conflict list, conflict type counts.
**Required checks:** Merge in progress, conflict list captured, MongoDB files present.
**Checkpoint type:** none
**Exit criteria:** `git diff --name-only --diff-filter=U | wc -l` returns >0. MongoDB files exist. Conflict list captured.

---

## Phase 2: Resolve File Location Conflicts (KEEP IN src/memory/)

**Objective:** Tell git our mongodb-\*.ts files and shared files are NOT renames. Keep them at `src/memory/`.

**Inputs:** Merge in progress with file-location conflicts (same pattern as Wave 6).
**Files:** All file location conflict files in `src/memory/`.
**Dependencies:** Phase 1 complete.
**Allowed scope:** Only resolving file-location conflicts.
**Out-of-scope drift:** Do not resolve content/rename/modify conflicts.

**Steps:**

1. Restore ALL our `src/memory/` files from HEAD:

   ```bash
   git checkout HEAD -- src/memory/
   git add src/memory/
   ```

   This restores all 149 files (75 mongodb + 74 shared) from our HEAD, overriding any merge suggestions to move them.

2. Verify file counts:

   ```bash
   ls src/memory/mongodb-*.ts | wc -l   # Expect 75
   ls src/memory/*.ts | wc -l            # Expect 149
   ```

3. Verify no unexpected new files landed from upstream in `src/memory/`:
   ```bash
   git diff --name-only --diff-filter=A HEAD -- src/memory/ 2>/dev/null
   # Expect: empty (upstream should not be adding new files to src/memory/ since they moved to plugins)
   # If non-empty: investigate each file. If it's an upstream addition, decide keep or remove.
   ```

**Expected artifacts:** All `src/memory/` files at their original paths, no unexpected new files.
**Required checks:** File counts match baseline. No surprise additions.
**Checkpoint type:** none
**Exit criteria:** `ls src/memory/mongodb-*.ts | wc -l` = 75. `ls src/memory/*.ts | wc -l` = 149. No unexpected new files in `src/memory/`.

---

## Phase 3: Resolve Rename/Delete Conflicts (ACCEPT UPSTREAM at New Locations)

**Objective:** Accept all files that upstream renamed from old locations that we had already deleted or never had.

**Inputs:** Rename/delete conflicts from the merge.
**Files:** Files in `extensions/`, `packages/memory-host-sdk/`.
**Dependencies:** Phase 2 complete.
**Allowed scope:** Only resolving rename/delete conflicts.
**Out-of-scope drift:** Do not touch content conflicts.

**Steps:**

1. Identify all rename/delete conflicts:

   ```bash
   grep "rename/delete" /tmp/wave7-conflicts.txt
   ```

2. For all "deleted in HEAD" rename/delete conflicts, accept upstream's version at destination:

   ```bash
   # Accept upstream versions at their new locations
   # extensions/memory-core/ files
   git checkout --theirs -- extensions/memory-core/ 2>/dev/null || true
   git add extensions/memory-core/ 2>/dev/null || true

   # extensions/memory-lancedb/ files
   git checkout --theirs -- extensions/memory-lancedb/ 2>/dev/null || true
   git add extensions/memory-lancedb/ 2>/dev/null || true

   # extensions/memory-wiki/ files (NEW in Wave 7)
   git checkout --theirs -- extensions/memory-wiki/ 2>/dev/null || true
   git add extensions/memory-wiki/ 2>/dev/null || true

   # packages/memory-host-sdk/ files
   git checkout --theirs -- packages/memory-host-sdk/ 2>/dev/null || true
   git add packages/memory-host-sdk/ 2>/dev/null || true
   ```

3. Verify no rename/delete conflicts remain:
   ```bash
   git diff --name-only --diff-filter=U 2>/dev/null | head -40
   ```

**Expected artifacts:** All rename/delete conflicts resolved at upstream locations.
**Required checks:** No rename/delete conflicts remain.
**Checkpoint type:** none
**Exit criteria:** No rename/delete conflicts remain. Files exist at upstream destinations.

---

## Phase 4: Resolve Modify/Delete Conflicts

**Objective:** Handle files where one side deleted and the other modified.

**Inputs:** Modify/delete conflicts from the merge.
**Files:** Case-by-case: KEEP OURS for MongoDB files, ACCEPT UPSTREAM otherwise.
**Dependencies:** Phase 3 complete.
**Allowed scope:** Only resolving modify/delete conflicts.
**Out-of-scope drift:** Do not resolve content conflicts.

**Steps:**

### 4A: KEEP OURS (files upstream deleted but we modified/need)

These are the same files from Wave 6 that upstream deleted (moved to plugin architecture) but we keep:

```bash
# Our MongoDB tool registration
git checkout HEAD -- src/agents/tools/memory-tool.ts 2>/dev/null || true
git checkout HEAD -- src/agents/tools/memory-tool.runtime.ts 2>/dev/null || true
git add src/agents/tools/memory-tool.ts src/agents/tools/memory-tool.runtime.ts 2>/dev/null || true

# Our tests for deleted-upstream files
git checkout HEAD -- src/auto-reply/reply/memory-flush.test.ts 2>/dev/null || true
git checkout HEAD -- src/plugins/bundled-runtime-deps.test.ts 2>/dev/null || true
git checkout HEAD -- src/plugins/install-min-host-version-guardrails.test.ts 2>/dev/null || true
git checkout HEAD -- src/plugins/runtime/runtime-tools.ts 2>/dev/null || true
git add src/auto-reply/reply/memory-flush.test.ts 2>/dev/null || true
git add src/plugins/bundled-runtime-deps.test.ts 2>/dev/null || true
git add src/plugins/install-min-host-version-guardrails.test.ts 2>/dev/null || true
git add src/plugins/runtime/runtime-tools.ts 2>/dev/null || true
```

### 4B: ACCEPT UPSTREAM (files we deleted, upstream modified at new locations)

```bash
# Accept upstream versions in extensions/ and packages/
git checkout --theirs -- extensions/memory-core/ 2>/dev/null || true
git checkout --theirs -- extensions/memory-lancedb/ 2>/dev/null || true
git checkout --theirs -- extensions/memory-wiki/ 2>/dev/null || true
git checkout --theirs -- packages/memory-host-sdk/ 2>/dev/null || true
git add extensions/memory-core/ extensions/memory-lancedb/ extensions/memory-wiki/ packages/memory-host-sdk/ 2>/dev/null || true
```

### 4C: Investigate any NEW modify/delete conflicts from Wave 7 upstream changes

```bash
# List remaining unresolved files
git diff --name-only --diff-filter=U
# For each file: classify as KEEP OURS (MongoDB-critical) or ACCEPT UPSTREAM
# Decision rule:
#   - If file is in src/memory/ or src/agents/tools/memory-*: KEEP OURS
#   - If file is in extensions/ or packages/: ACCEPT UPSTREAM
#   - If file is elsewhere: merge intent, accept upstream structure changes
```

**Expected artifacts:** All modify/delete conflicts resolved.
**Required checks:** No modify/delete conflicts remain.
**Checkpoint type:** none
**Exit criteria:** `git diff --name-only --diff-filter=U` shows only content conflicts (no modify/delete).

---

## Phase 5: Resolve Content Conflicts

**Objective:** Resolve all remaining content merge conflicts through case-by-case analysis.

**Inputs:** Content conflicts (both sides modified).
**Files:** All files with `<<<<<<<` conflict markers.
**Dependencies:** Phase 4 complete.
**Allowed scope:** Only resolving content conflicts.
**Out-of-scope drift:** No new features, no refactoring.

**Steps:**

### 5A: ACCEPT UPSTREAM (files with no ClawMongo-specific content)

For files entirely in upstream's domain (generated baselines, plugin code, test mocks):

```bash
# Generated baselines
git checkout --theirs -- docs/.generated/ 2>/dev/null || true
git add docs/.generated/ 2>/dev/null || true

# extensions/memory-core/ content conflicts
git checkout --theirs -- extensions/memory-core/ 2>/dev/null || true
git add extensions/memory-core/ 2>/dev/null || true

# extensions/memory-wiki/ content conflicts (NEW in Wave 7)
git checkout --theirs -- extensions/memory-wiki/ 2>/dev/null || true
git add extensions/memory-wiki/ 2>/dev/null || true

# packages/memory-host-sdk/ content conflicts
git checkout --theirs -- packages/memory-host-sdk/ 2>/dev/null || true
git add packages/memory-host-sdk/ 2>/dev/null || true

# Generated/plugin files
git checkout --theirs -- src/config/schema.base.generated.ts 2>/dev/null || true
git checkout --theirs -- src/plugins/bundled-plugin-metadata.generated.ts 2>/dev/null || true
git add src/config/schema.base.generated.ts src/plugins/bundled-plugin-metadata.generated.ts 2>/dev/null || true

# Test/mock files that are upstream-only
git checkout --theirs -- test/helpers/ 2>/dev/null || true
git add test/helpers/ 2>/dev/null || true
```

### 5B: MANUAL resolution (ClawMongo-critical files)

For each file below, read the merged version, identify conflict markers, and resolve:

**5B.1: `CHANGELOG.md`** -- Merge both sides. Keep our entries, add upstream entries. Follow existing format.

**5B.2: `package.json`** -- Accept upstream, then re-apply ClawMongo overrides:

- `"name": "@romiluz/clawmongo"`
- `"description"`: ClawMongo description
- `"homepage"`, `"bugs"`, `"repository"`: ClawMongo URLs
- `"bin": { "clawmongo": ... }`
- `"mongodb"` in `dependencies`
- Remove any LanceDB exports if present in exports map
- Verify `packages/memory-host-sdk` in workspaces
- Verify memory-lancedb export NOT in package.json exports

**5B.3: `pnpm-lock.yaml`** -- Delete entirely and regenerate:

```bash
rm pnpm-lock.yaml
```

**5B.4: `src/plugins/memory-state.ts`** (CHANGED upstream -- 1 of 2 changed protected seams):

- Read the merged version carefully
- This is the plugin registry singleton
- Verify `registerMemoryRuntime()` function still exists and has same signature
- Verify `getMemoryRuntime()` accessor still works
- Accept upstream changes unless they break our registration pattern
- Key concern: if upstream changed the `MemoryPluginRuntime` interface, our `wrapForPluginBridge()` adapter in `server-startup-memory.ts` may need updating

**5B.5: `src/infra/outbound/outbound-send-service.ts`** (CHANGED upstream -- 2 of 2 changed protected seams):

- Read the merged version
- Verify no new backend assumptions (e.g., no forced SQLite/QMD/LanceDB routing)
- Accept upstream changes if they are backend-agnostic
- If upstream introduced non-MongoDB persistence logic, KEEP OURS

**5B.6: `src/agents/system-prompt.ts`** (if conflicted):

- Keep our inline `buildMemorySection()` and `buildMongoDBBridgeSection()`
- DO NOT import `buildMemoryPromptSection` from `../plugins/memory-state.js`
- Accept upstream's non-memory changes

**5B.7: `src/agents/memory-search.ts`** (if conflicted):

- Accept upstream changes for new imports/types
- Verify MongoDB-relevant function signatures survive
- Key: `resolveMemorySearchConfig` must still work with our MongoDB config

**5B.8: `src/gateway/server-startup-memory.ts`** (if conflicted):

- Keep `from "../memory/backend-config.js"` and `from "../memory/index.js"` imports
- Keep `registerMemoryRuntime()` call with our MongoDB adapter
- Accept upstream logic changes that don't break our import paths

**5B.9: `src/gateway/server-startup-memory.test.ts`** (if conflicted):

- Keep our import paths in test mocks
- Accept upstream test structure changes

**5B.10: `src/commands/doctor-memory-search.ts`** and `src/commands/doctor-memory-search.test.ts` (if conflicted):

- Keep our MongoDB imports (`../memory/search-manager.js`)
- Accept upstream UI/logic changes

**5B.11: `src/commands/doctor.ts`** (if conflicted):

- Accept upstream, verify memory references use our paths

**5B.12: `src/auto-reply/reply/memory-flush.ts`** (if conflicted):

- Accept upstream structure, verify memory flush path resolves through our MongoDB code

\*\*5B.13: Any other content conflicts:

- Principle: accept upstream for non-memory paths
- For memory-adjacent paths: merge intent, preserve MongoDB routing
- For config/types: verify MongoDB config types survive

### 5C: Final zero-conflict verification

```bash
git diff --name-only --diff-filter=U | wc -l  # Must be 0
```

**Expected artifacts:** All content conflicts resolved. Zero unresolved conflicts.
**Required checks:** `git diff --name-only --diff-filter=U` returns empty.
**Checkpoint type:** human_verify (before proceeding -- verify critical files look correct)
**Exit criteria:** Zero unresolved conflicts. `git diff --name-only --diff-filter=U | wc -l` = 0.

---

## Phase 6: Plugin Bridge Verification

**Objective:** Verify the MongoDB plugin bridge registration still works after merge.

**Inputs:** All conflicts resolved.
**Files:** `src/plugins/memory-state.ts`, `src/plugins/memory-runtime.ts`, `src/gateway/server-startup-memory.ts`
**Dependencies:** Phase 5 complete.
**Allowed scope:** Verify plugin bridge paths + fix if broken by upstream changes.
**Out-of-scope drift:** No new features.

**Steps:**

1. **Verify `src/plugins/memory-state.ts`:**
   - `registerMemoryRuntime()` function exists
   - `getMemoryRuntime()` accessor works
   - If upstream changed the `MemoryPluginRuntime` interface, document what changed

   ```bash
   grep -n "registerMemoryRuntime\|getMemoryRuntime\|MemoryPluginRuntime" src/plugins/memory-state.ts
   ```

2. **Verify `src/plugins/memory-runtime.ts`:**
   - `getActiveMemorySearchManager()` exists and routes through `getMemoryRuntime()`

   ```bash
   grep -n "getActiveMemorySearchManager\|getMemoryRuntime" src/plugins/memory-runtime.ts
   ```

3. **Verify `src/gateway/server-startup-memory.ts`:**
   - Imports from `../memory/backend-config.js` and `../memory/index.js` are intact
   - `registerMemoryRuntime()` call exists with our MongoDB adapter
   - `wrapForPluginBridge()` adapter is intact

   ```bash
   grep -n "registerMemoryRuntime\|wrapForPluginBridge\|memory/backend-config\|memory/index" src/gateway/server-startup-memory.ts
   ```

4. **If `MemoryPluginRuntime` interface changed upstream:**
   - Read the new interface definition
   - Update `wrapForPluginBridge()` adapter to satisfy new requirements
   - Document what changed for future reference

5. **Verify upstream callers resolve through our bridge:**

   ```bash
   grep -rn "getActiveMemorySearchManager\|resolveActiveMemoryBackendConfig" src/ --include="*.ts" | \
     grep -v "node_modules\|memory-runtime\.ts\|\.test\." | head -20
   ```

   All callers must resolve through our registered `MemoryPluginRuntime`.

6. **Verify `src/agents/system-prompt.ts`:**
   - `buildMemorySection()` function defined inline
   - `buildMongoDBBridgeSection()` defined inline
   - NOT replaced by plugin import

   ```bash
   grep -n "buildMemorySection\|buildMongoDBBridgeSection" src/agents/system-prompt.ts
   ```

7. **Verify `src/agents/tools/memory-tool.ts`:**
   - Tool imports from `../../memory/types.js` intact
   - Tool registered directly, not via plugin
   ```bash
   grep -n "memory/types\|registerTool" src/agents/tools/memory-tool.ts | head -5
   ```

**Expected artifacts:** Plugin bridge verified intact or patched to work with new upstream interface.
**Required checks:** All 7 verification checks pass.
**Checkpoint type:** none
**Exit criteria:** `registerMemoryRuntime()` call exists. Import paths intact. All upstream callers get MongoDB manager.

---

## Phase 7: Protected Seam Review + Dependencies

**Objective:** Review all 38 protected seam files (plus 2 additional sacred seams), install deps, update guardrail config files.

**Inputs:** Conflicts resolved, plugin bridge verified.
**Files:** Protected seam files from `scripts/upstream-protected-paths.txt`.
**Dependencies:** Phase 6 complete.
**Allowed scope:** Review protected seams, install deps, update config files.
**Out-of-scope drift:** No feature additions.

**Steps:**

1. **Comprehensive protected-path verification (ALL 38 paths in file + 2 additional sacred seams):**

   ```bash
   while IFS= read -r path; do
     [[ "$path" =~ ^# ]] && continue
     [[ -z "$path" ]] && continue
     if [ ! -f "$path" ]; then
       echo "MISSING: $path"
     elif git diff --stat HEAD -- "$path" 2>/dev/null | tail -1 | grep -q "."; then
       echo "CHANGED: $path"
     else
       echo "UNCHANGED: $path"
     fi
   done < scripts/upstream-protected-paths.txt
   ```

   For each CHANGED file:
   - Read the merged version
   - Verify MongoDB behavior is preserved
   - If MongoDB-critical content was removed by upstream, restore from HEAD
   - If upstream changes are additive and don't break MongoDB, accept them

2. **`src/agents/pi-embedded-runner/compact.ts` sessionId guards:**

   ```bash
   grep -c "sessionId" src/agents/pi-embedded-runner/compact.ts
   # Expect 22+ (Wave 6 baseline was 22)
   ```

3. **`src/agents/pi-embedded-runner/run/attempt.ts` sessionId guards:**

   ```bash
   grep -c "sessionId" src/agents/pi-embedded-runner/run/attempt.ts
   # Expect 53+ (Wave 6 baseline was 53)
   ```

4. **`src/config/types.memory.ts`:**
   - Verify MongoDB-specific memory config types survive (MemoryScope, mongo_v2 types)
   - If upstream stripped them, restore from HEAD

5. **`package.json` final verification:**
   - `mongodb` in `dependencies`
   - `name: "@romiluz/clawmongo"`
   - No LanceDB in production exports
   - `packages/memory-host-sdk` in workspaces

   ```bash
   grep '"mongodb"' package.json
   grep '"name"' package.json | head -1
   grep -i "lancedb" package.json | grep -v "memory-lancedb" | grep -v devDependencies || echo "CLEAN"
   ```

6. **Lockfile regeneration:**

   ```bash
   rm -f pnpm-lock.yaml
   pnpm install
   ```

   Verify `pnpm install` succeeds without errors.

7. **Update `scripts/upstream-protected-paths.txt`** if any new files need protection:
   - Check for new memory-adjacent files from upstream
   - Add any new plugin bridge files that appeared

8. **Verify excluded paths absent:**

   ```bash
   for path in $(grep -v '^#' scripts/upstream-excluded-paths.txt | grep -v '^$'); do
     if [ -e "$path" ]; then
       echo "VIOLATION: $path exists -- must be removed"
     else
       echo "OK: $path absent"
     fi
   done
   ```

9. **Remove memory-lancedb export if upstream re-added it:**

   ```bash
   grep -n "memory-lancedb" package.json || echo "CLEAN - no lancedb export"
   # If found in exports: remove the line
   ```

10. **Verify entrypoints.ts filter against memory-lancedb:**
    ```bash
    grep -n "memory-lancedb" scripts/lib/plugin-sdk-entrypoints.json 2>/dev/null || echo "CLEAN"
    ```

**Expected artifacts:** All 38 protected seams (plus 2 additional sacred seams) verified. Dependencies installed. Guardrail files current.
**Required checks:** sessionId guards verified. Package.json correct. pnpm install succeeds. All protected paths accounted for.
**Checkpoint type:** none
**Exit criteria:** All 10 steps verified. `pnpm install` succeeds. Every protected path confirmed UNCHANGED, auto-restored from HEAD, or explicitly reviewed and patched.

---

## Phase 8: Build Verification

**Objective:** Ensure the merged code compiles.

**Inputs:** All conflicts resolved, seams verified, deps installed.
**Files:** Entire project.
**Dependencies:** Phase 7 complete.
**Allowed scope:** Fix build errors caused by merge only.
**Out-of-scope drift:** No feature additions. No unnecessary refactors.

**Steps:**

1. Run build:

   ```bash
   pnpm build
   ```

2. If TypeScript errors occur, classify each:
   - **Missing import (file moved):** Fix import path to point to correct location
   - **Changed interface (upstream plugin types):** Add compatibility layer or adapt `wrapForPluginBridge()`
   - **New type requirement:** Add MongoDB equivalent
   - **Pre-existing TS error in test file:** Document and ignore (known baseline)

3. **Expected issues from Wave 7:**
   - Imports referencing new upstream types may need resolution
   - `MemoryPluginRuntime` interface changes may require adapter updates
   - New upstream plugin types in `memory-state.ts` may need compatibility stubs
   - Dreaming/Wiki types may surface in shared interfaces

4. Record error count. If errors are ONLY in pre-existing test file baseline, proceed.

**Expected artifacts:** Build output log. Error classification list if any.
**Required checks:** `pnpm build` exit code 0.
**Checkpoint type:** none
**Exit criteria:** `pnpm build` exits with code 0. No new TS errors outside pre-existing baseline.

---

## Phase 9: Test Suite

**Objective:** Verify all tests pass at baseline.

**Inputs:** Successful build.
**Files:** Test files.
**Dependencies:** Phase 8 complete.
**Allowed scope:** Fix test failures caused by merge only.
**Out-of-scope drift:** No new tests, no feature additions.

**Steps:**

1. Run full test suite:

   ```bash
   pnpm test
   ```

2. Run MongoDB-specific tests:

   ```bash
   pnpm test -- src/memory/mongodb
   ```

3. Run search manager tests:

   ```bash
   pnpm test -- src/memory/search-manager
   ```

4. Classify any failures using clawmongo-test-triage skill:
   - **Failure in `src/memory/mongodb-*.ts`:** BLOCKER. Fix immediately.
   - **Failure in `src/memory/search-manager.ts`:** BLOCKER. Fix immediately.
   - **Failure in `extensions/memory-core/`:** OK -- upstream's plugin, not our code.
   - **Failure in `extensions/memory-wiki/`:** OK -- upstream's plugin, not our code.
   - **Failure in `packages/memory-host-sdk/`:** OK if not importing our code.
   - **Failure in other upstream-only code:** Accept if clearly not MongoDB-related.

5. Run lint/format:

   ```bash
   pnpm check
   ```

6. Run format fix if needed:
   ```bash
   pnpm format:fix
   ```

**Expected artifacts:** Test results log with pass/fail counts.
**Required checks:** All MongoDB tests pass. All search-manager tests pass.
**Checkpoint type:** none
**Exit criteria:** All existing MongoDB tests pass. `pnpm check` passes (or only pre-existing lint issues). Any new upstream test failures are clearly in upstream-only paths.

---

## Phase 10: Invariant Audit (22+ checks)

**Objective:** Run the full behavioral contract verification.

**Inputs:** Build and tests passing.
**Files:** Verification only.
**Dependencies:** Phase 9 complete.
**Allowed scope:** Verification only. Fix any violations found.
**Out-of-scope drift:** No feature additions.

**Steps -- verify ALL invariants hold true:**

```bash
# 1. MongoDB files intact
echo "1. MongoDB files: $(ls src/memory/mongodb-*.ts | wc -l)" # Must be 75

# 2. Total memory files intact
echo "2. Total memory: $(ls src/memory/*.ts | wc -l)" # Must be 149

# 3. search-manager.ts is ours (MongoDB-only)
echo "3. search-manager.ts lines: $(wc -l < src/memory/search-manager.ts)" # Must be 126

# 4. types.ts exists
echo "4. types.ts: $(test -f src/memory/types.ts && echo EXISTS || echo MISSING)"

# 5. index.ts exports
echo "5. index.ts: $(test -f src/memory/index.ts && echo EXISTS || echo MISSING)"

# 6. packages/memory-host-sdk/ exists (upstream)
echo "6. memory-host-sdk: $(test -f packages/memory-host-sdk/package.json && echo EXISTS || echo MISSING)"

# 7. extensions/memory-core/ exists (upstream)
echo "7. memory-core: $(test -f extensions/memory-core/package.json && echo EXISTS || echo MISSING)"

# 8. memory-state.ts exists (upstream plugin bridge)
echo "8. memory-state.ts: $(test -f src/plugins/memory-state.ts && echo EXISTS || echo MISSING)"

# 9. Build passes
pnpm build && echo "9. Build: PASS" || echo "9. Build: FAIL"

# 10. MongoDB tests pass
pnpm test -- src/memory/mongodb 2>&1 | tail -5

# 11. Search manager tests pass
pnpm test -- src/memory/search-manager 2>&1 | tail -5

# 12. No QMD/SQLite/LanceDB imports in MongoDB memory files (broad scope)
echo "12a. Non-MongoDB imports in mongodb-*.ts: $(grep -rn 'qmd\|sqlite\|lancedb\|qdrant\|chroma\|redis\|pinecone\|weaviate' src/memory/mongodb-*.ts -l 2>/dev/null | wc -l)" # Must be 0
echo "12b. Non-MongoDB imports in memory/*.ts: $(grep -rn 'qmd\|sqlite\|lancedb\|qdrant\|chroma\|redis\|pinecone\|weaviate' src/memory/*.ts -l 2>/dev/null | wc -l)" # Must be 0
echo "12c. Non-MongoDB imports in startup: $(grep -rn 'qmd\|sqlite\|lancedb\|qdrant\|chroma\|redis\|pinecone\|weaviate' src/gateway/server-startup-memory.ts -l 2>/dev/null | wc -l)" # Must be 0
echo "12d. Non-MongoDB imports in system-prompt: $(grep -rn 'qmd\|sqlite\|lancedb\|qdrant\|chroma\|redis\|pinecone\|weaviate' src/agents/system-prompt.ts -l 2>/dev/null | wc -l)" # Must be 0

# 13. mongodb in package.json dependencies
echo "13. mongodb dep: $(grep -c '"mongodb"' package.json)"

# 14. buildMongoDBBridgeSection call exists
echo "14. bridgeSection: $(grep -c 'buildMongoDBBridgeSection' src/agents/system-prompt.ts)"

# 15. sessionId guards in compact.ts and attempt.ts
echo "15a. compact sessionId: $(grep -c 'sessionId' src/agents/pi-embedded-runner/compact.ts)" # 22+
echo "15b. attempt sessionId: $(grep -c 'sessionId' src/agents/pi-embedded-runner/run/attempt.ts)" # 53+

# 16. memory-tool.ts exists
echo "16. memory-tool: $(test -f src/agents/tools/memory-tool.ts && echo EXISTS || echo MISSING)"

# 17. server-startup-memory.ts imports from ../memory/
echo "17. startup imports: $(grep -c '../memory/' src/gateway/server-startup-memory.ts)"

# 18. registerMemoryRuntime call exists
echo "18. registerMemoryRuntime: $(grep -c 'registerMemoryRuntime' src/gateway/server-startup-memory.ts)"

# 19. 0 behind upstream
echo "19. behind: $(git rev-list --count HEAD..upstream/main)" # Must be 0 (after commit)

# 20. 2-parent merge (after commit)
# Deferred to Phase 11

# 21. No src/memory/manager.ts (QMD) outside extensions
echo "21. QMD manager: $(test -f src/memory/manager.ts && echo VIOLATION || echo CLEAN)"

# 22. All protected paths accounted for (38 in file + 2 sacred seams verified separately)
echo "22. Protected paths: $(grep -v '^\s*$' scripts/upstream-protected-paths.txt | grep -v '^\s*#' | wc -l) entries" # Must be 38

# 23 (NEW). extensions/memory-wiki/ exists if upstream added it
echo "23. memory-wiki: $(test -d extensions/memory-wiki && echo EXISTS || echo N/A)"

# 24 (NEW). No plugins.slots.memory override breaking MongoDB
echo "24. slots.memory: $(grep -rn 'slots.*memory' src/ --include='*.ts' -l 2>/dev/null | head -5)"

# 25 (NEW). Excluded paths absent
for path in $(grep -v '^#' scripts/upstream-excluded-paths.txt | grep -v '^$'); do
  test -e "$path" && echo "25. VIOLATION: $path exists" || echo "25. OK: $path absent"
done

# 26 (NEW). memory-lancedb export not in package.json
echo "26. lancedb export: $(grep -c 'plugin-sdk/memory-lancedb' package.json 2>/dev/null || echo 0)" # Must be 0
```

**Expected artifacts:** Full invariant check results.
**Required checks:** All 26 invariants pass.
**Checkpoint type:** none
**Exit criteria:** All invariants PASS. Any violation is fixed before proceeding.

---

## Phase 11: Commit, Verify, and Cleanup

**Objective:** Finalize the merge commit, verify 2-parent integrity, clean up.

**Inputs:** All invariants pass.
**Files:** Entire working tree.
**Dependencies:** Phase 10 complete.
**Allowed scope:** Commit + post-merge cleanup.
**Out-of-scope drift:** No code changes after commit (except formatting/baseline updates).

**Steps:**

1. Commit the merge (NOT `scripts/committer` -- merge commits must use `git commit` directly):

   ```bash
   git commit -m "$(cat <<'EOF'
   Upstream sync wave 7: absorb 4,389 commits

   Adopted upstream changes (Dreaming, Wiki, Bedrock embeddings, exec approval,
   provider replay, channel improvements) while preserving ClawMongo's
   MongoDB-first memory system. HYBRID approach:

   - ACCEPTED: extensions/memory-wiki/ (upstream's new wiki plugin)
   - PRESERVED: src/memory/ (149 files: 75 mongodb + 74 shared)
   - KEPT: memory-tool.ts, memory-tool.runtime.ts (direct tool registration)
   - WIRED: server-startup-memory.ts registers MongoDB via registerMemoryRuntime()
   - KEPT: system-prompt.ts keeps inline buildMemorySection/buildMongoDBBridgeSection

   MongoDB-first contract: 24 collections, 67+ indexes preserved.
   No QMD, SQLite, LanceDB, or any non-MongoDB backend in production paths.
   EOF
   )"
   ```

2. Verify 2-parent merge commit:

   ```bash
   git cat-file -p HEAD | head -5   # Must show two "parent" lines
   git show --pretty=format:"%P" HEAD | wc -w  # Must be 2
   ```

3. Verify drift state:

   ```bash
   git rev-list --count HEAD..upstream/main    # Must be 0
   git rev-list --count upstream/main..HEAD    # Must be >328
   ```

4. Post-merge formatting cleanup:

   ```bash
   pnpm format:fix
   pnpm check
   ```

5. Update baselines if needed:
   - `EXPECTED_STANDARD_INDEX_COUNT` in `src/memory/mongodb-e2e.e2e.test.ts` (if upstream added indexes)
   - `EXPECTED_COLLECTION_SUFFIXES` in `src/memory/mongodb-e2e.e2e.test.ts` (if upstream added collections)
   - `scripts/upstream-drift-baseline.txt` (regenerate)
   - `scripts/upstream-drift-allowlist.txt` (add any new drift paths)

6. Run `bundled-plugin-metadata.generated.ts` regeneration if upstream added new plugins:

   ```bash
   # Check if regeneration script exists
   ls scripts/regenerate-bundled-plugin-metadata* 2>/dev/null || echo "Manual regeneration needed"
   ```

7. Verify excluded paths are still absent:

   ```bash
   for path in $(grep -v '^#' scripts/upstream-excluded-paths.txt | grep -v '^$'); do
     test -e "$path" && echo "VIOLATION: $path" || echo "OK: $path absent"
   done
   ```

8. Commit cleanup as separate commit (not amending the merge):

   ```bash
   git add -A
   git diff --cached --stat | head -20
   # Only commit if there are actual changes
   git diff --cached --quiet || git commit -m "$(cat <<'EOF'
   Post-merge cleanup: formatting + baselines (wave 7)
   EOF
   )"
   ```

9. Final full verification:
   ```bash
   pnpm build
   pnpm test
   pnpm check
   ```

**Expected artifacts:** Clean 2-parent merge commit + optional cleanup commit.
**Required checks:** 2-parent merge. 0 behind upstream. Build, tests, lint pass.
**Checkpoint type:** none
**Exit criteria:** 2-parent merge commit exists. `git rev-list --count HEAD..upstream/main` = 0. `pnpm build`, `pnpm test`, and `pnpm check` all pass.

---

## Phase 12: Dreaming + Wiki Concept Evaluation (Document Only)

**Objective:** Evaluate upstream Dreaming and Wiki memory concepts and document MongoDB-native re-implementation potential. NO code changes.

**Inputs:** Clean merged codebase with upstream Dreaming + Wiki code available for reading.
**Files:** Create `docs/plans/2026-04-06-dreaming-wiki-mongodb-evaluation.md` (evaluation doc only).
**Dependencies:** Phase 11 complete.
**Allowed scope:** Read upstream code + write evaluation document.
**Out-of-scope drift:** NO implementation. NO code changes. Document only.

**Steps:**

1. **Read upstream Dreaming system:**

   ```bash
   # Find Dreaming-related files
   find extensions/memory-core/ -name "*.ts" | xargs grep -l "dream\|Dream\|DREAM" 2>/dev/null
   find src/plugins/ -name "*.ts" | xargs grep -l "dream\|Dream\|DREAM" 2>/dev/null
   ```

   Key concepts to evaluate:
   - Daily ingestion sweep mechanism
   - REM preview (dream preview) pattern
   - Weighted recall promotion
   - Aging controls
   - Diary surface

2. **Read upstream Wiki system:**

   ```bash
   # Find Wiki-related files
   find extensions/ -name "*.ts" -path "*wiki*" 2>/dev/null
   ls extensions/memory-wiki/ 2>/dev/null
   ```

   Key concepts to evaluate:
   - Wiki corpus management
   - Prompt supplement mechanism
   - Memory search bridge
   - LLM wiki generation

3. **Map each concept to MongoDB equivalent** (from design doc):

   | Upstream Concept            | MongoDB Equivalent                         | ClawMongo Status                              |
   | --------------------------- | ------------------------------------------ | --------------------------------------------- |
   | Daily ingestion sweep       | Episode materialization with daily trigger | Already have `checkAutoEpisodeTriggers`       |
   | REM preview (dream preview) | Episode draft with `status: "draft"`       | Extend existing episode status lifecycle      |
   | Weighted recall promotion   | Importance scoring on events/episodes      | Already identified in gap analysis            |
   | Aging controls              | TTL indexes + importance decay             | Already have TTL on caches                    |
   | Diary surface               | New structured memory type `"diary"`       | Maps to existing structured_memory collection |
   | Wiki corpus                 | KB entries collection (already exists)     | May need `source: "wiki"` category            |
   | Prompt supplement           | buildMemorySection in system-prompt.ts     | Already have MongoDB bridge section           |
   | Memory search bridge        | Hybrid retrieval KB lane                   | Already wired                                 |
   | LLM wiki generation         | Episode summary to KB promotion pipeline   | New extraction path concept                   |

4. **Write evaluation document:**

   ```bash
   # Create evaluation doc
   # File: docs/plans/2026-04-06-dreaming-wiki-mongodb-evaluation.md
   ```

   Document structure:
   - Executive Summary (1 paragraph)
   - Upstream Dreaming System Analysis
     - Architecture overview
     - Key components and data flow
     - What ClawMongo already has (episodes, triggers, TTL, structured memory)
     - What would be new (diary type, importance decay, dream preview status)
     - MongoDB implementation path (collections, indexes, queries)
     - Estimated effort (T-shirt size)
   - Upstream Wiki System Analysis
     - Architecture overview
     - Key components and data flow
     - What ClawMongo already has (KB collection, hybrid retrieval, prompt sections)
     - What would be new (wiki source category, LLM generation pipeline, prompt supplement)
     - MongoDB implementation path
     - Estimated effort
   - Priority Recommendation
   - Dependencies and Risks
   - NOT in scope: any implementation

5. **Verify evaluation doc is document-only (no code files modified):**

   ```bash
   git diff --name-only | grep -v "docs/" | grep -v ".md$"
   # Must be empty -- only docs should be changed
   ```

6. Commit evaluation doc:

   ```bash
   git add docs/plans/2026-04-06-dreaming-wiki-mongodb-evaluation.md
   git commit -m "$(cat <<'EOF'
   Docs: evaluate Dreaming + Wiki concepts for MongoDB (wave 7)

   Document-only evaluation of upstream Dreaming and Wiki memory features.
   Maps each concept to existing or potential MongoDB-native equivalents.
   No implementation -- evaluation and roadmap only.
   EOF
   )"
   ```

**Expected artifacts:** `docs/plans/2026-04-06-dreaming-wiki-mongodb-evaluation.md`
**Required checks:** Document written. No code files modified.
**Checkpoint type:** none
**Exit criteria:** Evaluation document exists. No code changes. Commit made.

---

## Risk Matrix

| Risk                                                                 | Dim.      | P (1-5) | I (1-5) | Score | Mitigation                                                           |
| -------------------------------------------------------------------- | --------- | ------- | ------- | ----- | -------------------------------------------------------------------- |
| File location conflicts cause mongodb-\*.ts to appear at wrong paths | Technical | 4       | 5       | 20    | Phase 2: `git checkout HEAD -- src/memory/` restores ALL             |
| memory-state.ts interface change breaks plugin bridge                | Technical | 3       | 5       | 15    | Phase 5B.4 + Phase 6: verify interface, update wrapForPluginBridge() |
| Import breakage from upstream type changes                           | Technical | 4       | 3       | 12    | Phase 8: build catches all TS errors                                 |
| system-prompt.ts loses buildMongoDBBridgeSection                     | Technical | 3       | 5       | 15    | Phase 5B.6: explicit manual merge preserving our functions           |
| server-startup-memory.ts switches to plugin imports                  | Technical | 3       | 5       | 15    | Phase 5B.8: keep our imports, verify registerMemoryRuntime           |
| memory-tool.ts deletion breaks tool registration                     | Technical | 4       | 4       | 16    | Phase 4A: KEEP OURS for all deleted-upstream files                   |
| outbound-send-service.ts introduces non-MongoDB persistence          | Technical | 2       | 4       | 8     | Phase 5B.5: review the 2nd changed seam explicitly                   |
| sessionId guards lost in compact.ts/attempt.ts                       | Technical | 2       | 5       | 10    | Phase 7 steps 2-3: explicit sessionId count verification             |
| pnpm-lock.yaml irrecoverable                                         | Technical | 4       | 2       | 8     | Delete and regenerate                                                |
| Package.json metadata overwritten                                    | Quality   | 5       | 3       | 15    | Phase 5B.2: explicit ClawMongo override checklist                    |
| memory-lancedb export re-appears                                     | Quality   | 4       | 3       | 12    | Phase 7 step 9: explicit lancedb check                               |
| >500 conflicts overwhelm resolution                                  | Timeline  | 3       | 3       | 9     | Phased approach: bulk tiers first, manual last                       |
| Upstream tests fail in our tree                                      | Quality   | 5       | 1       | 5     | Accept -- upstream plugin tests, not our code                        |
| MongoDB test regression                                              | Technical | 1       | 5       | 5     | Phase 9: full MongoDB test suite                                     |
| Dreaming/Wiki types leak into shared interfaces                      | Technical | 2       | 3       | 6     | Phase 8: build catches, adapt types                                  |
| New upstream config types missing MongoDB fields                     | Technical | 2       | 3       | 6     | Phase 7 step 4: config schema review                                 |
| MemoryPluginRuntime interface changed                                | Technical | 3       | 4       | 12    | Phase 6 step 4: adapt wrapForPluginBridge()                          |

---

## Behavioral Contract (26 Invariants)

After merge completion, ALL must hold true:

1. `ls src/memory/mongodb-*.ts | wc -l` = 75 (all MongoDB files intact)
2. `ls src/memory/*.ts | wc -l` = 149 (all memory files intact)
3. `src/memory/search-manager.ts` is our MongoDB-only version (126 lines)
4. `src/memory/types.ts` exists with `MemorySearchManager` interface
5. `src/memory/index.ts` exports all MongoDB memory symbols
6. `packages/memory-host-sdk/` exists (from upstream)
7. `extensions/memory-core/` exists (upstream's SQLite plugin)
8. `src/plugins/memory-state.ts` exists (upstream plugin bridge)
9. `pnpm build` passes
10. `pnpm test -- src/memory/mongodb` passes (all MongoDB tests)
11. `pnpm test -- src/memory/search-manager` passes
12. No QMD/SQLite/LanceDB/Qdrant/Chroma/Redis/Pinecone/Weaviate imports in `src/memory/*.ts`, `src/gateway/server-startup-memory.ts`, or `src/agents/system-prompt.ts`
13. `mongodb` is in `package.json` dependencies
14. `buildMongoDBBridgeSection` call exists in `src/agents/system-prompt.ts`
15. `sessionId` guards exist in `compact.ts` (22+ hits) and `attempt.ts` (53+ hits)
16. `src/agents/tools/memory-tool.ts` exists (our direct tool registration)
17. `server-startup-memory.ts` imports from `../memory/` (not `../plugins/`) for its own memory calls
18. `server-startup-memory.ts` calls `registerMemoryRuntime()` to register MongoDB as plugin runtime
19. `git rev-list --count HEAD..upstream/main` = 0
20. Merge commit has 2 parents
21. No `src/memory/manager.ts` (QMD) outside `extensions/memory-core/`
22. All 38 protected paths in `scripts/upstream-protected-paths.txt` explicitly accounted for (plus 2 additional sacred seams: types.ts, index.ts)
23. `extensions/memory-wiki/` exists if upstream added it (new in Wave 7)
24. No `plugins.slots.memory` override breaking MongoDB routing
25. Excluded paths absent (scripts/sqlite-vec-smoke.mjs, src/plugin-sdk/memory-lancedb.ts)
26. memory-lancedb export NOT in package.json exports

---

## Fresh Review Resolution

**Accepted findings:**

1. **(BLOCKING) Protected path count 41 -> 38.** Fixed: all references updated to 38. The protected-paths file has 38 non-blank non-comment entries. `types.ts` and `index.ts` are NOT in the file but are documented as additional sacred seams verified separately.
2. **Phase 7 step 10 wrong entrypoints path.** Fixed: changed `src/plugins/plugin-sdk-entrypoints.json` to `scripts/lib/plugin-sdk-entrypoints.json`.
3. **Design doc stale baselines.** Fixed: added explicit note after baselines table that plan supersedes design doc values (72+/23+/66+ -> 75/24/67).
4. **Invariant 12 scope too narrow.** Fixed: expanded from `src/memory/mongodb-*.ts` only to include `src/memory/*.ts`, `src/gateway/server-startup-memory.ts`, and `src/agents/system-prompt.ts` in both Phase 10 script and Behavioral Contract.
5. **types.ts and index.ts not in protected-paths file.** Fixed: corrected accounting from "5 sacred" to "3 sacred (in file) + 2 additional sacred seams (verified but not in file)". Updated remaining count from 34 to 33.

**Rejected findings:** 2. **search-manager.ts line count.** Reviewer claimed 127 lines; actual `wc -l` confirms 126 lines (verified via both `wc -l` and `awk END{print NR}`). Plan value of 126 is correct. No change needed.

---

## Phase Dependency Map

- Phase 0: depends on [clean working tree], creates [backup branch, baselines], enables [Phase 1]
- Phase 1: depends on [Phase 0], creates [merge state, conflict list], enables [Phase 2-5]
- Phase 2: depends on [Phase 1], creates [resolved file-location conflicts], enables [Phase 3]
- Phase 3: depends on [Phase 2], creates [resolved rename/delete conflicts], enables [Phase 4]
- Phase 4: depends on [Phase 3], creates [resolved modify/delete conflicts], enables [Phase 5]
- Phase 5: depends on [Phase 4], creates [zero unresolved conflicts], enables [Phase 6]
- Phase 6: depends on [Phase 5], creates [verified plugin bridge], enables [Phase 7]
- Phase 7: depends on [Phase 6], creates [verified seams, installed deps], enables [Phase 8]
- Phase 8: depends on [Phase 7], creates [passing build], enables [Phase 9]
- Phase 9: depends on [Phase 8], creates [passing tests], enables [Phase 10]
- Phase 10: depends on [Phase 9], creates [all invariants verified], enables [Phase 11]
- Phase 11: depends on [Phase 10], creates [2-parent merge commit, cleanup], enables [Phase 12]
- Phase 12: depends on [Phase 11], creates [Dreaming + Wiki evaluation doc], enables [post-merge]

## Phase Autonomy Classification

| Phase | Checkpoint Type | Classification | Reason                                             |
| ----- | --------------- | -------------- | -------------------------------------------------- |
| 0     | none            | AFK            | Read-only verification                             |
| 1     | none            | AFK            | Single git command + recording                     |
| 2     | none            | AFK            | Bulk git checkout HEAD for our files               |
| 3     | none            | AFK            | Batch accept upstream at new locations             |
| 4     | none            | AFK            | Clear KEEP OURS vs ACCEPT UPSTREAM rules           |
| 5     | human_verify    | HITL           | Manual merges require judgment on conflict content |
| 6     | none            | AFK            | Verification checks with clear rules               |
| 7     | none            | AFK            | Clear verification criteria per file               |
| 8     | none            | AFK            | Build and fix errors by classification rules       |
| 9     | none            | AFK            | Run tests, classify failures by rules              |
| 10    | none            | AFK            | Run invariant script, fix any violations           |
| 11    | none            | AFK            | Commit and verify                                  |
| 12    | none            | AFK            | Read upstream code, write evaluation doc           |

---

## Acceptance Checks

1. `git rev-list --count HEAD..upstream/main` = 0 (caught up)
2. `git show --pretty=format:"%P" HEAD~1 | wc -w` = 2 (2-parent merge, accounting for cleanup commit)
3. `pnpm build` exits 0
4. `pnpm test` passes at baseline
5. `pnpm test -- src/memory/mongodb` passes 100%
6. `pnpm test -- src/memory/search-manager` passes 100%
7. `pnpm check` passes (or pre-existing only)
8. `ls src/memory/mongodb-*.ts | wc -l` = 75
9. All 26 invariants from Phase 10 pass
10. `docs/plans/2026-04-06-dreaming-wiki-mongodb-evaluation.md` exists
11. No QMD/SQLite/LanceDB/Qdrant/Chroma/Redis/Pinecone/Weaviate in production memory paths
12. 104+ live e2e tests pass (post-sync, separate session)

---

## Post-Merge Follow-Up (Separate Sessions)

### Near-term:

1. npm publish: `@romiluz/clawmongo@2026.4.X`
2. Run live e2e validation against MongoDB Docker stack (104-test gate)
3. Update drift allowlist and baseline for new upstream paths

### Skills update (dedicated session):

1. Update `clawmongo-upstream-sync` skill for Wave 7 changes
2. Update `clawmongo-live-validation` skill
3. Update `clawmongo-test-triage` skill

### Future work (from Phase 12 evaluation):

1. Prioritize Dreaming vs Wiki MongoDB-native implementation based on evaluation
2. Design doc for chosen feature
3. Implementation plan
