# MASTER STEAL LIST: What ClawMongo Should Steal from 5 Memory Repos

**Date:** 2026-03-23
**Sources analyzed:** claude-mem, MemOS, mengram, Ori-Mnemos, mem0
**ClawMongo state:** MongoDB-native, 16+ collections, hybrid retrieval, semantic cache, time series telemetry, episode materialization, TypeScript

---

## SECTION 1: PARADIGM SHIFTS

These are not features. They change how ClawMongo fundamentally operates.

### 1A. Retrieval as Navigation, Not Search (Ori-Mnemos RMH)

Every retrieval currently terminates after scoring and returning results. The shift: retrieval is a **graph navigation loop** where unresolved queries recurse into sub-question decomposition, every retrieval reshapes the graph (co-occurrence edges, Q-values), and the system learns which retrieval paths work for which query types via a contextual bandit (LinUCB).

This transforms ClawMongo from a static retrieval system into one that improves with use. The Q-value reward signals (+1.0 forward citation, +0.5 note updated, -0.15 dead-end penalty) are directly applicable to ClawMongo's episode + chunk retrieval. The 8-dimensional query features map cleanly onto ClawMongo's existing retrieval path planner.

**What this means concretely:** the retrieval planner stops being a keyword heuristic and becomes a learning ranker. The 6 retrieval paths become the "stages" the bandit optimizes over.

### 1B. LLM-Driven Memory Mutation (mem0 ADD/UPDATE/DELETE/NONE)

ClawMongo currently writes memory in append-only fashion. The shift: for every inbound message, extract new facts, search existing memory, and have an LLM decide ADD/UPDATE/DELETE/NONE **per fact**. UUID hallucination is mitigated by mapping real MongoDB `_id`s to indices, letting the LLM work on indices, then remapping.

This changes memory from a ledger into a living knowledge base. Combined with ClawMongo's existing graph (entities, relations), this enables true semantic deduplication and contradiction resolution — not just storing everything and hoping retrieval finds the right version.

---

## SECTION 2: CRITICAL GAPS

Capabilities ClawMongo is entirely missing. Ranked by ROI.

### 2A. Procedural Memory with Evolution Tracking (mengram, mem0)

**What:** Store agent workflows as documents with `trigger`, `steps[]`, `success_count`, `fail_count`, `last_success_at`, `last_failure_at`, `evolution_history[]`. Failures trigger LLM root-cause analysis → new version. Three similar positive episodes → auto-create procedure (confidence ≥0.6).
**Why critical:** ClawMongo stores _what happened_ (episodes) but not _how to do things_ (procedures). Agents repeatedly rediscover workflows.
**Implementation:** New collection `procedures`. Fields: `trigger`, `steps[]`, `confidence`, `success_count`, `fail_count`, `evolution_history[]`, `failed_at_step`. Add `recordProcedureOutcome()` + `evolveProcedure()` to mongodb-manager.
**Effort:** M

### 2B. Tiered Token-Efficient Retrieval Protocol (claude-mem 3-layer)

**What:** Search returns IDs only (~50-100 tokens). Timeline returns ordered metadata for filtered IDs. Full content fetched only for the 3-5 most relevant IDs. ~10x token reduction for agents working in large memory spaces.
**Why critical:** ClawMongo currently returns full chunk/episode content on every search hit. In sessions with 1000+ episodes, this blows the agent context window.
**Implementation:** `searchEpisodes` / `searchV2` gain a `projection` param. Add a `getEpisodesByIds(ids[], fullContent: boolean)` API. The agent calls search → filter → expand, not search-and-dump.
**Effort:** S

### 2C. ACT-R Base-Level Vitality + Decay (Ori-Mnemos)

**What:** Each memory node gets a vitality score `B_i = ln(n/(1-d)) - d*ln(L)`, sigmoid-normalized. Zones: active (≥0.6), stale (≥0.3), fading (≥0.1), archived (<0.1). Retrieval boosts vitality; time decays it.
**Why critical:** ClawMongo has no decay model. Old memories are weighted equally with recent ones at search time. Stale episodes pollute results.
**Implementation:** Add `vitalityScore` field + `lastRetrievedAt` + `retrievalCount` to episodes/chunks. Background job recomputes vitality on a schedule using the ACT-R formula. Retrieval filters/boosts by zone. MongoDB time series for vitality trend.
**Effort:** M

### 2D. Conservative Graph Deletion with LLM Arbitration (mem0)

**What:** When new facts contradict existing relations, an LLM decides DELETE only for _outdated/contradictory_ edges. Never deletes multi-destination same-type ("loves pizza" + "loves burger" → KEEP BOTH). Uses `DELETE_RELATIONS_SYSTEM_PROMPT` with few-shot examples.
**Why critical:** ClawMongo's graph currently only appends. Contradictory relations accumulate silently (user moved cities, changed jobs, updated preferences).
**Implementation:** Add `resolveRelationConflicts(agentId, newRelations[])` to mongodb-graph.ts. Calls LLM with existing + new relations, gets DELETE/KEEP decision per relation. Add audit trail to `relation_history` embedded array.
**Effort:** M

### 2E. Cognitive Profile Generation (mengram)

**What:** Single API call generates a markdown profile grouped by entity type (person | company | project | technology | concept) with facts, knowledge, relations, and procedures — formatted as a system prompt injection.
**Why critical:** ClawMongo's memory surfaces are fragmented. Agents query episodes, then entities, then structured facts separately. A unified profile is the single most useful retrieval output for long-running agents.
**Implementation:** `generateCognitiveProfile(agentId, targetEntityId?)` in mongodb-manager.ts. Aggregates across entities, relations, episodes, structured_facts with a single `$facet` pipeline. LLM formats result.
**Effort:** S (aggregation pipe) + S (LLM formatting)

### 2F. SQLite Audit Trail → MongoDB equivalent (mem0)

**What:** Every memory mutation logged: `old_value`, `new_value`, `event` (ADD/UPDATE/DELETE), `timestamp`, `actor_id`, `role`. Enables rollback, debugging, and compliance.
**Why critical:** ClawMongo has no mutation history. When memory is wrong, there is no way to understand why or revert it.
**Implementation:** `memory_mutations` collection. Write on every structured_fact + entity + relation change. TTL index for 90-day retention. Add to schema in mongodb-schema.ts.
**Effort:** S

---

## SECTION 3: ENHANCEMENTS

ClawMongo has the concept. These make it materially better.

### 3A. Hebbian Co-occurrence Edges with Ebbinghaus Decay (Ori-Mnemos)

**Current:** $graphLookup traverses explicit entity-relation edges only.
**Enhancement:** Add implicit co-occurrence edges between episodes/chunks that are retrieved together. Weight by NPMI normalization. Decay by `strength = 1 + 0.2*log(count)`, `retention = e^(-days/(30*strength))`. Per-node homeostasis (Turrigiano): scale outgoing edges to maintain target mean 0.5.
**Concrete:** New `cooccurrences` collection (or embedded array on episodes). Updated $graphLookup to include co-occurrence edges as a secondary graph layer. Dramatically improves associative recall.
**Effort:** M

### 3B. Score-Weighted RRF (Ori-Mnemos) + Seed Gap Detection (Ori-Mnemos)

**Current:** ClawMongo uses standard RRF for hybrid fusion.
**Enhancement:** `score_fused = Σ(weight_s × raw_score_s / (k + rank_s + 1))`. Incorporates raw scores into rank fusion — a document near the top of a strong-signal source outranks a document near the top of a weak-signal source.
**Also steal:** Seed selection with gap detection — stop adding seeds to PPR when similarity drops >0.15 from previous. Prevents diluting the initial retrieval signal with loosely related memories.
**Effort:** S (change 5 lines in mongodb-hybrid.ts)

### 3C. Multi-Dimensional Memory Status Lifecycle (MemOS)

**Current:** Episodes have a simple `type` field. No lifecycle states.
**Enhancement:** `status` field: `activated → resolving → archived → deleted`. `confidence` (0-100). `version` history (embedded array). Retrieval by default filters `status: "activated"`. Archived memories remain queryable. Deleted memories are tombstoned, not removed.
**Effort:** S

### 3D. Q-Value Reward Learning on Retrieval Paths (Ori-Mnemos)

**Current:** Retrieval path planner is a static keyword heuristic.
**Enhancement:** Track per-path Q-values: `Q += α(reward - Q)`, α=0.1. Reward signals: user explicitly references retrieved content (+1.0), episode is updated post-retrieval (+0.5), dead-end (no subsequent use) (-0.15). Session-end batch flush to MongoDB.
**Implementation:** `retrieval_path_stats` collection: `{ path, queryType, qValue, sampleCount, lastUpdated }`. planRetrieval reads Q-values and boosts high-performing paths for the detected query type.
**Effort:** M

### 3E. Role-Based Memory Extraction (mem0 agent vs user profiles)

**Current:** ClawMongo extracts entities from all messages uniformly.
**Enhancement:** If `agentId` is present AND assistant messages exist, use `AGENT_MEMORY_EXTRACTION_PROMPT` (captures agent capabilities, preferred patterns, tool usage) vs `USER_MEMORY_EXTRACTION_PROMPT` (captures user preferences, facts, relationships). Prevents agent hallucinating user preferences from its own responses.
**Effort:** S

### 3F. Dual-Gate Memory Filtering with Diversity Guarantee (MemOS)

**Current:** Retrieval returns top-K by score. No diversity enforcement.
**Enhancement:** Two-gate filter: (1) score threshold, (2) minimum count guarantee — if fewer than N results pass the threshold, fill to N with next-best regardless of threshold. Prevents empty result sets on low-traffic agents.
**Effort:** S

### 3G. Temporal Grounding Enforcement (mengram)

**Current:** Extracted facts are stored as-is. Dates optional.
**Enhancement:** Fact extraction prompt enforces that temporally-relevant facts MUST include dates ("attended meeting on May 7, 2023"). Facts without temporal context that _should_ have it are flagged. Improves timeline reconstruction accuracy dramatically.
**Effort:** S (prompt change only)

### 3H. Emotional Valence Tagging (mengram)

**Current:** Episodes have no affect metadata.
**Enhancement:** Tag episodes `positive | negative | neutral | mixed`. Used as retrieval boost (amplify positive outcomes for similar future contexts) and for user mood modeling. Simple classifier prompt — no new collection needed, field on episodes.
**Effort:** S

### 3I. Event-Driven Session Queue with Database-First Persistence (claude-mem)

**Current:** Session processing is polling-based.
**Enhancement:** EventEmitter per session (zero latency vs polling). Write to DB FIRST, then enqueue in-memory. If worker crashes, DB replay restores queue state. MAX_PENDING_RESTARTS=3 prevents infinite restart loops.
**Effort:** M

---

## SECTION 4: NICE-TO-HAVE

Low priority, polish items.

- **Idle timeout + orphan reaper** (claude-mem): 3-min idle → terminate session. Age-gated orphan process reaper (>30min, every 30s). Prevents zombie sessions accumulating in long-running deployments.
- **ChatGPT import** (mengram): Reconstruct main thread from branching conversation tree via DFS following first child. Useful for seeding ClawMongo from existing ChatGPT history.
- **Wikilink auto-detection** (mengram): Add `[[entity_name]]` links in facts/knowledge for cross-referencing. Low value unless a UI is built that renders them.
- **KV cache activation memory** (MemOS): Store transformer DynamicCache objects for faster inference, layer-wise merging. Only relevant if ClawMongo runs a local model. N/A for hosted API usage.
- **SSE streaming with reference extraction** (MemOS): `[refid:memoryID]` regex extraction from streaming LLM output. Adds real-time memory citation surfacing to UI. Good for the future web UI.
- **CoT query decomposition** (MemOS): LLM complexity analysis → if complex: parallel sub-question search + LLM synthesis. Superseded by Ori-Mnemos RMH paradigm shift which handles this more elegantly via recursion.
- **Piecewise linear encoding** (Ori-Mnemos): Maps vitality/temporal/importance scalars to bins for metadata embedding. Only matters if metadata is being embedded for hybrid vector+scalar search — a future optimization.

---

## SECTION 5: CLAWMONGO WINS

What ClawMongo already does better than all 5 repos.

**Event-first architecture with audit trail.** ClawMongo's events collection as canonical truth (with chunks as derived views) is architecturally superior to all 5 repos. Episode materialization from ordered events gives a verifiable lineage chain no other repo has.

**MongoDB-native deployment.** All 5 repos require at least one external system (Redis, Neo4j, Qdrant, SQLite, LanceDB, Weaviate). ClawMongo runs on a single MongoDB connection. This is a major operational advantage.

**Multi-source hybrid retrieval at scale.** ClawMongo's 6 retrieval paths (vector, lexical, graph, structured, episode, kb) with per-path try/catch and a planning layer is significantly more robust than any of the 5 repos. mem0 has concurrent vector+graph but no planner. Ori-Mnemos has a bandit but only for a single backend.

**Semantic cache with cosine fallback.** SHA256 exact + 0.95 cosine similarity cache is absent in all 5 repos. This single feature can eliminate 30-70% of LLM calls in production.

**Time series telemetry.** 22 telemetry collections tracking retrieval latency, cache hit rates, and path selection is unique. No other repo has observability at this level built in.

**TypeScript + strong typing.** All 5 repos are Python. ClawMongo's TypeScript strict-mode codebase with Zod validation on all schema boundaries is significantly more maintainable.

**Idempotent episode upsert with compound key stability.** The `{agentId, type, timeRange.start, timeRange.end}` upsert key prevents duplicate episodes across restarts. None of the Python repos handle this correctly.

---

## SECTION 6: RECOMMENDED SPRINT ORDER

### Phase 1 — Highest ROI, 1-2 weeks

These are individually deployable and have direct user-visible impact.

1. **2B: Tiered token-efficient retrieval** — S effort, 10x token reduction. Add `projection` param to search APIs + `getEpisodesByIds()`. Unblocks large-session use cases today.
2. **2E: Cognitive profile generation** — S+S effort. Single `$facet` pipeline + LLM formatting. Gives agents the "who is this user" answer in one call.
3. **3B: Score-weighted RRF + seed gap detection** — S effort, 5-line change to mongodb-hybrid.ts. Strictly better than current RRF.
4. **2F: Mutation audit trail** — S effort. `memory_mutations` collection. Unblocks debugging and compliance.
5. **3C: Memory status lifecycle** — S effort. Adds `status` + `confidence` + `version` to episodes. Enables archived/deleted states without data loss.

### Phase 2 — 2-4 weeks

These require more design but have high long-term leverage.

6. **2A: Procedural memory** — M effort. New `procedures` collection + evolution tracking. Core capability gap.
7. **2C: ACT-R vitality + decay** — M effort. `vitalityScore` + background decay job. Eliminates stale memory pollution.
8. **2D: Conservative graph deletion with LLM arbitration** — M effort. `resolveRelationConflicts()` + `relation_history`. Fixes silent contradiction accumulation.
9. **3A: Hebbian co-occurrence edges** — M effort. `cooccurrences` collection + NPMI + Ebbinghaus decay. Dramatically improves associative recall.
10. **3E + 3G + 3H: Role-based extraction + temporal grounding + emotional valence** — S each. Bundle as single "extraction quality" sprint. All prompt-level changes with minimal schema impact.

### Phase 3 — 1-2 months

Architectural shifts requiring sustained investment.

11. **1B: LLM-driven memory mutation (ADD/UPDATE/DELETE/NONE)** — XL effort. Requires UUID→index mapping, per-fact LLM arbitration, rollback integration with audit trail from Phase 1. Do this after mutation audit trail is proven in production.
12. **1A: Retrieval as navigation (RMH + Q-value learning + LinUCB bandit)** — XL effort. Requires Q-value collection, reward signal wiring through all retrieval paths, LinUCB implementation, and sufficient usage data to train. Do this after Phase 2 vitality/co-occurrence work is stable — those signals feed the reward model.
13. **3D: Q-value reward learning** — M effort, but serves as the foundation for 1A. Build this as the Phase 3 entry point before the full RMH implementation.

---

## Summary Table

| Item                             | Category       | Effort | Priority |
| -------------------------------- | -------------- | ------ | -------- |
| Tiered token-efficient retrieval | Critical Gap   | S      | P1       |
| Cognitive profile generation     | Critical Gap   | S+S    | P1       |
| Score-weighted RRF + seed gap    | Enhancement    | S      | P1       |
| Mutation audit trail             | Critical Gap   | S      | P1       |
| Memory status lifecycle          | Enhancement    | S      | P1       |
| Procedural memory + evolution    | Critical Gap   | M      | P2       |
| ACT-R vitality + decay           | Critical Gap   | M      | P2       |
| Conservative graph deletion      | Critical Gap   | M      | P2       |
| Hebbian co-occurrence edges      | Enhancement    | M      | P2       |
| Role-based extraction            | Enhancement    | S      | P2       |
| Temporal grounding enforcement   | Enhancement    | S      | P2       |
| Emotional valence tagging        | Enhancement    | S      | P2       |
| Q-value reward learning          | Enhancement    | M      | P3 entry |
| LLM-driven memory mutation       | Paradigm Shift | XL     | P3       |
| Retrieval as navigation (RMH)    | Paradigm Shift | XL     | P3       |
