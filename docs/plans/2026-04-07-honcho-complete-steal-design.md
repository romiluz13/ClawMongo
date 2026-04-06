# Honcho Complete Steal — Reasoning Chain + Surprisal + Consolidation Agent Design

## Purpose

Complete the Honcho steal from 8/10 to 10/10 by implementing the 3 remaining features: provenance traversal (reasoning chains), novelty detection (surprisal scoring), and offline consolidation (Dreamer). Also incorporates upstream OpenClaw Dreaming (importance scoring, access tracking, importance decay) and Wiki (source categorization) concepts.

## Users

AI agent runtime — ClawMongo MongoDB-native memory system. Features serve the agent's ability to understand provenance of stored knowledge, identify anomalous/novel observations, and automatically consolidate raw events into durable facts.

## Success Criteria

- [ ] `memory_reasoning_chain` tool traces any fact back to original conversation events via `$graphLookup`
- [ ] `memory_novelty_scan` tool identifies most novel stored observations via Atlas Vector Search distance
- [ ] Consolidation Agent reads unconsolidated events, uses novelty + importance + reasoning chains to promote facts
- [ ] Importance scoring + access tracking (approximation pattern) integrated into retrieval ranking
- [ ] Wiki source categorization extends KB entries with `source`, `vault`, `section` fields
- [ ] Zero breaking changes to existing 24 collections
- [ ] All new code follows standalone function pattern `(db, prefix, agentId, ...)`
- [ ] agentId isolation enforced at every query hop
- [ ] ~35-45 new unit tests + ~9 e2e test cases
- [ ] `pnpm build` + `pnpm check` pass at every phase exit

## Constraints

- MongoDB-only — no external databases, no non-MongoDB backends
- Must harmonize with existing 24 collections, 67 indexes architecture
- Follow existing standalone function pattern (not class methods)
- agentId multi-tenant isolation at every query hop
- `restrictSearchWithMatch` in every `$graphLookup` (proven pattern from mongodb-graph.ts)
- sourceEventIds field already exists across 6 collection schemas — use it, don't duplicate
- Atlas Vector Search may be unavailable (graceful degradation required)
- Access tracking must use approximation pattern (batched writes, not per-request `$inc`)

## Out of Scope

- LLM compilation pipeline for wiki (deferred)
- Obsidian import support (deferred)
- Dream diary narrative surface (deferred)
- Cross-encoder reranking (separate feature)
- LLM entity extraction (separate feature)

## Approach Chosen

**Foundation-First Sequential** — Build Reasoning Chain → Surprisal → Importance/Access/Wiki → Consolidation Agent. Each feature builds on the previous. The Dreamer uses reasoning chains + novelty as inputs.

## Architecture

### New Files (3)

1. **`src/memory/mongodb-reasoning-chain.ts`** (~200 LOC) — Provenance traversal via `$lookup` + `$graphLookup`
2. **`src/memory/mongodb-novelty.ts`** (~150 LOC) — Surprisal scoring via Atlas Vector Search kNN distance
3. **`src/memory/mongodb-consolidator.ts`** (~400 LOC) — Offline consolidation pipeline (merged Honcho Dreamer + upstream promotion)

### Extended Files (4+)

- `src/memory/mongodb-schema.ts` — New fields on events/episodes, 1 new collection (consolidation_runs), 2 new indexes
- `src/memory/mongodb-reranker.ts` — Importance decay in `rerankResults()`
- `src/memory/types.ts` — New interfaces for chain, novelty, consolidation
- `src/agents/tools/memory-tool.ts` — 2 new tools: `memory_reasoning_chain`, `memory_novelty_scan`

### Collections: 24 → 25

- NEW: `consolidation_runs` — tracks offline pipeline execution state

### Indexes: 67 → ~70

- NEW: `episodes: { agentId: 1, importance: -1, accessCount: -1 }` (promotion candidates)
- NEW: `kb_entries: { agentId: 1, source: 1, vault: 1 }` (wiki queries)
- NEW: `consolidation_runs: { agentId: 1, startedAt: -1 }` (recent runs)

### Tools: +2

- `memory_reasoning_chain` — trace provenance of any fact back to original events
- `memory_novelty_scan` — find most novel/anomalous stored observations

## Components

### 1. Reasoning Chain Traversal (`mongodb-reasoning-chain.ts`)

- `traceReasoningChain(db, prefix, agentId, factId, collection, options?)` → `ReasoningChain`
- Two-hop strategy: `$lookup` from source collection → events, then `$graphLookup` within events
- `maxDepth` option (default 10, clamped ≥ 0)
- Returns ordered chain: `[original_event → derived_event → ... → fact]`
- `chainComplete: boolean` flag when max depth reached without resolution
- Handles: missing sourceEventIds (single-node), deleted events (gap markers), cross-collection hops

### 2. Surprisal Novelty Detection (`mongodb-novelty.ts`)

- `scanNovelty(db, prefix, agentId, options?)` → `NoveltyReport`
- Uses Atlas Vector Search `$vectorSearch` with `numCandidates` and kNN
- For each recent event, computes distance to K nearest neighbors
- Novelty score = average distance to kNN (high = novel)
- Returns top-N most novel events sorted by score desc
- Graceful fallback when mongot unavailable (returns empty report, no crash)

### 3. Importance + Access Tracking (schema extensions)

- New fields: `importance: number` (0-1), `accessCount: number`, `lastAccessedAt: Date` on events/episodes
- **Approximation pattern**: accumulate access counts in memory, flush on threshold (every 10 accesses OR every 60 seconds)
- `AccessTracker` class with `recordAccess(id)` and `flush()` methods
- Importance decay at query time: `effective = importance * Math.pow(0.5, daysSinceCreation / recencyHalfLifeDays)`
- `recencyHalfLifeDays` configurable (default 7)

### 4. Importance Decay in Ranking (reranker extension)

- Extend `rerankResults()` with importance-weighted scoring
- New scoring component: `importanceScore = effective_importance * IMPORTANCE_WEIGHT`
- Additive to existing episode boost + diversity scoring

### 5. Wiki Source Categorization (KB schema extension)

- New optional fields on `kb_entries`: `source: "wiki" | "reference" | "imported"`, `vault: string`, `section: string`
- New index: `{ agentId: 1, source: 1, vault: 1 }`
- Planner uses source field to boost wiki entries for wiki-related queries

### 6. Consolidation Agent (`mongodb-consolidator.ts`)

- `consolidateMemory(db, prefix, agentId, options?)` → `ConsolidationResult`
- Pipeline:
  1. Query unconsolidated events (not yet marked consolidated)
  2. Score each: novelty (surprisal) + importance (decay-adjusted) + accessCount
  3. For high-score candidates: walk reasoning chain for provenance context
  4. Deduce new structured_memory facts (rule-based, pattern-matching)
  5. Prune stale/conflicting facts via 6-dimension trust scoring
  6. Mark events as consolidated
  7. Record run in `consolidation_runs`
- Rate limiting: minimum interval between runs (configurable, default 1 hour)
- Idempotent: re-running on same events produces same results

## Data Flow

### Reasoning Chain (on-demand)

```
memory_reasoning_chain(factId, collection)
  → $match fact by factId in source collection
  → $lookup sourceEventIds → events collection
  → $graphLookup within events: connectFromField="sourceEventIds", connectToField="eventId"
  → restrictSearchWithMatch: { agentId } (multi-tenant isolation)
  → Order by creation time (oldest first = root cause → derived)
  → Return ReasoningChain { nodes[], chainComplete, collection, factId }
```

### Surprisal Novelty (on-demand)

```
memory_novelty_scan(scope?, limit?)
  → $vectorSearch on events collection (embedding field)
  → numCandidates: limit * 10, k: 5 (nearest neighbors)
  → For each event: noveltyScore = avg($meta.vectorSearchScore inverted for distance)
  → Filter by scope/timeRange
  → Return NoveltyReport { events: [{eventId, noveltyScore, content}], scannedCount }
```

### Importance + Access (passive, batched)

```
searchV2/searchDetailed → returns episode/event IDs
  → AccessTracker.recordAccess(id) (in-memory accumulator)
  → On threshold: flush → $inc accessCount, $set lastAccessedAt (batched)
  → rerankResults() reads importance + decayed effective importance
```

### Consolidation (triggered externally)

```
consolidateMemory(db, prefix, agentId)
  → getUnconsolidatedEvents() (existing function)
  → scanNovelty() for novelty scores
  → For top candidates:
    → traceReasoningChain() for provenance context
    → Pattern-match for deducible facts
    → Trust-score conflicts (existing trustScore() function)
    → Upsert to structured_memory
    → markEventsConsolidated() (existing function)
  → recordConsolidationRun()
  → Return { promoted, pruned, conflictsResolved, eventsProcessed }
```

## Error Handling

| Error Case                      | Handling                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `$graphLookup` hits max depth   | Return partial chain + `chainComplete: false`                                       |
| Missing sourceEventIds on fact  | Return single-node chain (fact only)                                                |
| Atlas Vector Search unavailable | Novelty scan returns `{ events: [], scannedCount: 0, error: "mongot_unavailable" }` |
| Consolidation finds conflicts   | Use 6-dimension trust scoring. Log conflicts. Don't crash.                          |
| Access counter flush fails      | Silently retry next cycle. Approximate counters tolerate loss.                      |
| Deleted event in chain          | Skip node, mark gap: `{ type: "gap", eventId, reason: "deleted" }`                  |
| Empty events collection         | Chain returns empty. Novelty returns empty. Consolidation no-ops.                   |

## Testing Strategy

| Module                       | Unit Tests                                                                                                                                     | E2E Tests                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `mongodb-reasoning-chain.ts` | 8-10: traversal depth, multi-hop, max depth cap, missing sourceEventIds, deleted events, agentId isolation, cross-collection, empty chain      | 2: live $graphLookup                  |
| `mongodb-novelty.ts`         | 6-8: kNN scoring, ranking, empty collection, scope filter, agentId isolation, mongot-down fallback                                             | 2: live vector search                 |
| Importance + access tracking | 4-6: field schema, approximation batching, decay formula, reranker integration                                                                 | 1: live importance-weighted retrieval |
| Wiki categorization          | 3-4: source field, vault/section, planner boost                                                                                                | 1: live wiki-filtered KB              |
| `mongodb-consolidator.ts`    | 10-12: candidate selection, novelty threshold, chain deduction, trust conflict, marking consolidated, run tracking, idempotency, rate limiting | 3: live consolidation pipeline        |
| **Total**                    | **~35-45**                                                                                                                                     | **~9**                                |

## MongoDB Schema Design Validation

Validated against MongoDB official schema design skill:

1. **$lookup + $graphLookup**: Acceptable for on-demand (non-hot-path) provenance queries. Per "Reduce Excessive $lookup" guideline.
2. **Access tracking**: Uses approximation pattern (batched writes) per MongoDB recommendation. NOT per-request $inc.
3. **New indexes (3)**: Each serves specific query pattern, no redundancy with existing indexes. Per "Avoid Unnecessary Indexes" guideline.
4. **consolidation_runs collection**: Distinct pipeline tracking data, not homogeneous with memory content. Per "Avoid Unnecessary Collections" guideline.
5. **Novelty scoring**: Computed on-demand, not pre-computed. Per "Computed Pattern" — correct for infrequent queries.
6. **Tree traversal pattern**: `$graphLookup` on sourceEventIds follows "Parent References" tree pattern — recommended by MongoDB for graph-like structures.

## Build Order (Foundation-First Sequential)

| Phase | Feature                             | Est. LOC     | Dependencies                           |
| ----- | ----------------------------------- | ------------ | -------------------------------------- |
| 0     | Commit + push existing Wave 7 work  | 0            | None                                   |
| 1     | Reasoning Chain Traversal           | ~200 + tests | sourceEventIds (exists)                |
| 2     | Surprisal Novelty Detection         | ~150 + tests | Atlas Vector Search, events collection |
| 3     | Importance + Access Tracking        | ~100 + tests | Approximation pattern                  |
| 4     | Importance Decay in Ranking         | ~30 + tests  | Phase 3 fields                         |
| 5     | Wiki Source Categorization          | ~40 + tests  | KB entries collection                  |
| 6     | Consolidation Agent (Dreamer)       | ~400 + tests | Phases 1-4                             |
| 7     | Final validation + commit + publish | 0            | All phases                             |

## Honcho Reference Mapping

| Honcho Feature                                  | ClawMongo Implementation                             | Score Recovery |
| ----------------------------------------------- | ---------------------------------------------------- | -------------- |
| `get_reasoning_chain`                           | `traceReasoningChain()` via `$graphLookup`           | +0.5           |
| Geometric surprisal (cover trees, RPTrees, LSH) | `scanNovelty()` via Atlas Vector Search kNN          | +0.5           |
| Dreamer (deduction + induction specialists)     | `consolidateMemory()` merged with upstream promotion | +1.0           |
| **Total**                                       | **8/10 → 10/10**                                     | **+2.0**       |

## Upstream Dreaming+Wiki Integration

| Upstream Concept     | MongoDB Implementation                                     | Phase |
| -------------------- | ---------------------------------------------------------- | ----- |
| Importance scoring   | `importance: number` on events/episodes                    | 3     |
| Access tracking      | `accessCount` + `lastAccessedAt` (approximation pattern)   | 3     |
| Importance decay     | `effective = importance * 0.5^(days/halfLife)` in reranker | 4     |
| Promotion pipeline   | Merged into Consolidation Agent                            | 6     |
| Wiki source category | `source: "wiki"` on kb_entries                             | 5     |
| Dream diary          | DEFERRED                                                   | -     |
| LLM compilation      | DEFERRED                                                   | -     |
| Obsidian import      | DEFERRED                                                   | -     |

## Questions Resolved

- Q: Build all 3 or defer Dreamer?
  A: Build ALL THREE. User wants complete 10/10 steal.
- Q: Which approach?
  A: Foundation-First Sequential. Chain → Surprisal → Importance → Dreamer.
- Q: Include upstream ideas?
  A: Yes — importance scoring, access tracking, wiki categorization merged in.
- Q: Access tracking overhead?
  A: Use MongoDB approximation pattern (batched writes, not per-request).
- Q: New collections?
  A: 1 new (consolidation_runs). Total: 25.
