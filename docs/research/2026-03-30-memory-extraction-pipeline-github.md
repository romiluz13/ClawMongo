# Memory Extraction Pipeline Research: GitHub Repository Analysis

**Date:** 2026-03-30
**Purpose:** Research event-driven extraction pipelines across 6 agentic AI memory systems to inform ClawMongo's sync extraction design (write event -> extract facts/entities/episodes).

---

## Executive Summary

Across 6 repositories (Mem0, Zep/Graphiti, Letta, LangMem, Cognee, Morphik), a clear pattern emerges:

1. **Every system uses LLM-based extraction in the write path** -- none do rule-based entity extraction in production. This is the universal approach.
2. **Sync vs Async split is consistent:** Mem0 and LangMem run extraction synchronously. Zep/Graphiti and Cognee run extraction asynchronously (background queue recommended). Letta is unique -- the agent itself decides when to write to archival memory via tool calls.
3. **Extraction failure never blocks the raw write.** Every system stores the raw message first, extraction second.
4. **Episode boundaries are NOT auto-detected from content.** They are either session-based (Zep), explicitly triggered (Letta compaction threshold), or pipeline-defined (Cognee batches).

**Key insight for ClawMongo:** Our plan to do rule-based extraction in the hot path is unique and potentially advantageous -- no competitor does this. All use LLM. If we wire sync rule-based extraction that cannot fail, we get extraction at zero latency cost that others pay 2-10s for.

---

## 1. Mem0 (mem0ai/mem0)

### Architecture: Synchronous LLM extraction in the `add()` call

**Key files:**

- `mem0/memory/main.py` -- `add()` method (line ~350-600)
- `mem0/memory/utils.py` -- fact parsing utilities
- `mem0/configs/prompts.py` -- extraction prompts
- `mem0/graphs/graph_memory.py` -- graph entity extraction
- `mem0/graphs/tools.py` -- entity extraction tool definitions

### Write -> Extract Pipeline

```
add(messages) ->
  1. Parse/validate messages
  2. ThreadPoolExecutor runs TWO parallel branches:
     a. _add_to_vector_store():
        - LLM call: extract facts from conversation (json format)
        - For each fact: embed, search existing memories for conflicts
        - LLM call: decide ADD/UPDATE/DELETE for each fact vs existing
        - Write to vector store
     b. _add_to_graph():
        - LLM call: extract entities + relationships
        - Search graph DB for existing entities
        - LLM call: decide merge/add/delete
        - Write to Neo4j/Neptune/etc
  3. Return combined results
```

### Key Patterns

**Extraction is synchronous and blocking.** The `add()` call does not return until both vector and graph extraction complete. This means the caller waits for 2 LLM calls minimum.

**Two-phase extraction:** First LLM call extracts raw facts. Second LLM call decides what to do with them (ADD, UPDATE, DELETE) by comparing against existing memories. This is the "memory arbitration" pattern.

**Fact extraction prompt (FACT_RETRIEVAL_PROMPT):**

- 7 categories: preferences, personal details, plans, activities, health, professional, miscellaneous
- Returns `{"facts": ["..."]}` JSON
- Separate prompts for user memory vs agent memory extraction
- Few-shot examples included
- Custom prompts supported via `custom_fact_extraction_prompt`

**Graph extraction uses tool calling:**

```python
EXTRACT_ENTITIES_STRUCT_TOOL = {
    "type": "function",
    "function": {
        "parameters": {
            "relations": [{"source", "relationship", "destination", "source_type", "destination_type"}]
        }
    }
}
```

**Error handling:** Extraction failures are caught and logged but do NOT prevent the add from completing. Empty fact lists are valid and skip the update LLM call.

```python
except Exception as e:
    logger.error(f"Error in new_retrieved_facts: {e}")
    new_retrieved_facts = []
```

**No episode boundaries.** Mem0 has no concept of episodes. Each `add()` call independently extracts facts. No session/conversation tracking.

### Verdict for ClawMongo

- **Steal:** Two-phase extraction pattern (extract then arbitrate)
- **Steal:** Error isolation (extraction failure -> empty list, not write failure)
- **Skip:** LLM in hot path (too slow for our use case)
- **Skip:** No episode concept

---

## 2. Zep / Graphiti (getzep/zep + getzep/graphiti)

### Architecture: Async extraction via Graphiti service

**Key files:**

- `legacy/src/store/memory_ce.go` -- memory store (write path)
- `legacy/src/lib/graphiti/service_ce.go` -- Graphiti HTTP client
- `legacy/src/api/apihandlers/memory_handlers_ce.go` -- API handlers
- `graphiti_core/graphiti.py` -- `add_episode()` (line ~788-1000)
- `graphiti_core/utils/maintenance/node_operations.py` -- entity extraction
- `graphiti_core/utils/maintenance/edge_operations.py` -- fact/edge extraction
- `graphiti_core/prompts/extract_nodes.py` -- entity extraction prompts
- `graphiti_core/prompts/extract_edges.py` -- edge/fact extraction prompts

### Write -> Extract Pipeline

```
PutMemory(messages) ->
  1. Store messages to session (immediate)
  2. HTTP POST to Graphiti service /messages endpoint (async)
  3. Graphiti add_episode() runs:
     a. Retrieve previous episodes (context window)
     b. Extract entity nodes (LLM)
     c. Resolve/deduplicate nodes against existing graph
     d. Extract edges/facts between entities (LLM)
     e. Resolve/deduplicate edges
     f. Extract node attributes (LLM)
     g. Build episodic edges (node -> episode links)
     h. Optionally update communities
     i. Write all to Neo4j
  4. Return extracted nodes + edges
```

### Key Patterns

**Explicitly async and sequential.** Graphiti's docstring is clear:

> "It is recommended to run this method as a background process, such as in a queue. It's important that each episode is added sequentially and awaited before adding the next one."

```python
# Recommended usage from Graphiti docs:
@app.post("/add_episode")
async def add_episode_endpoint(episode_data):
    background_tasks.add_task(graphiti.add_episode, **episode_data.dict())
    return {"message": "Episode processing started"}
```

**Episodes are explicitly defined.** There is no auto-detection. The caller creates episodes by calling `add_episode()`. Each message becomes one episode. Episodes are linked via `NEXT_EPISODE` edges and grouped into "sagas."

**Multi-step extraction pipeline:** The extraction is a complex pipeline:

1. `extract_nodes()` -- LLM extracts entities from episode text
2. `resolve_extracted_nodes()` -- Deduplicate against existing graph nodes (hybrid search + LLM)
3. `extract_edges()` -- LLM extracts relationships/facts between resolved entities
4. Resolve edges against existing edges (find contradictions, invalidate old facts)
5. `extract_attributes_from_nodes()` -- LLM extracts structured attributes for typed entities

**Temporal validity on facts.** Every fact (edge) has `valid_at` and `invalid_at` timestamps. When new facts contradict old ones, old facts get `invalid_at` set rather than deleted. This temporal history is a core feature.

**Group-based partitioning.** All data is partitioned by `group_id` (typically session or user). This maps to ClawMongo's scope concept.

**Error handling:** Errors in Graphiti bubble up to the Zep store layer. The HTTP call to Graphiti uses status code checking. No partial extraction -- it either succeeds or the whole episode fails.

### Verdict for ClawMongo

- **Steal:** Episode -> entity extraction -> edge/fact extraction pipeline structure
- **Steal:** Temporal validity on facts (valid_at/invalid_at)
- **Steal:** Explicit sequencing requirement (episodes must be processed in order)
- **Steal:** Group-based partitioning concept (matches our scope)
- **Adapt:** Their async pattern via HTTP service; we can do async via MongoDB Change Streams or post-write hooks
- **Skip:** Neo4j-specific dedup/resolution (we use `$graphLookup`)

---

## 3. Letta / MemGPT (cpacker/MemGPT)

### Architecture: Agent-driven memory management (no extraction pipeline)

**Key files:**

- `letta/agents/letta_agent_v3.py` -- v3 agent with step() method
- `letta/services/summarizer/compact.py` -- context compaction
- `letta/services/passage_manager.py` -- archival memory passages
- `letta/services/summarizer/summarizer.py` -- summarization service

### Write -> Extract Pipeline

Letta is fundamentally different. There is NO extraction pipeline. Instead:

```
Agent step() ->
  1. LLM generates response + tool calls
  2. If LLM calls archival_memory_insert(content):
     - Content stored as a "passage" in vector DB
  3. If LLM calls core_memory_replace(label, old, new):
     - Updates in-context memory block
  4. If context window exceeds threshold:
     - compact_messages() triggers summarization
     - Old messages replaced with summary message
```

### Key Patterns

**The agent IS the extraction pipeline.** Letta gives the LLM tools to manage its own memory. The LLM decides what to remember, how to organize it, and when to store. There is no separate extraction step.

**Tool-based memory operations:**

- `archival_memory_insert(content)` -- Store to long-term vector memory
- `archival_memory_search(query)` -- Search long-term memory
- `core_memory_replace(label, old, new)` -- Update working memory blocks
- `core_memory_append(label, content)` -- Append to working memory

**Context window compaction is the trigger.** When in-context messages exceed a token threshold, `compact_messages()` runs. This uses an LLM to summarize old messages into a shorter "summary message" that replaces them. This is the closest thing to episode materialization.

```python
async def compact_messages(
    messages: List[Message],
    trigger_threshold: Optional[int] = None,  # Token limit
    compaction_settings: Optional[CompactionSettings] = None,
) -> CompactResult:
```

**No structured extraction.** Letta does not extract entities, facts, or structured data from conversations. All "extraction" is the agent deciding to call tools. The compaction creates summaries but does not produce structured data.

### Verdict for ClawMongo

- **Steal:** Token-threshold trigger for compaction/episode materialization
- **Steal:** Summary message pattern (replacing old messages with compressed summary)
- **Skip:** Agent-driven extraction (requires LLM in loop, incompatible with our rule-based approach)
- **Skip:** No entity/fact extraction pipeline to reference

---

## 4. LangMem (langchain-ai/langmem)

### Architecture: LangGraph-integrated extraction with store persistence

**Key files:**

- `src/langmem/knowledge/extraction.py` -- core extraction (MemoryManager, create_memory_store_manager)
- `src/langmem/knowledge/tools.py` -- memory tools
- `src/langmem/graphs/` -- graph-based extraction

### Write -> Extract Pipeline

```
create_memory_store_manager() returns a runnable:
  On invoke(messages, existing_memories):
    1. Load existing memories from LangGraph Store
    2. MemoryManager.ainvoke():
       a. Format conversation + existing memories as context
       b. LLM call via trustcall extractor:
          - Extract new memories (structured Pydantic models)
          - Update/patch existing memories
          - Delete contradicted memories
       c. Multi-step: LLM iterates up to max_steps until calling Done()
    3. Persist results back to LangGraph Store
    4. Return list of ExtractedMemory objects
```

### Key Patterns

**Schema-driven extraction.** LangMem uses Pydantic models to define memory structure. The LLM is guided to extract structured objects matching the schema:

```python
class Memory(BaseModel):
    content: str = Field(
        description="The memory as a well-written, standalone episode/fact/note/preference/etc."
    )
```

Custom schemas are supported -- you can define domain-specific memory types.

**Multi-step extraction loop.** The MemoryManager runs a loop where the LLM can:

- Create new memories (insert)
- Update existing memories (patch)
- Delete memories (remove)
- Call `Done()` when finished

The LLM iterates up to `max_steps` (default varies) before the loop terminates. This is expensive but thorough.

**Separate thread summarization.** `create_thread_extractor()` produces conversation summaries (title + summary) separately from memory extraction. This is analogous to episode materialization.

**Integration with LangGraph Store.** Memories are persisted via the LangGraph Store API with namespace-based organization. The `create_memory_store_manager()` auto-loads existing memories and auto-saves results.

**Rich memory instructions:** The `_MEMORY_INSTRUCTIONS` prompt is the most sophisticated of all repos:

```
1. Extract & Contextualize - facts, relationships, preferences, procedures
2. Compare & Update - novel vs existing, consolidate redundant
3. Synthesize & Reason - deduction, induction, abduction
```

### Verdict for ClawMongo

- **Steal:** Schema-driven extraction (define memory types as schemas)
- **Steal:** Separation of thread summarization vs memory extraction
- **Steal:** The rich extraction instruction pattern (3-phase: extract, compare, synthesize)
- **Skip:** Multi-step LLM loop (too expensive for hot path)
- **Skip:** LangGraph Store dependency

---

## 5. Cognee (topoteretes/cognee)

### Architecture: Pipeline-based batch extraction

**Key files:**

- `cognee/api/v1/cognify/cognify.py` -- main pipeline orchestrator
- `cognee/tasks/graph/extract_graph_from_data.py` -- graph extraction task
- `cognee/tasks/temporal_graph/extract_events_and_entities.py` -- temporal extraction
- `cognee/tasks/temporal_graph/extract_knowledge_graph_from_events.py` -- event graph extraction
- `cognee/tasks/storage/add_data_points.py` -- storage task

### Write -> Extract Pipeline

Cognee uses a two-phase approach: `add()` stores raw data, `cognify()` runs extraction:

```
cognee.add(data) ->
  Store raw documents/text (no extraction)

cognee.cognify(datasets) ->
  Pipeline of Task objects:
    1. classify_documents -- Identify document types
    2. extract_chunks_from_documents -- Chunk text (TextChunker)
    3. extract_graph_from_data -- LLM extracts KnowledgeGraph (nodes + edges)
    4. summarize_text -- LLM generates summaries
    5. add_data_points -- Store to vector DB + graph DB
```

For temporal data, a separate pipeline exists:

```
temporal_cognify:
    1. classify_documents
    2. extract_chunks_from_documents
    3. extract_events_and_timestamps -- Extract temporal events
    4. extract_knowledge_graph_from_events -- Build graph from events
    5. add_data_points
```

### Key Patterns

**Explicit separation of write and extraction.** `add()` and `cognify()` are separate API calls. This is the cleanest separation of any system reviewed. Extraction never runs in the write path.

**Task-based pipeline composition.** Each extraction step is a `Task` object. The pipeline is a list of tasks executed sequentially. This makes it easy to customize:

```python
default_tasks = [
    Task(classify_documents),
    Task(extract_chunks_from_documents, max_chunk_size=chunk_size),
    Task(extract_graph_from_data, graph_model=graph_model, config=config),
    Task(summarize_text, task_config={"batch_size": chunks_per_batch}),
    Task(add_data_points, embed_triplets=embed_triplets),
    Task(extract_dlt_fk_edges),
]
```

**Custom graph models.** Like LangMem, Cognee supports custom Pydantic models for the knowledge graph structure. The default `KnowledgeGraph` model has generic nodes and edges, but you can define domain-specific models.

**Batch processing with configurable concurrency.** `extract_graph_from_data` uses `asyncio.gather` to process chunks in parallel:

```python
chunk_graphs = await asyncio.gather(*[
    extract_content_graph(chunk.text, graph_model, custom_prompt=custom_prompt)
    for chunk in non_dlt_chunks
])
```

**Provenance tracking.** Every extracted data point gets `source_pipeline` and `source_task` stamped:

```python
def _stamp_provenance_deep(data, pipeline_name, task_name):
    if isinstance(data, DataPoint):
        if data.source_pipeline is None:
            data.source_pipeline = pipeline_name
        if data.source_task is None:
            data.source_task = task_name
```

**Background execution supported:**

```python
run_info = await cognee.cognify(
    datasets=["large_corpus"],
    run_in_background=True
)
```

### Verdict for ClawMongo

- **Steal:** Task-based pipeline composition (composable extraction steps)
- **Steal:** Provenance tracking on extracted data (source_pipeline, source_task)
- **Steal:** Background execution with run tracking
- **Steal:** Separation of temporal extraction pipeline from standard extraction
- **Adapt:** Their add/cognify split maps to our event write / projection pattern
- **Skip:** Batch-only processing (we need per-event triggers)

---

## 6. Morphik (morphik-org/morphik-core)

### Architecture: Document-oriented, not conversation-oriented

Morphik focuses on document ingestion and knowledge graph extraction from documents, not conversations. After reviewing the codebase, the extraction pipeline is document-processing focused (chunking, parsing, embedding) rather than conversation memory extraction. The `core/services` directory contains document processing, embedding, and completion services but no conversation-specific extraction patterns.

**Not directly applicable to ClawMongo's conversation memory use case.** Morphik's patterns are more relevant for document/knowledge base ingestion than agent memory extraction.

---

## Cross-Cutting Analysis

### Sync vs Async Comparison

| System           | Extraction Timing       | Write Blocked? | Latency Added                  |
| ---------------- | ----------------------- | -------------- | ------------------------------ |
| **Mem0**         | Sync (in add())         | YES            | 2-10s (2+ LLM calls)           |
| **Zep/Graphiti** | Async (background)      | NO             | 0 (message stored immediately) |
| **Letta**        | Agent-driven            | N/A            | Agent decides when to extract  |
| **LangMem**      | Sync (in invoke())      | YES            | 2-15s (multi-step LLM)         |
| **Cognee**       | Separate pipeline       | NO             | 0 (add() stores raw only)      |
| **Morphik**      | N/A (document pipeline) | N/A            | N/A                            |

### Extraction Approaches

| System           | Rule-Based? | LLM-Based?              | Entity Types         | Fact Types           |
| ---------------- | ----------- | ----------------------- | -------------------- | -------------------- |
| **Mem0**         | No          | Yes (all extraction)    | Via LLM tool call    | Free-text facts      |
| **Zep/Graphiti** | No          | Yes (extract + resolve) | Dynamic + typed      | Edges with validity  |
| **Letta**        | No          | Agent decides           | N/A                  | N/A                  |
| **LangMem**      | No          | Yes (schema-driven)     | Pydantic models      | Pydantic models      |
| **Cognee**       | No          | Yes (graph model)       | KnowledgeGraph nodes | KnowledgeGraph edges |

### Error Handling Patterns

| System           | Extraction Failure Impact                             |
| ---------------- | ----------------------------------------------------- |
| **Mem0**         | Empty fact list, write continues                      |
| **Zep/Graphiti** | Episode fails, raw message already stored             |
| **Letta**        | Tool call fails, agent retries or skips               |
| **LangMem**      | Extraction returns empty, existing memories preserved |
| **Cognee**       | Pipeline task fails, earlier tasks preserved          |

### Episode Boundary Detection

| System           | How episodes are defined                                   |
| ---------------- | ---------------------------------------------------------- |
| **Mem0**         | No episodes -- each add() is independent                   |
| **Zep/Graphiti** | Explicit -- caller creates episodes via add_episode()      |
| **Letta**        | Token threshold -- compaction triggers when context full   |
| **LangMem**      | Thread-level -- create_thread_extractor() per conversation |
| **Cognee**       | Document-level -- each document/chunk is a unit            |

---

## Recommendations for ClawMongo

### What to Build

Based on this research, here is the recommended extraction pipeline for ClawMongo:

#### 1. Two-Phase Write Path (Inspired by Cognee's add/cognify split)

```
writeEvent(event) ->
  Phase 1 (SYNC, rule-based, <1ms):
    - Store raw event to events collection
    - Extract structured facts via regex/rules (no LLM)
    - Check episode trigger conditions
    - Update coverage metadata
    - Return immediately

  Phase 2 (ASYNC, optional, LLM-powered):
    - If configured, queue LLM entity extraction
    - If episode trigger fired, materialize episode
    - Update graph entities/relations
```

#### 2. Rule-Based Hot Path Extraction (Unique to ClawMongo)

None of the reviewed systems do rule-based extraction. This is our competitive advantage:

```typescript
function extractFactsSync(event: MemoryEvent): ExtractedFacts {
  const facts: StructuredFact[] = [];
  const entities: Entity[] = [];

  // Pattern-based extraction (no LLM needed)
  // 1. Named entity recognition via patterns (names, dates, locations)
  // 2. Preference detection ("I prefer", "I like", "I don't")
  // 3. Intent/plan detection ("I want to", "I'm planning to")
  // 4. Relationship markers ("my wife", "my boss", "works at")

  return { facts, entities, episodeTrigger: shouldTriggerEpisode(event) };
}
```

#### 3. Episode Trigger Logic (Inspired by Letta's threshold + Zep's explicit)

```typescript
function shouldTriggerEpisode(event: MemoryEvent, context: SessionContext): boolean {
  // Token threshold (like Letta)
  if (context.sessionTokenCount > config.episodeTokenThreshold) return true;

  // Time gap (like Zep's session-based)
  if (event.timestamp - context.lastEventTimestamp > config.episodeTimeGap) return true;

  // Event count (simple rule)
  if (context.sessionEventCount >= config.episodeEventLimit) return true;

  return false;
}
```

#### 4. Error Isolation (Universal pattern -- all repos do this)

```typescript
async function writeEventAndProject(event: MemoryEvent): Promise<WriteResult> {
  // Raw write MUST succeed
  const writeResult = await events.insertOne(event);

  // Extraction MUST NOT block or fail the write
  try {
    const extracted = extractFactsSync(event);
    await applyExtractions(extracted);
  } catch (err) {
    log.warn("Extraction failed, event stored without projections", {
      err,
      eventId: writeResult.insertedId,
    });
    // Queue for retry
    await extractionRetryQueue.enqueue(writeResult.insertedId);
  }

  return writeResult;
}
```

#### 5. Provenance Tracking (Inspired by Cognee)

Every extracted fact/entity should record:

- `sourceEventId` -- Which event triggered extraction
- `extractionMethod` -- "rule_based" | "llm_entity" | "llm_fact"
- `extractedAt` -- Timestamp
- `confidence` -- 0-1 (rules = 1.0, LLM = model confidence)

#### 6. Temporal Validity (Inspired by Zep/Graphiti)

Facts should have `validFrom` and `invalidAt` fields. When a new fact contradicts an existing one, set `invalidAt` on the old fact rather than deleting it. This preserves history for episode materialization.

### What NOT to Build

- **LLM in hot path** -- Every system that does this (Mem0, LangMem) adds 2-15s latency. Keep it async/optional.
- **Agent-driven extraction** (Letta pattern) -- Requires LLM in the loop. Not compatible with our rule-based approach.
- **Multi-step extraction loops** (LangMem) -- Too expensive for per-event processing.
- **Separate extraction service** (Zep -> Graphiti HTTP) -- Unnecessary complexity. MongoDB Change Streams or post-write hooks are simpler.

### Priority Order

1. **Rule-based fact extraction** (unique advantage, zero latency cost)
2. **Error isolation** (universal best practice)
3. **Episode trigger logic** (enables materialization)
4. **Provenance tracking** (enables debugging and audit)
5. **Temporal validity on facts** (enables contradiction handling)
6. **Optional async LLM extraction** (future enhancement)
