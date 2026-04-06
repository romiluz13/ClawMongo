# Upstream Sync Wave 7 Design

## Purpose

Absorb 4,389 upstream OpenClaw commits into ClawMongo while preserving the MongoDB-only architecture. Evaluate upstream Dreaming and Wiki memory concepts for future MongoDB-native re-implementation (document only, no code changes).

## Users

Project maintainer — fork maintenance and MongoDB-first architecture preservation.

## Success Criteria

- [ ] 0 commits behind upstream/main after merge
- [ ] All 72+ mongodb-\*.ts files intact and unchanged
- [ ] 23+ MongoDB collections, 66+ indexes preserved
- [ ] `pnpm build` exits 0
- [ ] `pnpm test` passes at baseline
- [ ] 2-parent merge commit verified
- [ ] Plugin bridge (`registerMemoryRuntime`) still wires MongoDB
- [ ] All 41 protected seams reviewed and documented
- [ ] 2 excluded paths confirmed absent
- [ ] Dreaming + Wiki evaluation documented with MongoDB mapping notes
- [ ] No QMD/SQLite/LanceDB imports in src/memory/mongodb-\*.ts
- [ ] 104-test live MongoDB gate passes post-sync

## Constraints

- MongoDB is the ONLY backend — no exceptions
- HYBRID strategy: accept upstream plugin dead code, MongoDB owns 100% runtime
- 41 protected seam files must be explicitly reviewed per `scripts/upstream-protected-paths.txt`
- 2 excluded paths must never appear post-sync per `scripts/upstream-excluded-paths.txt`
- All sub-agents must actively load and use available skills (MongoDB skills, ClawMongo skills)
- When skills don't cover a pattern, use Bright Data MCP to find proof of correct approach
- Single merge — no sub-wave splitting

## Out of Scope

- Implementing Dreaming or Wiki in MongoDB (document evaluation only)
- Fixing pre-existing test failures unrelated to sync
- npm publish (separate step after sync verification)
- Drift allowlist expansion (follow-up commit)

## Approach Chosen

**HYBRID-Continuous (Option A)** — Follow the proven Wave 6 pattern. Single `git merge upstream/main --no-commit`, resolve by 4-tier classification, 11-phase structure + Phase 12 for idea evaluation. All guardrail scripts (`upstream-steady-state.sh`, `upstream-sync-report.ts`, `upstream-protected-paths.txt`, `upstream-excluded-paths.txt`) enforced.

## Architecture

### Merge Strategy

```
Single merge: git merge upstream/main --no-commit
├─ 4,389 upstream commits absorbed in one operation
├─ Conflict resolution by 4-tier classification
├─ HYBRID: accept upstream dead code, MongoDB owns runtime
└─ 2-parent merge commit at completion
```

### Conflict Classification Tiers

| Tier | Type          | Resolution                                            | Example                                     |
| ---- | ------------- | ----------------------------------------------------- | ------------------------------------------- |
| 1    | File-location | REJECT git suggestion, KEEP SRC/MEMORY                | Upstream rename detection for MongoDB files |
| 2    | Rename/delete | Accept upstream at new location OR restore ours       | QMD files moved to extensions/              |
| 3    | Modify/delete | Restore ours if MongoDB, accept upstream otherwise    | mongodb-\*.ts files                         |
| 4    | Content       | Merge intent when safe, KEEP OURS for protected seams | package.json, memory-state.ts               |

### Protected Seam Review (41 files)

Two categories:

- **CHANGED upstream** (2 files — require merge review):
  - `src/plugins/memory-state.ts` — plugin registry, verify MongoDB registration still works
  - `src/infra/outbound/outbound-send-service.ts` — outbound persistence, verify no backend assumptions
- **UNCHANGED upstream** (39 files — verify still intact after merge):
  - All mongodb-\*.ts files, search-manager.ts, backend-config.ts, etc.

### Plugin Bridge Verification

```
server-startup-memory.ts
  → registerMemoryRuntime() called after plugin load
  → wrapForPluginBridge() structural adapter
  → All callers of getActiveMemorySearchManager() → MongoDB
  → resolveMemoryBackendConfig returns "builtin" (facade)
```

## Components

### Phase Structure (13 Phases)

| Phase | Name                                              | Gate                                               |
| ----- | ------------------------------------------------- | -------------------------------------------------- |
| 0     | Preparation & Backup                              | Backup branch created                              |
| 1     | Pre-flight: Run guardrail scripts                 | steady-state.sh + sync-report.ts                   |
| 2     | Initial Merge (--no-commit)                       | Merge state entered                                |
| 3     | Tier 1-2: File-location + Rename/Delete conflicts | All Tier 1-2 resolved                              |
| 4     | Tier 3: Modify/Delete conflicts (restore MongoDB) | All 72+ mongodb-\*.ts restored                     |
| 5     | Tier 4: Content conflicts (protected seams)       | memory-state.ts, outbound-send-service.ts reviewed |
| 6     | Plugin Bridge Verification                        | registerMemoryRuntime wiring confirmed             |
| 7     | Lockfile & Dependencies                           | pnpm install clean                                 |
| 8     | Build Verification                                | pnpm build exits 0                                 |
| 9     | Test Suite                                        | pnpm test passes at baseline                       |
| 10    | Invariant Audit (22+ checks)                      | All invariants PASS                                |
| 11    | Commit & 2-Parent Verification                    | 2-parent merge confirmed                           |
| 12    | Dreaming + Wiki Evaluation                        | Evaluation doc written                             |

### Invariant Checks (22+ from Wave 6, extended)

1. MongoDB is the ONLY active memory backend at runtime
2. All calls to `getActiveMemorySearchManager()` resolve to MongoDBMemoryManager
3. No QMD/SQLite/LanceDB imports in src/memory/mongodb-\*.ts
4. 72+ mongodb-\*.ts files present and intact
5. search-manager.ts unmodified (MongoDB-only factory)
6. backend-config.ts unmodified (MongoDB resolver)
7. 23+ MongoDB collections created on connect
8. 66+ MongoDB indexes functional
9. registerMemoryRuntime() called exactly once at startup
10. Plugin bridge returns MongoDB manager to all callers
11. sessionId guards in compact.ts + attempt.ts intact
12. buildMongoDBBridgeSection in system-prompt.ts intact
13. 2 excluded paths absent (sqlite-vec-smoke.mjs, memory-lancedb.ts)
14. memory-lancedb export NOT in package.json
15. pnpm build exits 0
16. pnpm test passes at baseline
17. 2-parent merge commit verified
18. No `plugins.slots.memory` overriding MongoDB
    19-22. (Extended based on Wave 7 specific changes)

## Data Flow

### Upstream Memory Commits Classification

| Category                                                                                                  | Count | Action                                         |
| --------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| Non-MongoDB backend-specific (QMD, SQLite, LanceDB, Qdrant, Chroma, Redis, Pinecone, Weaviate, ANY other) | 52+   | Auto-ignore (dead code accepted, NEVER adopt)  |
| Dreaming system (memory-core plugin)                                                                      | ~25   | Accept as dead code, evaluate concepts         |
| Wiki system (memory-wiki plugin)                                                                          | ~10   | Accept as dead code, evaluate concepts         |
| Plugin infrastructure refactors                                                                           | ~20   | Accept (our bridge wires through)              |
| Bedrock embedding provider                                                                                | ~5    | Accept as dead code (we use Voyage via mongot) |
| Lint/test cleanup                                                                                         | ~19   | Accept broadly                                 |

### Dreaming Concept → MongoDB Mapping (Evaluation Only)

| Upstream Concept            | MongoDB Equivalent                         | Notes                                         |
| --------------------------- | ------------------------------------------ | --------------------------------------------- |
| Daily ingestion sweep       | Episode materialization with daily trigger | Already have `checkAutoEpisodeTriggers`       |
| REM preview (dream preview) | Episode draft with `status: "draft"`       | Extend existing episode status lifecycle      |
| Weighted recall promotion   | Importance scoring on events/episodes      | Already identified in gap analysis            |
| Aging controls              | TTL indexes + importance decay             | Already have TTL on caches                    |
| Diary surface               | New structured memory type `"diary"`       | Maps to existing structured_memory collection |

### Wiki Concept → MongoDB Mapping (Evaluation Only)

| Upstream Concept     | MongoDB Equivalent                      | Notes                               |
| -------------------- | --------------------------------------- | ----------------------------------- |
| Wiki corpus          | KB entries collection (already exists)  | May need `source: "wiki"` category  |
| Prompt supplement    | Prompt-section.ts buildMemorySection    | Already have MongoDB bridge section |
| Memory search bridge | Hybrid retrieval KB lane                | Already wired                       |
| LLM wiki generation  | Episode summary → KB promotion pipeline | New extraction path concept         |

## Error Handling

| Scenario                             | Response                                                         |
| ------------------------------------ | ---------------------------------------------------------------- |
| >500 merge conflicts                 | Continue single merge — classify by tier, resolve systematically |
| Protected seam change breaks MongoDB | KEEP OURS, document delta                                        |
| Plugin bridge fails to register      | Investigate memory-state.ts changes, verify last-write-wins      |
| Build failure after merge            | Identify import path breakage, fix upstream references           |
| Test regression from upstream        | Classify via clawmongo-test-triage skill                         |
| Excluded path re-appears             | Delete immediately, update exclusion list                        |

## Testing Strategy

| Gate           | Command                                     | Acceptance                      |
| -------------- | ------------------------------------------- | ------------------------------- |
| Build          | `pnpm build`                                | Exit 0                          |
| Lint/Format    | `pnpm check`                                | Exit 0 or 2 (pre-existing only) |
| Unit tests     | `pnpm test`                                 | Pass at baseline                |
| MongoDB tests  | `pnpm test -- src/memory/mongodb`           | 100% pass                       |
| Search manager | `pnpm test -- src/memory/search-manager`    | 100% pass                       |
| Live e2e       | `production-readiness.e2e.test.ts`          | 104+ tests pass                 |
| 2-parent merge | `git show --pretty=format:%P HEAD \| wc -w` | = 2                             |
| Behind count   | `git rev-list --count HEAD..upstream/main`  | = 0                             |

## Skill Enforcement Policy

Every sub-agent spawned during this sync MUST:

1. Load all 5 ClawMongo skills (upstream-sync, release, test-triage, live-validation, memory-architecture)
2. Load all 7 MongoDB skills when touching database code
3. Reference `scripts/upstream-protected-paths.txt` before modifying any file
4. Use Bright Data MCP to validate approaches when skills don't cover the pattern
5. Never touch mongodb-\*.ts files without explicit user approval

## Questions Resolved

- Q: Split into sub-waves? A: No — single merge (proven pattern, only 2 seams changed)
- Q: Dreaming+Wiki depth? A: Document only — evaluate concepts, defer implementation
- Q: Out of scope? A: Do everything needed for clean sync; skills mandatory on all agents
- Q: Approach? A: HYBRID-Continuous (Option A) — follow Wave 6 pattern exactly
