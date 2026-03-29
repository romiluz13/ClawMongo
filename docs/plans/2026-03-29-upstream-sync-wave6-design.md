# Upstream Sync Wave 6 Design

## Purpose

Absorb 1,060 upstream OpenClaw commits while preserving ClawMongo's MongoDB-first architecture. Upstream gutted `src/memory/` entirely (106 files, 22,342 lines deleted) and moved to a plugin-based memory system. This sync must adopt every non-conflicting upgrade while ensuring MongoDB remains the ONE AND ONLY backend.

## Users

Rom (ClawMongo maintainer/developer). Production consumers via npm `@romiluz/clawmongo`.

## Success Criteria

- [ ] `git rev-list --count HEAD..upstream/main` = 0 (fully synced)
- [ ] `pnpm build` passes
- [ ] `pnpm test -- src/memory/mongodb` passes (all MongoDB-specific tests)
- [ ] All 20 behavioral invariants verified (see plan)
- [ ] 2-parent merge commit
- [ ] No QMD/SQLite/LanceDB imports in `src/memory/mongodb-*.ts`
- [ ] 72 mongodb-\*.ts files intact
- [ ] 23 collections, 62+ indexes preserved
- [ ] Plugin bridge returns MongoDB manager via `getActiveMemorySearchManager()` after registration

## Constraints

- **MongoDB is #1** — even above OpenClaw. MongoDB is the sole backend, no exceptions
- **Zero regression** — 90+ e2e tests must continue passing
- **Every OpenClaw upgrade flows in** — unless it directly conflicts with MongoDB-first
- **Dead code is acceptable** — upstream SQLite/LanceDB plugin code can exist in the repo as long as it NEVER runs in ClawMongo
- **Skills must be updated post-merge** — clawmongo-upstream-sync, clawmongo-live-validation, clawmongo-test-triage

## Out of Scope

- QMD/LanceDB adoption (never)
- Converting ClawMongo to a plugin-only model
- Monorepo restructuring of MongoDB files into extensions/
- Touching Memongo (/Users/rom.iluz/Dev/Memongo)
- Registering MongoDB as a formal plugin via `api.registerMemoryRuntime()` (future consideration)
- Skill improvements (deferred to post-merge follow-up)

## Approach Chosen: Pragmatic HYBRID

**Why**: Keeps upstream structure for easy future syncs. MongoDB owns ALL runtime. SQLite/LanceDB code sits dead in `extensions/` and `packages/` but never runs. Every OpenClaw upgrade flows in with minimal friction.

**Runtime**: 100% MongoDB (always)
**Repo**: Contains upstream plugin files (dead code for us)
**Future syncs**: EASY (minimal conflicts)
**MongoDB position**: SOLE backend, no competition

## Architecture

```
src/memory/
├── mongodb-*.ts (72 files — OUR CODE, sacred)
├── search-manager.ts (MongoDB-only, 114+ lines)
├── types.ts (our interfaces)
├── index.ts (barrel exports)
├── backend-config.ts (MongoDB resolver)
├── prompt-section.ts (MongoDB prompt builder)
└── [other shared files we depend on]

extensions/memory-core/ (upstream SQLite plugin — ACCEPTED, NEVER USED)
packages/memory-host-sdk/ (upstream SDK — ACCEPTED, NEVER USED)
extensions/memory-lancedb/ (upstream LanceDB — ACCEPTED, NEVER USED)

src/plugins/memory-state.ts (upstream bridge — ACCEPTED as-is, we register into it)
src/plugins/memory-runtime.ts (upstream accessor — ACCEPTED as-is, callers get MongoDB via registration)
```

## Components

### 1. Merge Resolution (Phases 0-3)

- Backup, merge --no-commit, resolve ~54 conflicts
- Tier 1 (content): accept upstream for generated files, accept upstream for memory-core
- Tier 2 (rename/delete): accept upstream at new locations (their plugin files)
- Tier 3 (restore): restore our files deleted by upstream

### 2. MongoDB File Restoration (Phase 2)

- Restore 72 mongodb-\*.ts files
- Restore shared dependencies (types.ts, index.ts, search-manager.ts, etc.)
- Restore embedding files we actually import

### 3. Plugin Bridge Registration (Phase 6)

- Accept `src/plugins/memory-state.ts` as-is (it's a clean registry)
- Register MongoDB manager as `MemoryPluginRuntime` via `registerMemoryRuntime()` in `server-startup-memory.ts`
- Keep `src/agents/system-prompt.ts` inline buildMemorySection/buildMongoDBBridgeSection
- Verify all 5 upstream callers of `getActiveMemorySearchManager()` get MongoDB manager

### 4. Protected Seam Verification (Phase 6)

- compact.ts: sessionId guards intact
- attempt.ts: guardSessionManager wiring intact
- pi-tools.ts: MongoDB tool registration
- zod-schema.ts: MongoDB config schema
- package.json: MongoDB dependency + ClawMongo overrides

### 5. Validation Gates (Phases 7-10)

- Excluded path cleanup
- Build and type check
- Full test suite
- Commit with 2-parent verification

## Data Flow

```
User Request → OpenClaw Runtime
  → Direct path (our code): src/memory/search-manager.ts → MongoDBMemoryManager → MongoDB
  → Plugin bridge path (upstream callers): src/plugins/memory-runtime.ts
    → getActiveMemorySearchManager() → getMemoryRuntime()
    → Our registered MemoryPluginRuntime adapter → MongoDBMemoryManager → MongoDB
```

ClawMongo registers MongoDB as the plugin runtime at startup via `registerMemoryRuntime()`. Both paths resolve to the same MongoDB backend. Upstream callers get MongoDB through the plugin bridge. Our code calls MongoDB directly.

## Error Handling

| Error                              | Response                                              |
| ---------------------------------- | ----------------------------------------------------- |
| Merge conflict on MongoDB file     | KEEP OURS, always                                     |
| Import breakage from moved files   | Fix import path in Phase 8                            |
| Plugin bridge doesn't find MongoDB | Phase 6 registers MongoDB via registerMemoryRuntime() |
| Upstream test fails in our tree    | Accept if in extensions/memory-core (not our code)    |
| MongoDB test regression            | STOP. Investigate before proceeding                   |
| pnpm-lock.yaml conflict            | Delete and regenerate                                 |

## Testing Strategy

1. **Phase 8**: `pnpm build` — catches all import/type errors
2. **Phase 9**: `pnpm test` — full test suite
3. **Phase 9**: `pnpm test -- src/memory/mongodb` — MongoDB-specific tests
4. **Phase 9**: `pnpm test -- src/memory/search-manager` — critical file tests
5. **Post-merge**: Live Docker MongoDB e2e gate (`production-readiness.e2e.test.ts`)

## Post-Merge Follow-Up

### Immediate (same session)

- `pnpm format:fix` + `pnpm check`
- Update `EXPECTED_STANDARD_INDEX_COUNT` if needed
- Update drift baseline/allowlist files

### Near-term (next session)

- npm publish `@romiluz/clawmongo@2026.3.34`
- Live e2e validation on Docker MongoDB stack
- Update `scripts/upstream-excluded-paths.txt` and `scripts/upstream-protected-paths.txt`

### Skill Updates (dedicated session)

- Update `clawmongo-upstream-sync` skill for new plugin architecture (memory-core, memory-host-sdk paths)
- Update `clawmongo-live-validation` skill for any new test paths/gates
- Update `clawmongo-test-triage` skill for plugin-related test failures
- Improve all three to /skill-creator standards

## Questions Resolved

- Q: Can ClawMongo become just a MongoDB plugin?
  A: No — upstream plugin contract covers ~20% of ClawMongo's capabilities. Graph, episodes, entities, retrieval planner, CRAG, MMR all have no plugin hooks.
- Q: Should we delete upstream's SQLite code?
  A: No — keeping it as dead code makes future syncs trivial. MongoDB owns runtime regardless.
- Q: What about Memongo?
  A: Separate product for "memory as a standalone service". Not part of this sync. Could inform future `extensions/memory-mongodb/` package.
- Q: Is HYBRID approach correct?
  A: Yes — 100% MongoDB runtime, upstream structure preserved for sync ease.
