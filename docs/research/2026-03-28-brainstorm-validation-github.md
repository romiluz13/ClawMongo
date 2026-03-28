# Brainstorm Validation: GitHub Research — Implementation Patterns

## Execution

- Research round: 1
- Sources: GitHub code search via Octocode (7 repos)
- Repos analyzed: mem0ai/mem0, langchain-ai/langchain, getzep/zep, run-llama/llama_index, deepset-ai/haystack, AnswerDotAI/RAGatouille
- Quality: HIGH — direct code evidence from production repos

---

## 1. Cross-Encoder Reranking Pipeline Integration

### Zep (getzep/zep)

- **5 reranker strategies**: `cross_encoder`, `rrf`, `mmr`, `node_distance`, `episode_mentions`
- Configured per-search via `reranker` parameter (not always-on)
- Default: `cross_encoder` for edges, `rrf` for nodes
- Architecture: reranker is a post-retrieval step, configurable per-query type
- Benchmarked on LOCOMO evaluation harness (`benchmarks/locomo/`)

### Mem0 (mem0ai/mem0)

- **4 reranker backends**: Cohere (`rerank-english-v3.0`), HuggingFace cross-encoder, LLM-based (GPT-4o-mini scoring), Zero Entropy
- Pluggable via `BaseReranker` interface: `rerank(query, documents, top_k) -> documents`
- LLM reranker uses 0-1 scoring prompt with regex extraction, graceful 0.5 fallback
- **Optional per-search**: `rerank=True/False` flag on `.search()` method
- Guideline: "enable reranking for queries > 3 words" (conditional activation)

### ClawMongo Fit Assessment

ClawMongo's `mongodb-reranker.ts` is architecturally aligned with both Zep and Mem0:

- Same pattern: optional post-retrieval step with configurable activation
- ClawMongo's three-bucket split (candidates/overflow/below) is more sophisticated than Mem0's simple top-k slicing
- **Gap confirmed**: reranker exists but is not wired as a standard step in `executeMongoSearchPlan` — it's only called within `searchV2` in the manager

---

## 2. MMR (Maximal Marginal Relevance) Diversity

### LangChain (langchain-ai/langchain)

- **Canonical implementation**: `libs/core/langchain_core/vectorstores/utils.py`
- Algorithm (lines 127-158):
  ```python
  # Start with most similar to query
  most_similar = argmax(similarity_to_query)
  # Iteratively add: lambda * relevance - (1-lambda) * redundancy
  while len(idxs) < k:
      for each candidate:
          score = lambda_mult * query_score - (1 - lambda_mult) * max(similarity_to_selected)
      add best_score candidate
  ```
- `lambda_mult=0.5` default (balanced relevance/diversity)
- **Requires embeddings**: pairwise cosine similarity between candidates
- Used in `InMemoryVectorStore.max_marginal_relevance_search()` and Qdrant partner

### Zep (getzep/zep)

- MMR is one of 5 configurable rerankers
- `mmr_lambda` parameter exposed in search API
- Used for graph node results where diversity matters

### ClawMongo Fit Assessment

- **Embedding dependency**: LangChain's MMR requires embeddings for pairwise similarity. ClawMongo stores embeddings via autoEmbed but search results don't carry embeddings in the response.
- **Alternative**: Use Jaccard similarity on snippet text (no embedding needed) or TF-IDF cosine (lightweight). This avoids the extra MongoDB lookup for embeddings.
- **Integration point**: Post-dedup in `executeMongoSearchPlan`, after `acceptedById` merge
- **Lambda by classification**: family/comparison → 0.3-0.4 (more diversity), direct/temporal → 0.7 (more relevance)

---

## 3. LLM Query Reformulation

### Haystack (deepset-ai/haystack)

- **`QueryExpander` component**: `haystack/components/query/query_expander.py`
- LLM-based (defaults to `gpt-4.1-mini`, temperature 0.7)
- Prompt: "expand a given query into N queries that are semantically similar"
- JSON structured output with schema enforcement
- `include_original_query=True` by default (original + N expansions)
- **Key insight**: Separate component, not embedded in retriever — pluggable architecture
- **MultiQueryTextRetriever** / **MultiQueryEmbeddingRetriever**: run expanded queries in parallel, merge results

### Mem0 (mem0ai/mem0)

- No dedicated query expansion found — relies on vector similarity

### LangChain (langchain-ai/langchain)

- `SelfQueryRetriever`: LLM decomposes natural language into structured filters (metadata filtering, not query expansion per se)
- `MultiQueryRetriever` (separate): LLM generates multiple query variations

### ClawMongo Fit Assessment

- **Current state**: `buildExecutorPasses` uses template concatenation ("alternatives", "differences", "exact evidence")
- **Haystack pattern is directly portable**: LLM call → JSON array of queries → map to passes
- **Pure function preservation**: The LLM call can be injected as an async parameter (like the `executePass` callback in `executeMongoSearchPlan`), keeping the planner pure
- **Fallback**: Template expansion as fallback when LLM is unavailable or slow (>500ms timeout)

---

## 4. CRAG / Corrective Retrieval

### LlamaIndex (run-llama/llama_index)

- **`CorrectiveRAGWorkflow`**: `docs/examples/workflow/corrective_rag_pack.ipynb`
- Implemented as a Workflow (stateful pipeline with steps)
- Pattern: retrieve → evaluate relevance → if ambiguous/incorrect, reformulate → re-retrieve
- Uses LLM as quality evaluator (not a lightweight model)
- **Pack deprecated**: migrated from `CorrectiveRAGPack` to `CorrectiveRAGWorkflow`

### ClawMongo Fit Assessment

- ClawMongo already has the evaluation signal: `computeEvidenceCoverage()` returns none/indirect/partial/direct
- What's missing: mapping coverage + rejection reasons to corrective actions
- **No LLM needed**: Coverage evaluation is already heuristic-based. Corrective action can be pure-function: pattern-match rejection reasons → select corrective strategy
- LlamaIndex uses LLM for evaluation; ClawMongo can skip this because evidence coverage is already computed from metadata

---

## 5. Parallel Pass Execution

### Haystack (deepset-ai/haystack)

- **MultiQueryTextRetriever / MultiQueryEmbeddingRetriever**: "runs multiple queries in parallel"
- Architecture: query expander produces N queries, retriever executes all N in parallel, results merged
- This is "fan-out retrieval" — all queries are independent (no early-stop between them)

### ClawMongo Fit Assessment

- Haystack's pattern is **fan-out** (all parallel, merge after)
- ClawMongo's pattern is **sequential with early-stop** (stop if pass 1 suffices)
- **Hybrid approach validated**: Start pass 1 synchronously. If insufficient, launch remaining passes in parallel.
- This preserves the common-case optimization (direct queries stop at pass 1) while accelerating the agentic case.

---

## 6. Constraint Relaxation / Zero-Result Fallback

### No direct implementation found in the 7 repos

- Elasticsearch and MongoDB Atlas Search handle this at the database level (minimum_should_match, boosting)
- LlamaIndex's `QueryFusionRetriever` merges results from relaxed queries but doesn't explicitly relax constraints
- Zep's multiple reranker strategies provide implicit relaxation (switch from cross_encoder to rrf)

### ClawMongo Fit Assessment

- ClawMongo has unique constraint infrastructure (`applyHardConstraintRejections`, rejection tracking, constraint summaries)
- No competitor has this level of constraint visibility
- Relaxation is a natural extension: widen the most restrictive constraint (by rejection count)
- **Novel contribution**: constraint relaxation with full audit trail is not found in any analyzed system

---

## 7. Compound Query Classification

### LangChain (langchain-ai/langchain)

- `SelfQueryRetriever`: decomposes queries into structured filters using LLM
- Not truly "compound classification" — it's structured query generation

### LlamaIndex (run-llama/llama_index)

- `SubQuestionQueryEngine`: decomposes complex queries into sub-questions, each handled by a separate tool/index
- This IS compound handling, but via LLM decomposition rather than classification

### ClawMongo Fit Assessment

- Current 6-class flat taxonomy returns single classification
- LLM-based decomposition (C1) would subsume this need
- If keeping regex-based classification: add "compound" as a classification that triggers multi-faceted pass planning
- **Recommendation**: Defer to C1 (LLM reformulation handles this naturally)

---

## Summary: Competitive Landscape

| Feature                     | Zep          | Mem0       | LangChain           | LlamaIndex             | Haystack            | **ClawMongo**                      |
| --------------------------- | ------------ | ---------- | ------------------- | ---------------------- | ------------------- | ---------------------------------- |
| Cross-encoder rerank        | 5 strategies | 4 backends | Via partner         | Via node postprocessor | Via ranker          | **Built, needs wiring**            |
| MMR diversity               | Config param | No         | Core utility        | Via postprocessor      | No                  | **Missing**                        |
| LLM query expansion         | No           | No         | MultiQueryRetriever | QueryTransform         | QueryExpander       | **Template only**                  |
| Corrective retrieval        | No           | No         | No (via custom)     | CorrectiveRAGWorkflow  | No                  | **Infrastructure exists**          |
| Parallel passes             | No           | No         | EnsembleRetriever   | SubQuestionEngine      | MultiQueryRetriever | **Sequential only**                |
| Constraint relaxation       | No           | No         | No                  | No                     | No                  | **Infrastructure exists (unique)** |
| Evidence coverage tracking  | No           | No         | No                  | No                     | No                  | **Implemented (unique)**           |
| Hard constraint enforcement | No           | No         | No                  | No                     | No                  | **Implemented (unique)**           |
| Pure function orchestration | No           | No         | No                  | No                     | No                  | **Implemented (unique)**           |

**Key finding**: ClawMongo is architecturally ahead on constraint handling, evidence tracking, and pure-function orchestration. The gaps are in the areas all competitors also have gaps (CRAG, compound classification) or where ClawMongo has the infrastructure but hasn't wired it (reranking, MMR, LLM expansion).
