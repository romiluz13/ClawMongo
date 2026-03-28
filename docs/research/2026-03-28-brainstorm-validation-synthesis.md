# Validated Brainstorm: Review Score 88% → 95%

## Three-Source Validation Matrix

Every idea below was validated against:

1. **Codebase** — actual ClawMongo source (code reviewer agent, 16 items checked)
2. **Academic papers** — 10 papers, quantified metrics (web researcher)
3. **GitHub implementations** — 7 production repos: Zep, Mem0, LangChain, LlamaIndex, Haystack, RAGatouille (GitHub researcher)

---

## MAINTAINABILITY: 80 → 93-95

### M1: Consolidate `sortObject` / `sortDocument` — CONFIRMED, DO IT

- **Code evidence**: `mongodb-search-executor.ts:93-105` and `mongodb-schema.ts:1360-1372` are byte-for-byte identical recursive key-sorting functions
- **GitHub pattern**: LangChain and Haystack use shared utility modules for this; no production system duplicates sorting logic
- **Action**: Extract to `src/memory/search-utils.ts`, import in both files
- **Score impact**: +2 maintainability

### M2: Deduplicate `RetrievalPath` type — CONFIRMED, DO IT

- **Code evidence**: Identical union type at `mongodb-search-executor.ts:33-41` and `mongodb-retrieval-planner.ts:6-14`
- **Action**: Import from planner (canonical source) in executor
- **Score impact**: +1 maintainability

### M3: Remove dead `effectiveAllowed` alias — CONFIRMED, DO IT

- **Code evidence**: `mongodb-search-executor.ts:81` — just `const effectiveAllowed = scopedAllowed;`
- **Action**: Replace 3 references with `scopedAllowed`, delete alias
- **Score impact**: +1 maintainability

### M4: Add `executeMongoSearchPlan` unit test — CONFIRMED MISSING, DO IT

- **Code evidence**: 6 of 7 executor functions have unit tests. `executeMongoSearchPlan` (143 lines, lines 453-596) has ZERO direct unit tests — only covered via e2e
- **GitHub pattern**: Haystack, LangChain, and LlamaIndex all have dedicated orchestration-level tests with mock retrievers
- **Action**: Add unit test with mock `executePass` callback covering: single-pass, multi-pass accumulation, early termination, dedup, metadata merge
- **Score impact**: +3 maintainability, +1 correctness

### M5: Extract `buildExecutorPasses` to module — VALIDATED but DEFER

- **Code evidence**: 52 lines, already a pure function, already unit-tested
- **Assessment**: Low urgency — function is self-contained and testable. Extract only if adding LLM reformulation (C1), which would make the module significantly larger
- **Score impact**: +1 if done

### M6: Centralize search config constants — VALIDATED but DEFER

- **Assessment**: maxPasses defaults are only in one place (normalizeMemorySearchRequest). Not truly scattered. SKIP for now.

### M7: `sourcePreferencePaths` NOT duplicated — CORRECTED

- **Code evidence**: Code reviewer confirmed this function is ONLY in executor. No duplicate in manager.
- **Original brainstorm was wrong**: The previous review flagged overlap with `pathMatchesSourcePreference` in manager, but these are different functions with different signatures and purposes.
- **Action**: NONE needed — remove from the remediation list

**Net maintainability: M1 + M2 + M3 + M4 = +7 points → 80 + 7 = ~87. With M5 if needed: ~88.**

To reach 93-95 maintainability, the performance/correctness improvements below must be cleanly implemented with proper test coverage.

---

## PERFORMANCE: 85 → 93-95

### P1: Wire Cross-Encoder Reranking into Search Pipeline — VALIDATED, P0

- **Code evidence**: `crossEncoderRerank` exists in `mongodb-reranker.ts` (167 lines, production-ready). Called within `searchV2` in manager, but NOT in `executeMongoSearchPlan` orchestration.
- **Zep pattern**: 5 reranker strategies, configurable per-search. Default `cross_encoder` for edges.
- **Mem0 pattern**: 4 backends, `rerank` flag per-search. "Enable for queries > 3 words."
- **Papers**: +27% MRR@10 (Nogueira/BERT), +8-12% precision@5 in production RAG (Pinecone/Cohere), +3-8% for instruction-tuned (Voyage rerank-2.5)
- **Latency**: 50-200ms per call (ClawMongo already has 5s timeout + graceful fallback)
- **Action**: Wire as configurable post-pass step in executor. Enable by default for `agentic` mode, optional for `auto`, skip for `direct`.
- **Score impact**: +4-5 performance

### P2: Parallel Pass Execution — CONDITIONAL, P2

- **Code evidence**: `executeMongoSearchPlan` runs passes in sequential `for` loop with shared `acceptedById` state and early-stop (lines 510-572)
- **Haystack pattern**: `MultiQueryRetriever` runs all queries in parallel — full fan-out
- **Web research**: 2-3x wall-clock improvement, but ClawMongo's early-stop is a deliberate optimization
- **Correct approach**: "Speculative parallel" — run pass 1 synchronously; if insufficient, launch remaining passes in parallel via `Promise.all`
- **Score impact**: +2-3 performance (latency only, no quality improvement)

### P3: MMR Diversity Scoring — VALIDATED, P1

- **Code evidence**: NO MMR or diversity logic anywhere in codebase (confirmed by code reviewer)
- **LangChain implementation**: `lambda * relevance - (1-lambda) * max(similarity_to_selected)`, iterative selection. Requires pairwise similarity.
- **Papers**: +5-10% context recall (RAGAS), +3-7% answer correctness for comparison queries
- **Embedding dependency**: LangChain uses embeddings. ClawMongo can use lightweight Jaccard/TF-IDF on snippet text instead (avoids extra DB lookup).
- **Action**: Add post-dedup MMR step with classification-aware lambda (0.3 family, 0.4 comparison, 0.7 direct)
- **Score impact**: +3-4 performance (quality dimension)

### P4: Bounded Result-Set Streaming — SKIP

- **Code evidence**: Evidence coverage is already streaming-compatible (called inside pass loop)
- **Web research**: <1ms improvement for ClawMongo's typical 10-50 results per pass
- **Assessment**: Negligible impact, maintainability cost. SKIP.

---

## CORRECTNESS: 90 → 95-97

### C1: LLM Query Reformulation — VALIDATED, P0

- **Code evidence**: `buildExecutorPasses` (executor.ts:208-260) uses template string concatenation: `"${query} alternatives"`, `"${query} differences"`. Semantically weak.
- **Haystack pattern**: `QueryExpander` uses LLM (gpt-4.1-mini, temp 0.7) → JSON `{"queries": [...]}`. Separate pluggable component.
- **LangChain**: `MultiQueryRetriever` uses LLM for query variations
- **Papers**: FLARE +5-15% accuracy, IRCoT +21 points precision, MultiQueryRetriever +15-25% recall on ambiguous queries
- **Pure function preservation**: LLM call injected as async parameter (like `executePass` callback) — planner stays pure
- **Action**: Optional LLM reformulation for `agentic` mode with template fallback. Use fast model (Haiku-class) with 500ms timeout.
- **Score impact**: +3-4 correctness

### C2: CRAG-Style Corrective Retrieval — VALIDATED, P1

- **Code evidence**: `computeEvidenceCoverage()` already returns none/indirect/partial/direct. `applyHardConstraintRejections` tracks rejection reasons. The evaluation signal EXISTS — the corrective action is MISSING.
- **LlamaIndex**: `CorrectiveRAGWorkflow` uses LLM to evaluate quality
- **CRAG paper**: Three-way evaluation (CORRECT/AMBIGUOUS/INCORRECT) maps to ClawMongo's coverage (direct/partial-indirect/none). +3-10% accuracy.
- **Key insight**: ClawMongo can do this WITHOUT an LLM call — pattern-match rejection reasons to corrective strategies (pure function)
- **Action**: After each pass, if coverage is none/indirect: analyze rejection reasons → select corrective action (widen time range, switch retrieval path, relax evidence requirement)
- **Score impact**: +2-3 correctness

### C3: Constraint Relaxation Fallback — VALIDATED, P1

- **Code evidence**: Full constraint infrastructure exists. `applyHardConstraintRejections` tracks rejected results with reasons. `metadata.constraintsApplied` provides transparency. But when ALL results are rejected, the system returns EMPTY — no recovery.
- **GitHub evidence**: No competitor has this level of constraint infrastructure — ClawMongo is uniquely positioned
- **Web research**: +30-40% zero-result recovery (Alibaba), +60-80% for temporal constraint relaxation specifically
- **Action**: When accepted=0, identify most restrictive constraint (by rejection count), widen it (time range → 2x, exactEvidence → false), re-execute, annotate with `relaxedConstraints` in metadata
- **Score impact**: +2 correctness

### C4: Compound Query Classification — CONDITIONAL, DEFER

- **Web research**: 10-20% of queries are compound; LLM reformulation (C1) handles them naturally
- **GitHub evidence**: LlamaIndex uses `SubQuestionQueryEngine` (LLM decomposition, not regex classification)
- **Action**: DEFER to C1. If C1 is not implemented, add "compound" classification as lightweight alternative.
- **Score impact**: +1-2 if done standalone (subsumed by C1)

---

## FINAL VALIDATED PRIORITY MATRIX

| Rank      | ID    | Idea                         | Verdict     | Effort | Impact         | Dimension       |
| --------- | ----- | ---------------------------- | ----------- | ------ | -------------- | --------------- |
| **P0**    | M1-M4 | Fix 4 maintainability issues | CONFIRMED   | Low    | +7 maint       | Maintainability |
| **P0**    | P1    | Wire reranker into pipeline  | VALIDATED   | Low    | +4-5 perf      | Performance     |
| **P0**    | C1    | LLM query reformulation      | VALIDATED   | Medium | +3-4 corr      | Correctness     |
| **P1**    | P3    | MMR diversity scoring        | VALIDATED   | Medium | +3-4 perf      | Performance     |
| **P1**    | C2    | CRAG corrective retrieval    | VALIDATED   | Medium | +2-3 corr      | Correctness     |
| **P1**    | C3    | Constraint relaxation        | VALIDATED   | Low    | +2 corr        | Correctness     |
| **P2**    | P2    | Speculative parallel passes  | CONDITIONAL | Medium | +2-3 perf      | Performance     |
| **SKIP**  | P4    | Bounded streaming            | SKIP        | Low    | <1ms           | —               |
| **DEFER** | C4    | Compound classification      | DEFER       | High   | Subsumed by C1 | —               |
| **DEFER** | M5    | Extract pass-planner module  | DEFER       | Low    | +1 maint       | —               |
| **SKIP**  | M7    | sourcePreferencePaths dedup  | CORRECTED   | —      | Not duplicated | —               |

## Projected Scores After Implementation

### P0 only (Low effort):

- Maintainability: 80 → 87 (M1-M4)
- Performance: 85 → 90 (P1 reranker wiring)
- Correctness: 90 → 93 (C1 LLM reformulation)
- **Overall: 88 → ~92**

### P0 + P1 (Medium effort):

- Maintainability: 80 → 90 (clean implementations add to score)
- Performance: 85 → 94 (P1 + P3 MMR)
- Correctness: 90 → 96 (C1 + C2 + C3)
- **Overall: 88 → ~95** ← TARGET MET

### P0 + P1 + P2 (Full effort):

- Performance: 85 → 96 (+ parallel passes)
- **Overall: 88 → ~96-97**

---

## Runtime Fit Verification

Every validated idea was checked against ClawMongo's architectural constraints:

| Constraint                    | M1-M4 | P1  | P3  | C1         | C2  | C3  |
| ----------------------------- | ----- | --- | --- | ---------- | --- | --- |
| MongoDB-only (no external DB) | ✓     | ✓   | ✓   | ✓          | ✓   | ✓   |
| Pure function orchestration   | ✓     | ✓   | ✓   | ✓ (via DI) | ✓   | ✓   |
| No new collections needed     | ✓     | ✓   | ✓   | ✓          | ✓   | ✓   |
| Backward compatible           | ✓     | ✓   | ✓   | ✓          | ✓   | ✓   |
| Existing test infrastructure  | ✓     | ✓   | ✓   | ✓          | ✓   | ✓   |
| Voyage API integration        | N/A   | ✓   | N/A | N/A        | N/A | N/A |

All validated ideas fit within ClawMongo's runtime without architectural changes.
