# MongoDB Capabilities in ClawMongo

ClawMongo uses 12 MongoDB capabilities that together make MongoDB the best agentic data layer. This page explains **why** each capability matters for agent memory and **how** ClawMongo implements it.

---

## Table of Contents

1. [Automated Embeddings (Voyage AI via mongot)](#1-automated-embeddings-voyage-ai-via-mongot)
2. [Vector Search ($vectorSearch)](#2-vector-search-vectorsearch)
3. [Full-Text Search (mongot)](#3-full-text-search-mongot)
4. [Hybrid Search ($rankFusion / $scoreFusion)](#4-hybrid-search-rankfusion--scorefusion)
5. [Knowledge Graph ($graphLookup)](#5-knowledge-graph-graphlookup)
6. [Event-Sourcing (Canonical Events)](#6-event-sourcing-canonical-events)
7. [Schema Validation (JSON Schema)](#7-schema-validation-json-schema)
8. [Change Streams](#8-change-streams)
9. [TTL Indexes](#9-ttl-indexes)
10. [Multi-Tenant Isolation](#10-multi-tenant-isolation)
11. [Idempotent Upserts](#11-idempotent-upserts)
12. [Relevance Telemetry](#12-relevance-telemetry)

---

## 1. Automated Embeddings (Voyage AI via mongot)

### Why This Matters

Most agent memory systems require you to manage an embedding pipeline: choose an embedding model, run it in your application code, handle batching, retries, model version upgrades, and dimension mismatches. This is an entire infrastructure category that has nothing to do with building an AI assistant.

With mongot's `autoEmbed`, ClawMongo eliminates the embedding pipeline entirely. mongot reads the `text` field from your documents, calls the Voyage AI API to generate embeddings at index time, and does the same at query time. Your application code never touches embeddings. When Voyage releases a better model, you update the index definition -- not your application.

### How It Works

mongot delegates to the Voyage AI API using the `autoEmbed` field type in vector search index definitions. At index time, mongot reads the text field from each document and sends it to `voyage-4-large` for embedding. At query time, `$vectorSearch` sends the query text to mongot, which embeds it and runs approximate nearest neighbor (ANN) search.

Configuration: set `memory.mongodb.embeddingMode = "automated"` in ClawMongo config. Set the `VOYAGE_API_KEY` environment variable on the `mongodb-atlas-local:preview` container (or pass it to `start-preview.sh`).

### Configuration Example

```json5
// Vector search index definition (autoEmbed)
{
  type: "vectorSearch",
  definition: {
    fields: [
      {
        type: "autoEmbed",
        modality: "text",
        path: "text",
        model: "voyage-4-large", // 1024 dimensions
      },
      { type: "filter", path: "source" },
      { type: "filter", path: "agentId" },
      { type: "filter", path: "scope" },
    ],
  },
}
```

### Collections Using This

- `chunks` (conversation memory)
- `kb_chunks` (knowledge base)
- `structured_mem` (structured facts)
- `procedures` (workflow artifacts)

---

## 2. Vector Search ($vectorSearch)

### Why This Matters

Agent memory retrieval is fundamentally a semantic matching problem. When a user asks "what was that project we discussed last week," the agent needs to find relevant conversations by meaning, not by keyword overlap. Vector search enables this by comparing the mathematical similarity of text embeddings.

Without vector search, agent memory is limited to exact keyword matches. With it, the agent can find semantically related content even when the user uses different words than what was originally stored.

### How It Works

ClawMongo uses `$vectorSearch` as a first-stage aggregation pipeline operator. With autoEmbed enabled, you pass the query as text and mongot handles embedding:

```javascript
db.chunks.aggregate([
  {
    $vectorSearch: {
      index: "chunks_vector",
      query: { text: "what project did we discuss" },
      path: "text",
      numCandidates: 100,
      limit: 10,
      filter: { agentId: "agent-123", scope: "agent" },
    },
  },
  { $project: { text: 1, score: { $meta: "vectorSearchScore" } } },
]);
```

The HNSW index provides sub-linear search time. Filter fields (`agentId`, `scope`, `scopeRef`, `source`, `path`) are pre-filtered before vector comparison, so multi-tenant queries remain fast.

### Collections Using This

- `chunks` (conversation memory vector search)
- `kb_chunks` (knowledge base vector search)
- `structured_mem` (structured fact semantic search)
- `procedures` (workflow artifact search)

---

## 3. Full-Text Search (mongot)

### Why This Matters

Vector search excels at semantic similarity but can miss exact terms. When a user says "find the error about ECONNREFUSED," they want keyword-exact matches, not semantically similar errors. Full-text search with mongot handles this case with Lucene-powered text indexes.

Agent memory needs both search modes. Semantic search finds related content; text search finds exact content. Using only one leaves blind spots.

### How It Works

ClawMongo creates mongot text search indexes alongside vector indexes. The text indexes use Lucene's standard analyzer for tokenization and relevance scoring:

```json5
// Text search index definition
{
  type: "search",
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        text: { type: "string", analyzer: "lucene.standard" },
        source: { type: "token" },
        agentId: { type: "token" },
        scope: { type: "token" },
      },
    },
  },
}
```

ClawMongo also maintains BSON `$text` indexes as a defensive fallback when mongot is unavailable. The `buildOrJoinFtsQuery` function constructs OR-join queries (not AND-join) to maximize recall for natural language queries.

### Collections Using This

- `chunks` (conversation text search)
- `kb_chunks` (knowledge base text search)
- `structured_mem` (structured fact text search)
- `procedures` (workflow text search)
- `entities` (entity name + alias text search)
- `episodes` (episode title + summary text search)

---

## 4. Hybrid Search ($rankFusion / $scoreFusion)

### Why This Matters

Neither vector search nor full-text search alone is sufficient for agent memory. Vector search misses exact terms. Text search misses semantic similarity. Hybrid search fuses results from both to maximize recall.

The challenge is scoring: vector scores (cosine similarity) and text scores (BM25/Lucene) live on different scales. Naive combination penalizes one type. Reciprocal Rank Fusion (RRF) solves this by ranking results by their position in each list, not by raw score.

### How It Works

On MongoDB 8.0+, ClawMongo uses `$rankFusion` to combine vector and text pipelines in a single aggregation. On MongoDB 8.2+, `$scoreFusion` is also available for score-based combination with normalization.

For servers where these stages are unavailable, ClawMongo falls back to manual RRF: run both searches independently, compute `1 / (k + rank)` for each result in each list, sum scores for results appearing in both, and sort by combined score.

```javascript
// Manual RRF fallback (simplified)
function rrfScore(rank, k = 60) {
  return 1 / (k + rank);
}
// Results appearing in both vector and text lists get summed RRF scores
```

Score normalization happens per search method: vector scores are clamped to [0, 1], text scores are min-max normalized within their result set. The `normalizeSearchResults` function in `mongodb-hybrid.ts` handles this.

### Collections Using This

Hybrid search applies to any collection that has both a text and vector index: `chunks`, `kb_chunks`, `structured_mem`, `procedures`.

---

## 5. Knowledge Graph ($graphLookup)

### Why This Matters

Flat retrieval (search and return snippets) loses the relationships between entities. When a user asks "what does Alice work on," the agent needs to traverse a graph: find Alice (entity), follow her `works_on` edges (relations), and return the connected projects (entities). This cannot be done with search alone.

Most agent memory systems either skip graph traversal entirely or bolt on an external graph database (Neo4j, etc.). ClawMongo uses MongoDB's native `$graphLookup` stage, so the knowledge graph lives in the same database as everything else.

### How It Works

Entities are extracted from conversation events using rule-based regex patterns (5 types: @mentions, #tags, URLs, file paths, "Quoted Names"). Relations link entities with typed edges (`works_on`, `owns`, `depends_on`, `blocked_by`, `decided`, `mentioned_with`, `reported_by`, `related_to`) and carry weight + confidence scores.

Graph traversal uses `$graphLookup` with optional bi-directional expansion via `$facet`:

```javascript
// Bi-directional graph expansion
db.relations.aggregate([
  { $match: { agentId: "agent-123", scope: "agent" } },
  {
    $facet: {
      outbound: [
        { $match: { fromEntityId: rootEntityId } },
        {
          $graphLookup: {
            from: "relations",
            startWith: "$toEntityId",
            connectFromField: "toEntityId",
            connectToField: "fromEntityId",
            as: "connections",
            maxDepth: 1,
            restrictSearchWithMatch: { agentId: "agent-123" },
          },
        },
      ],
      inbound: [
        { $match: { toEntityId: rootEntityId } },
        {
          $graphLookup: {
            from: "relations",
            startWith: "$fromEntityId",
            connectFromField: "fromEntityId",
            connectToField: "toEntityId",
            as: "connections",
            maxDepth: 1,
            restrictSearchWithMatch: { agentId: "agent-123" },
          },
        },
      ],
    },
  },
]);
```

The `restrictSearchWithMatch` parameter is essential for multi-tenant isolation -- it ensures `$graphLookup` never traverses into another agent's data.

### Collections Using This

- `entities` (nodes: people, projects, topics, concepts)
- `relations` (edges: typed, weighted, directional)
- `entity_links` (entity resolution: confirmed same, candidate same, related mention)

---

## 6. Event-Sourcing (Canonical Events)

### Why This Matters

Most agent memory systems write directly to their storage format (chunks, embeddings, key-value pairs). This means there is no audit trail, no way to replay history, and no way to derive new representations from old conversations.

ClawMongo uses event-sourcing: every inbound message, tool output, and system event is written to a canonical `events` collection first. Chunks, entities, relations, and episodes are all derived projections from these events. If you want to re-index, re-extract entities, or add a new derived representation, you replay the events -- you never lose data.

### How It Works

The write path goes through `writeEventAndProject()`:

1. Write the canonical event to the `events` collection using `$setOnInsert` (idempotent)
2. Project a chunk from the event into the `chunks` collection
3. Record an ingest run in `ingest_runs`
4. Fire-and-forget entity extraction via `extractAndUpsertEntities()`

```typescript
// Canonical event structure
{
  eventId: "uuid",           // unique identifier
  agentId: "agent-123",      // agent isolation
  role: "user",              // user | assistant | system | tool
  body: "message text",      // the content
  scope: "agent",            // memory scope
  scopeRef: "agent-123",     // resolved scope namespace
  timestamp: ISODate(),      // when it happened
  sessionId: "session-abc",  // optional session context
  projectedAt: ISODate(),    // when chunks were derived
  consolidatedAt: ISODate(), // when rolled into an episode
  consolidatedIntoEpisodeId: "episode-xyz"
}
```

Events are append-only for the canonical fields. The `projectedAt` and `consolidatedAt` fields are updated when derived projections are created, providing a full lifecycle audit trail.

### Collections Using This

- `events` (canonical source of truth)
- `chunks` (derived: searchable text fragments)
- `entities`, `relations` (derived: knowledge graph)
- `episodes` (derived: consolidated summaries)
- `ingest_runs` (audit: what was ingested and when)
- `projection_runs` (audit: what was derived and when)

---

## 7. Schema Validation (JSON Schema)

### Why This Matters

Agent memory is written by both application code and LLM-generated tool calls. LLMs produce unpredictable output. Without schema validation, a malformed memory write silently corrupts the database. With it, the write fails fast and the application can handle the error.

ClawMongo applies JSON Schema validation (`$jsonSchema`) to 17 collections with `validationAction: "error"`, so invalid documents are rejected at write time rather than silently accepted.

### How It Works

Validators are defined in `mongodb-schema.ts` and applied via `ensureSchemaValidation()` on every startup. The `collMod` command applies the schema idempotently.

```javascript
// Example: events collection schema
{
  $jsonSchema: {
    bsonType: "object",
    required: ["eventId", "agentId", "role", "body", "scope", "scopeRef", "timestamp"],
    properties: {
      eventId: { bsonType: "string" },
      agentId: { bsonType: "string" },
      role: { enum: ["user", "assistant", "system", "tool"] },
      body: { bsonType: "string" },
      scope: { enum: ["session", "user", "agent", "workspace", "tenant", "global"] },
      scopeRef: { bsonType: "string" },
      timestamp: { bsonType: "date" }
    }
  }
}
```

Schema validation catches common LLM mistakes: missing required fields, wrong types (string instead of date), invalid enum values (a `role` of `"human"` instead of `"user"`), and negative numbers where minimums are defined.

### Collections Using This

All 17 validated collections: `chunks`, `knowledge_base`, `kb_chunks`, `structured_mem`, `structured_mem_revisions`, `procedures`, `procedure_revisions`, `relevance_runs`, `relevance_artifacts`, `relevance_regressions`, `events`, `entities`, `relations`, `entity_links`, `episodes`, `ingest_runs`, `projection_runs`.

---

## 8. Change Streams

### Why This Matters

When multiple gateway instances or agents share the same MongoDB backend, they need to stay in sync. Without change streams, each instance would need to poll for changes, introducing latency and wasted queries.

MongoDB change streams provide real-time notification of document changes. ClawMongo uses them to sync memory state across gateway instances without polling.

### How It Works

The `MongoDBChangeStreamWatcher` class opens a change stream on memory collections and emits events when documents are inserted, updated, or deleted. Resume tokens are stored in the `meta` collection so watchers can resume after gateway restarts without missing changes.

```typescript
// Change stream setup (simplified)
const changeStream = collection.watch([], {
  fullDocument: "updateLookup",
  resumeAfter: savedResumeToken,
});

changeStream.on("change", (event) => {
  // Notify local cache / other subsystems
  // Persist resume token for crash recovery
});
```

Change streams require a replica set. For single-node development, ClawMongo falls back to periodic sync as a degraded but functional alternative.

### Collections Using This

Change streams are opened on the primary memory collections (`chunks`, `structured_mem`, `events`). The resume token is stored in the `meta` collection.

---

## 9. TTL Indexes

### Why This Matters

Not all data in an agent's memory should live forever. Embedding caches become stale when the model changes. Relevance telemetry data is useful for diagnostics but should not accumulate indefinitely. Without automatic expiration, operators must build and maintain cleanup jobs.

MongoDB TTL indexes handle this automatically: documents are deleted when their timestamp field exceeds the configured `expireAfterSeconds`.

### How It Works

ClawMongo creates TTL indexes on three collection types:

```javascript
// Embedding cache: expire after N days
await embeddingCache.createIndex(
  { updatedAt: 1 },
  { name: "idx_cache_ttl", expireAfterSeconds: days * 86400 },
);

// Relevance telemetry: expire after retention period
await relevanceRuns.createIndex(
  { ts: 1 },
  { name: "idx_relruns_ttl", expireAfterSeconds: retentionDays * 86400 },
);
```

TTL is configurable per collection type and defaults to disabled for canonical data (events, chunks, structured memory) to prevent accidental data loss.

### Collections Using This

- `embedding_cache` (configurable via `embeddingCacheTtlDays`)
- `relevance_runs` (configurable via `relevanceRetentionDays`)
- `relevance_artifacts` (follows same retention as runs)
- `files` (optional, configurable via `memoryTtlDays` -- use with caution)

---

## 10. Multi-Tenant Isolation

### Why This Matters

A single ClawMongo deployment can serve multiple agents, each with their own memory, entities, and episodes. Agent A must never see Agent B's data, even when they share the same database and collections.

Most agent memory systems achieve isolation through separate databases or file paths. ClawMongo uses compound indexes with `agentId` as the leading field, so all queries are scoped by agent at the index level.

### How It Works

Every collection uses `agentId` as the first field in its compound indexes:

```javascript
// Events: scoped by agent + scope + time
{ agentId: 1, scope: 1, scopeRef: 1, timestamp: -1 }

// Entities: scoped by agent + scope + type + name
{ agentId: 1, scope: 1, scopeRef: 1, type: 1, name: 1 }

// Structured memory: unique per agent + scope + type + key
{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1 } // unique: true
```

For `$graphLookup`, the `restrictSearchWithMatch` parameter ensures graph traversal stays within the agent's data boundary. Without this, a graph expansion could follow edges into another agent's entities.

The `VALID_SCOPES` and `VALID_ROLES` ReadonlySet patterns validate scope and role parameters before they reach MongoDB, preventing injection of unexpected values.

### Collections Using This

All 20 collections use `agentId`-prefixed indexes. The `scope` and `scopeRef` fields add a second level of isolation within each agent (session, user, workspace, tenant, global).

---

## 11. Idempotent Upserts

### Why This Matters

Network retries, webhook replays, and concurrent writes are facts of life in distributed systems. If writing the same event twice creates two documents, the agent's memory is corrupted. Idempotent upserts ensure that retrying a write produces the same result as the original write.

### How It Works

ClawMongo separates creation-time fields from mutable fields using MongoDB's `$setOnInsert` and `$set` operators on unique compound keys:

```javascript
// Writing a canonical event (idempotent)
await events.updateOne(
  { eventId: eventId }, // unique key
  {
    $setOnInsert: {
      // only set on first insert
      eventId,
      agentId,
      role,
      body,
      scope,
      scopeRef,
      timestamp,
      createdAt: new Date(),
    },
    $set: {
      // update on every upsert
      updatedAt: new Date(),
    },
  },
  { upsert: true },
);
```

This pattern is used consistently across all collections:

- `eventId` for events (unique: true)
- `episodeId` for episodes (unique: true)
- `{agentId, scope, scopeRef, type, key}` for structured memory (unique: true)
- `{procedureId, agentId, scope, scopeRef}` for procedures (unique: true)
- `{fromEntityId, toEntityId, linkType}` + agent scope for entity links (unique: true)

### Collections Using This

All collections with unique compound keys: `events`, `episodes`, `structured_mem`, `procedures`, `entity_links`, `embedding_cache`, `knowledge_base`, `kb_chunks`.

---

## 12. Relevance Telemetry

### Why This Matters

Retrieval quality degrades silently. Without measurement, you cannot tell whether your agent is finding the right memories or returning irrelevant noise. Most agent memory systems provide no visibility into retrieval quality.

ClawMongo includes explain-driven diagnostics that record what happened during each retrieval: which search methods were used, what scores came back, how long the search took, and whether the results meet quality thresholds.

### How It Works

The `MongoDBRelevanceRuntime` class records telemetry for each retrieval operation:

- **Relevance runs** (`relevance_runs`): per-query metadata including agent ID, timestamp, query hash, source scope, latency, hit sources, fallback path, and status (`ok`, `degraded`, `insufficient-data`)
- **Relevance artifacts** (`relevance_artifacts`): detailed explain output from search, vector, and fusion stages. Includes raw `explain()` output for deep debugging.
- **Relevance regressions** (`relevance_regressions`): detected quality drops with severity levels, baseline vs current metrics, delta, and failing cases.

```javascript
// Relevance run record
{
  runId: "uuid",
  agentId: "agent-123",
  ts: ISODate(),
  queryHash: "sha256-of-query",
  sourceScope: "all",
  latencyMs: 142,
  topK: 10,
  hitSources: ["chunks", "structured_mem"],
  fallbackPath: null,
  status: "ok"
}
```

The CLI surface (`memory relevance *`) exposes this data for operators. Sampling rate is configurable to control storage overhead.

### Collections Using This

- `relevance_runs` (query-level telemetry)
- `relevance_artifacts` (detailed explain output)
- `relevance_regressions` (quality regression detection)

---

## The Full Picture

All 12 capabilities work together in a single query/write cycle:

```text
Write path:
  message arrives
    -> Schema Validation rejects malformed input           [7]
    -> Event-Sourcing writes canonical event               [6]
    -> Idempotent Upsert prevents duplicate writes         [11]
    -> Automated Embeddings index the text                 [1]
    -> Entity extraction builds Knowledge Graph            [5]
    -> Episode triggers consolidate event windows          [6]
    -> Multi-Tenant Isolation scopes everything by agent   [10]
    -> Change Streams notify other gateway instances       [8]

Read path:
  query arrives
    -> Retrieval planner selects paths
    -> Vector Search finds semantically similar content    [2]
    -> Full-Text Search finds exact keyword matches        [3]
    -> Hybrid Search fuses both result sets                [4]
    -> Knowledge Graph traverses entity relationships      [5]
    -> Relevance Telemetry records what happened           [12]
    -> TTL Indexes keep caches and telemetry bounded       [9]
```

This is why MongoDB is the best agentic data layer: one database, one operational surface, 12 capabilities that would otherwise require 5-6 separate services.
