# Memory Extraction Pipeline Research: Best Practices for Agentic AI Memory Systems

**Date:** 2026-03-30
**Sources:** Source code analysis of Mem0, LangMem, Graphiti (Zep), Letta (MemGPT); documentation review; blog posts.
**Purpose:** Inform ClawMongo's sync extraction pipeline design for wiring `writeEvent()` to populate structured facts, entities, and episodes.

---

## 1. How Production Systems Handle Post-Write Extraction

### The Spectrum of Approaches

Production agentic memory systems fall into three distinct architectural patterns for extraction:

| System             | Pattern                   | Extraction Trigger                              | LLM in Hot Path?                  | Sync/Async                                     |
| ------------------ | ------------------------- | ----------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| **Mem0**           | LLM-first extraction      | Every `add()` call                              | YES (2 LLM calls)                 | Sync (blocking)                                |
| **LangMem**        | LLM-first extraction      | Every `invoke()` call                           | YES (1-N LLM calls)               | Both (sync `.invoke()` and async `.ainvoke()`) |
| **Graphiti (Zep)** | Episode-driven extraction | Every `add_episode()`                           | YES (multiple parallel LLM calls) | Async only, recommended as background task     |
| **Letta (MemGPT)** | Agent-driven storage      | Agent explicitly calls `archival_memory_insert` | NO (agent already decided)        | Sync within agent loop                         |

### Key Finding: All Major Systems Use LLM for Extraction

Every production system examined (except Letta, which delegates to the agent itself) uses LLM calls in the extraction path. There is no widely-adopted production system doing pure rule-based extraction from conversations. The consensus is that LLM extraction quality justifies the latency cost.

However, the **placement** of that LLM call varies significantly:

- **Mem0/LangMem:** LLM extraction is synchronous and blocking -- the `add()` call does not return until extraction completes.
- **Graphiti:** Explicitly recommends running `add_episode()` as a background task: _"It is recommended to run this method as a background process, such as in a queue."_
- **Letta:** Avoids the problem entirely -- the agent itself decides what to store via explicit tool calls.

---

## 2. Detailed Architecture of Each System

### 2.1 Mem0: Two-Phase LLM Extraction (Sync)

**Pipeline:** `add()` -> validate -> **LLM Call 1** (fact extraction) -> embed each fact -> search existing memories -> **LLM Call 2** (ADD/UPDATE/DELETE decisions) -> apply mutations

**Source:** `mem0/memory/main.py` lines 403-700

**Phase 1 - Fact Extraction:**

```
messages -> LLM(FACT_RETRIEVAL_PROMPT) -> JSON {"facts": ["Name is John", "Is a software engineer"]}
```

- Uses structured JSON output from LLM
- Custom extraction prompts supported via `custom_fact_extraction_prompt`
- Two prompt variants: user memory extraction vs. agent memory extraction
- Facts are normalized after extraction

**Phase 2 - Memory Reconciliation:**

```
for each extracted fact:
    embed(fact) -> vector_search(top_5_similar) -> collect existing memories

LLM(UPDATE_MEMORY_PROMPT, existing_memories, new_facts) -> JSON {"memory": [{"event": "ADD|UPDATE|DELETE", "text": "..."}]}

for each action:
    if ADD: create_memory(text, embedding)
    if UPDATE: update_memory(id, text, embedding)
    if DELETE: delete_memory(id)
```

**Graph extraction runs in parallel:**

```python
with concurrent.futures.ThreadPoolExecutor() as executor:
    future1 = executor.submit(self._add_to_vector_store, ...)  # facts
    future2 = executor.submit(self._add_to_graph, ...)          # entities/relations
    concurrent.futures.wait([future1, future2])
```

**Error Handling:**

- Extraction failures result in empty facts list, not blocking errors
- Each memory action is wrapped in try/except -- individual action failures are logged but do not abort the batch
- Graph extraction failures are independent of vector store extraction
- `infer=False` bypasses LLM entirely, storing messages verbatim

**Key Takeaway for ClawMongo:** Mem0's error resilience is notable -- extraction failures never block the write. The parallel execution of vector store and graph pipelines is a pattern worth adopting.

### 2.2 LangMem: Multi-Step Tool-Calling Extraction

**Pipeline:** `invoke()` -> prepare messages + existing memories -> **LLM Call** (tool-calling with Memory schema) -> parse tool calls as INSERT/UPDATE/DELETE -> optionally iterate (multi-step)

**Source:** `src/langmem/knowledge/extraction.py`

**Key Design Choices:**

- Uses `trustcall.create_extractor` which leverages LLM tool-calling for structured extraction
- Supports **multi-step extraction**: the LLM can do up to `max_steps` rounds of extraction and consolidation
- After step 1, a `Done` tool is added -- the LLM signals completion by calling it
- Supports typed extraction via Pydantic schemas (e.g., `PreferenceMemory`, `UserProfile`)
- Built-in support for insert, update, and delete operations via tool metadata

**Sync vs Async:**

- Both `invoke()` (sync) and `ainvoke()` (async) are supported
- The sync version is identical in logic, just blocking

**Memory Instructions (extracted from source):**

```
1. Extract & Contextualize
   - Identify essential facts, relationships, preferences, reasoning procedures, and context
   - Caveat uncertain information with confidence levels (p(x))

2. Compare & Update
   - Attend to novel information that deviates from existing memories
   - Consolidate and compress redundant memories; maximize SNR
   - Remove incorrect or redundant memories

3. Synthesize & Reason
   - What patterns, relationships, and principles emerge?
   - Qualify conclusions with probabilistic confidence
```

**Store Integration:**

- `create_memory_store_manager()` wraps extraction + persistent store writes
- Automatically searches for relevant existing memories before extraction
- Persists results to LangGraph's `BaseStore` with namespace isolation
- Supports TTL on stored items

**Key Takeaway for ClawMongo:** LangMem's multi-step extraction with a `Done` signal is interesting but overkill for our use case. The typed Pydantic schema approach is directly applicable -- we could define `StructuredFact`, `Entity`, `Relation` schemas.

### 2.3 Graphiti (Zep): Episode-Driven Temporal Graph Construction

**Pipeline:** `add_episode()` -> create EpisodicNode -> **parallel LLM calls** (extract entities, extract edges) -> resolve/dedup entities -> resolve/dedup edges -> invalidate contradicted edges -> extract attributes -> save to graph

**Source:** `graphiti_core/graphiti.py` lines 838-1040

**This is the most architecturally sophisticated system examined.** The pipeline:

1. **Retrieve context:** Fetch last N episodes for context window
2. **Create episode node:** Persist the raw episode content
3. **Extract entities** (LLM): Using episode text + previous episodes context, extract named entities with typed classification
4. **Resolve entities:** Deduplicate against existing graph nodes (embedding similarity + LLM confirmation)
5. **Extract edges** (LLM): Extract relationships between entities
6. **Resolve edges:** Deduplicate and check for contradictions with existing edges
7. **Invalidate edges:** Mark superseded facts as invalid (temporal bi-tracking)
8. **Extract attributes** (LLM): Enrich nodes with additional properties
9. **Process episode data:** Link episode to entities via episodic edges
10. **Update communities** (optional): Cluster related entities

**Async-First with Background Task Recommendation:**

```python
# From docstring:
# It is recommended to run this method as a background process, such as in a queue.
# It's important that each episode is added sequentially and awaited before adding
# the next one.

# Example using FastAPI background tasks:
@app.post("/add_episode")
async def add_episode_endpoint(episode_data: EpisodeData):
    background_tasks.add_task(graphiti.add_episode, **episode_data.dict())
    return {"message": "Episode processing started"}
```

**Entity Extraction Prompt Design (from `extract_nodes.py`):**

- Extracts speaker from dialogue lines as first entity
- Uses typed entity classification with `entity_type_id`
- Excludes relationships and temporal info from entity extraction (handled separately in edge extraction)
- Supports custom extraction instructions
- Disambiguates pronouns (he/she/they) to named entities

**Error Handling:**

- Full try/except around the entire pipeline with span tracing
- Exceptions are recorded to tracing spans but re-raised
- **Does NOT implement partial success** -- if extraction fails, the whole episode add fails

**Key Takeaway for ClawMongo:** Graphiti's pipeline is the closest architectural match to what ClawMongo needs, but its "fail the whole episode" approach is wrong for us. We should adopt the pipeline stages but with Mem0-style fault isolation.

### 2.4 Letta (MemGPT): Agent-Driven Memory (No Extraction Pipeline)

**Source:** `letta/services/tool_executor/core_tool_executor.py`, `letta/prompts/system_prompts/memgpt_chat.py`

**Letta takes a fundamentally different approach:** The agent itself decides what to store by calling memory tools:

- `core_memory_append(key, value)` -- append to in-context memory block
- `core_memory_replace(key, old, new)` -- modify in-context memory
- `archival_memory_insert(content)` -- store to long-term (vector) storage
- `archival_memory_search(query)` -- retrieve from long-term storage

**The system prompt instructs the agent:**

> "If there is any important new information or general memories about you or the user that you would like to save, you should save that information immediately by calling function core_memory_append, core_memory_replace, or archival_memory_insert."

**Error Handling:**

```python
try:
    function_response = await function_map[function_name](agent_state, actor, **args)
    return ToolExecutionResult(status="success", func_return=function_response)
except Exception as e:
    return ToolExecutionResult(status="error", func_return=e, stderr=[...])
```

**Key Takeaway for ClawMongo:** Agent-driven memory is elegant but requires the agent loop to be aware of memory tools. Not applicable to ClawMongo's architecture where events are written externally. However, the error-as-result pattern (never throwing, always returning status) is excellent.

---

## 3. Rule-Based Entity Extraction (Without LLM in Hot Path)

Since ClawMongo wants to avoid LLM calls in the write hot path, here are practical rule-based approaches observed and recommended:

### 3.1 Pattern-Based Entity Extraction

**Approach:** Regex + NLP patterns on event content.

```
Patterns:
  "My name is {X}"           -> Entity(type=PERSON, name=X, relation=SELF)
  "I work at {X}"            -> Entity(type=ORGANIZATION, name=X, relation=EMPLOYER)
  "I live in {X}"            -> Entity(type=LOCATION, name=X, relation=RESIDENCE)
  "{X} is my {Y}"            -> Entity(type=PERSON, name=X, relation=Y)
  "I like/love/enjoy {X}"    -> StructuredFact(type=PREFERENCE, value=X, sentiment=POSITIVE)
  "I don't like/hate {X}"    -> StructuredFact(type=PREFERENCE, value=X, sentiment=NEGATIVE)
  "I am a {X}"               -> StructuredFact(type=IDENTITY, value=X)
  "Remind me to {X}"         -> StructuredFact(type=INTENT, value=X)
```

### 3.2 Heuristic Structured Fact Extraction

**Approach:** Score sentences for "fact-worthiness" based on signals:

| Signal                  | Weight | Example                         |
| ----------------------- | ------ | ------------------------------- |
| Contains proper noun    | +0.3   | "John works at MongoDB"         |
| First-person possessive | +0.4   | "My favorite color is blue"     |
| Temporal marker         | +0.2   | "Next Tuesday I have a meeting" |
| Preference verb         | +0.5   | "I prefer dark mode"            |
| Identity assertion      | +0.5   | "I'm a software engineer"       |
| Question                | -0.8   | "What's the weather?"           |
| Generic statement       | -0.5   | "The sky is blue"               |

Facts above threshold (e.g., 0.5) get extracted; below threshold are events-only.

### 3.3 Hybrid: Rule-Based Hot Path + Deferred LLM Enrichment

**This is the recommended approach for ClawMongo:**

```
Hot Path (sync, <5ms):
  writeEvent(event)
    -> rule-based fact extraction (regex patterns)
    -> rule-based entity extraction (proper nouns, pronouns)
    -> episode trigger check (event count, time window)
    -> write all to MongoDB in single transaction

Cold Path (async, deferred):
  Every N events OR on explicit trigger:
    -> LLM-based fact extraction for events not yet enriched
    -> LLM-based entity resolution and dedup
    -> Episode materialization with LLM summary
    -> Update extraction_status field on processed events
```

---

## 4. Episode Materialization Triggers

### What the Systems Do

| System       | Trigger                     | Approach                                            |
| ------------ | --------------------------- | --------------------------------------------------- |
| **Graphiti** | Every message is an episode | 1:1 mapping, episodes are the primary unit          |
| **Mem0**     | No episodes                 | Facts extracted per-message, no episode concept     |
| **LangMem**  | Thread-level summaries      | `create_thread_extractor()` summarizes full threads |
| **AWM 2.0**  | Per-interaction             | Each interaction creates an episodic memory         |

### Recommended Triggers for ClawMongo

Based on the research, **multi-signal triggering** is best:

1. **Event Count Threshold:** Every N events (configurable, default 10-20) in a session, materialize an episode.
2. **Time Window:** If >30 minutes since last episode but events exist, materialize.
3. **Semantic Shift Detection:** If embedding similarity between current event and session centroid drops below threshold (0.6), indicates topic change -- trigger episode boundary.
4. **Session End:** On explicit session close, materialize remaining events.
5. **Explicit Request:** Agent or user can request episode materialization.

**Episode Content Construction:**

```
episode = {
  sessionId,
  startTime: firstEvent.timestamp,
  endTime: lastEvent.timestamp,
  eventIds: [event1._id, event2._id, ...],
  summary: null,         // filled by cold-path LLM
  entities: [...],       // aggregated from event-level extraction
  facts: [...],          // aggregated from event-level extraction
  embedding: null,       // computed from summary or content
  status: "materialized" // or "enriched" after LLM pass
}
```

---

## 5. Making Retrieval Planners Coverage-Aware

### The Problem

ClawMongo has 8 retrieval lanes but only 3-4 receive data. The retrieval planner wastes time querying empty lanes.

### Patterns from Research

**Mem0's approach:** No retrieval planner -- always searches vector store + graph (2 lanes only).

**LangMem's approach:** `create_memory_searcher()` generates search queries from conversation context, then searches a single store with namespace filtering.

**Graphiti's approach:** Searches across entity nodes, edges, and episodes -- always all three.

### Recommended Pattern for ClawMongo

**Lane Registry with Coverage Metadata:**

```typescript
interface LaneStatus {
  lane: string;
  hasData: boolean;
  documentCount: number;
  lastUpdated: Date | null;
  estimatedLatency: number; // ms
}

// Materialized in MongoDB, updated on write
// Collection: lane_coverage
{
  agentId: "agent-123",
  userId: "user-456",
  lanes: {
    events: { count: 1523, lastUpdated: ISODate("2026-03-30"), hasData: true },
    structured_facts: { count: 47, lastUpdated: ISODate("2026-03-30"), hasData: true },
    entities: { count: 12, lastUpdated: ISODate("2026-03-29"), hasData: true },
    episodes: { count: 0, lastUpdated: null, hasData: false },
    kb: { count: 0, lastUpdated: null, hasData: false },
    procedural: { count: 0, lastUpdated: null, hasData: false },
    graph: { count: 3, lastUpdated: ISODate("2026-03-28"), hasData: true },
    active_critical: { count: 1, lastUpdated: ISODate("2026-03-30"), hasData: true }
  }
}
```

**Update Strategy:**

- Increment count and update timestamp on every successful extraction write
- Decrement count on deletes
- The retrieval planner reads this document once per query and skips lanes where `hasData: false`
- Use MongoDB's `$inc` for atomic counter updates

---

## 6. Error Resilience: Should Extraction Failures Block Event Writes?

### Consensus from Production Systems: NO

Every system examined treats extraction as **best-effort, non-blocking:**

| System       | Event Write                   | Extraction Failure                         |
| ------------ | ----------------------------- | ------------------------------------------ |
| **Mem0**     | Always succeeds               | Returns empty facts list, logs error       |
| **LangMem**  | N/A (extraction IS the write) | Propagates error to caller                 |
| **Graphiti** | Episode saved first           | Re-raises (recommended as background task) |
| **Letta**    | Always succeeds               | Returns error status in result object      |

### Recommended Pattern for ClawMongo

```
CRITICAL PRINCIPLE: The event write MUST NEVER fail due to extraction.

writeEventAndExtract(event):
  1. Write event to MongoDB                    // MUST succeed
  2. try:
       extractStructuredFacts(event)           // best-effort
     catch (e):
       log.warn("Fact extraction failed", e)
       mark event: extractionStatus = "failed"

  3. try:
       extractEntities(event)                  // best-effort
     catch (e):
       log.warn("Entity extraction failed", e)
       mark event: entityExtractionStatus = "failed"

  4. try:
       checkEpisodeTriggers(event)             // best-effort
     catch (e):
       log.warn("Episode trigger check failed", e)

  5. return { event, extractionResults }       // always returns

// Retry daemon picks up events with extractionStatus = "failed"
```

**Failed extraction tracking:**

```javascript
// On the event document itself:
{
  _id: ObjectId("..."),
  content: "...",
  extractionStatus: "pending" | "completed" | "failed" | "skipped",
  entityExtractionStatus: "pending" | "completed" | "failed" | "skipped",
  extractionAttempts: 0,
  lastExtractionError: null,
  extractedAt: null
}
```

---

## 7. MongoDB-Specific Patterns for Post-Write Derived Data

### 7.1 Aggregation Pipeline with $merge (On-Demand Materialized Views)

Best for computing derived episode data from events:

```javascript
// Materialize an episode from events
db.events.aggregate([
  {
    $match: {
      sessionId: "session-123",
      timestamp: { $gte: episodeStart, $lte: episodeEnd },
    },
  },
  { $sort: { timestamp: 1 } },
  {
    $group: {
      _id: "$sessionId",
      eventCount: { $sum: 1 },
      firstTimestamp: { $first: "$timestamp" },
      lastTimestamp: { $last: "$timestamp" },
      eventIds: { $push: "$_id" },
      allContent: { $push: "$content" },
      extractedEntities: { $push: "$entities" },
      extractedFacts: { $push: "$structuredFacts" },
    },
  },
  {
    $merge: {
      into: "episodes",
      whenMatched: "merge",
      whenNotMatched: "insert",
    },
  },
]);
```

### 7.2 Change Streams for Reactive Extraction

For truly async extraction, MongoDB Change Streams can watch for new events and trigger extraction:

```javascript
const changeStream = db.collection("events").watch([
  {
    $match: {
      operationType: "insert",
      "fullDocument.extractionStatus": "pending",
    },
  },
]);

changeStream.on("change", async (change) => {
  const event = change.fullDocument;
  try {
    await extractAndEnrich(event);
    await db.events.updateOne({ _id: event._id }, { $set: { extractionStatus: "completed" } });
  } catch (e) {
    await db.events.updateOne(
      { _id: event._id },
      { $set: { extractionStatus: "failed", lastExtractionError: e.message } },
    );
  }
});
```

**Pros:** Decoupled, resilient, naturally async.
**Cons:** Added complexity, eventual consistency, requires replica set.

### 7.3 Bulk Write for Atomic Multi-Collection Updates

For the sync path where event + facts + entities are all written together:

```javascript
const session = client.startSession();
try {
  session.startTransaction();

  // 1. Write the event
  const eventResult = await events.insertOne(event, { session });

  // 2. Write extracted facts (if any)
  if (extractedFacts.length > 0) {
    await structuredFacts.insertMany(
      extractedFacts.map((f) => ({ ...f, eventId: eventResult.insertedId })),
      { session },
    );
  }

  // 3. Upsert entities (if any)
  for (const entity of extractedEntities) {
    await entities.updateOne(
      { name: entity.name, agentId: event.agentId },
      { $set: entity, $inc: { mentionCount: 1 } },
      { upsert: true, session },
    );
  }

  // 4. Update lane coverage
  await laneCoverage.updateOne(
    { agentId: event.agentId },
    {
      $inc: { "lanes.events.count": 1, "lanes.structured_facts.count": extractedFacts.length },
      $set: { "lanes.events.lastUpdated": new Date() },
    },
    { upsert: true, session },
  );

  await session.commitTransaction();
} catch (e) {
  await session.abortTransaction();
  // Fall back to event-only write without transaction
  await events.insertOne(event);
} finally {
  session.endSession();
}
```

### 7.4 Computed Pattern (Store Pre-Computed Data on Write)

Instead of computing derived data at query time, compute on write and store alongside:

```javascript
// When writing an event, pre-compute and embed useful derived fields
const event = {
  content: "My name is Alex and I work at MongoDB",
  // Pre-computed during write:
  _derived: {
    wordCount: 8,
    hasEntities: true,
    entityHints: ["Alex", "MongoDB"], // cheap regex extraction
    factScore: 0.85, // heuristic fact-worthiness
    topicSignals: ["identity", "employment"],
    language: "en",
  },
};
```

This is the MongoDB-native way to avoid expensive computations at query time.

---

## 8. Synthesis: Recommended Architecture for ClawMongo

### The Three-Tier Extraction Architecture

```
TIER 1: Sync Hot Path (< 5ms, rule-based, in writeEvent)
  - Regex-based entity hints (proper nouns, pronouns resolved)
  - Heuristic fact scoring (is this worth extracting?)
  - Computed fields (_derived.wordCount, _derived.factScore, etc.)
  - Episode trigger check (event count, time gap, session boundary)
  - Lane coverage counter update ($inc)
  - ALL writes in single bulkWrite or transaction

TIER 2: Near-Sync Warm Path (< 100ms, still in writeEvent but after primary write)
  - Pattern-based structured fact extraction (regex templates)
  - Pattern-based entity extraction (known patterns only)
  - Write facts/entities to their collections
  - Wrapped in try/catch -- failures don't block event write
  - Mark event.extractionStatus = "completed" or "failed"

TIER 3: Async Cold Path (background, LLM-powered)
  - LLM fact extraction for events where Tier 2 found low-confidence results
  - LLM entity resolution and deduplication
  - Episode materialization with LLM summary
  - Graph edge extraction and validation
  - Runs on timer or change stream trigger
  - Processes events where extractionStatus = "pending" or "failed"
```

### Why This Architecture

1. **Latency:** Hot path stays under 5ms. No LLM calls block writes.
2. **Data availability:** Tier 2 immediately populates structured_facts and entities lanes, making the retrieval planner useful right away.
3. **Quality:** Tier 3 LLM enrichment improves extraction quality over time.
4. **Resilience:** Event writes never fail. Extraction failures are tracked and retried.
5. **MongoDB-native:** Uses bulkWrite, $inc, transactions, and optionally change streams.
6. **Progressive:** Start with Tier 1+2 only. Add Tier 3 when needed.

### Implementation Priority

1. **Wire Tier 1** into `writeEventAndProject()` (event write + derived fields + lane counters)
2. **Wire Tier 2** into `writeEventAndProject()` (pattern-based facts/entities, wrapped in try/catch)
3. **Wire episode triggers** into Tier 2 (event count + time window checks)
4. **Add lane coverage** collection and wire retrieval planner to skip empty lanes
5. **Optional: Tier 3** via change streams or cron for LLM enrichment

---

## Appendix A: Mem0's Fact Extraction Prompt (Full)

```
You are a Personal Information Organizer, specialized in accurately storing facts,
user memories, and preferences. Your primary role is to extract relevant pieces of
information from conversations and organize them into distinct, manageable facts.

Types of Information to Remember:
1. Store Personal Preferences (likes, dislikes, preferences)
2. Maintain Important Personal Details (names, relationships, dates)
3. Track Plans and Intentions (events, trips, goals)
4. Remember Activity and Service Preferences (dining, travel, hobbies)
5. Monitor Health and Wellness Preferences (dietary, fitness)
6. Store Professional Details (job titles, work habits, career goals)
7. Miscellaneous Information Management (favorites, brands, etc.)

Output: {"facts": ["Name is John", "Is a Software engineer"]}

Rules:
- Do not pick from system messages
- Return JSON with "facts" key
- Detect language and record facts in same language
```

## Appendix B: Graphiti's Entity Extraction Prompt (Key Section)

```
Extract entity nodes from conversational messages.

1. Speaker Extraction: Always extract the speaker (before `:`) as first entity
2. Entity Identification: Extract all significant entities, concepts, actors
   - Exclude entities mentioned ONLY in previous messages
3. Entity Classification: Use provided ENTITY TYPES with entity_type_id
4. Exclusions:
   - Do NOT extract relationships or actions
   - Do NOT extract dates, times, temporal info (handled separately)
5. Be explicit and unambiguous in naming (full names)
```

## Appendix C: LangMem's Memory Management Instructions (Full)

```
You are a long-term memory manager maintaining a core store of semantic,
procedural, and episodic memory. These memories power a life-long learning
agent's core predictive model.

1. Extract & Contextualize
   - Identify essential facts, relationships, preferences, reasoning procedures
   - Caveat uncertain information with confidence levels (p(x))
   - Quote supporting information when necessary

2. Compare & Update
   - Attend to novel information that deviates from existing memories
   - Consolidate and compress redundant memories; maximize SNR
   - Remove incorrect or redundant memories

3. Synthesize & Reason
   - What can you conclude using deduction, induction, and abduction?
   - What patterns, relationships, and principles emerge?
   - Qualify conclusions with probabilistic confidence

Prioritize retention of surprising (pattern deviation) and persistent
(frequently reinforced) information.
```
