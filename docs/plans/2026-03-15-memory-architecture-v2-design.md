# ClawMongo Memory Architecture v2 — Design

## Purpose

Evolve ClawMongo's MongoDB memory system from its current "retrieval-projection-first"
architecture to the blueprint's "canonical-truth-first" architecture. The goal is to
implement all 8 improvement areas from the blueprint as a migration-safe big bang: built
in parallel alongside the existing system, validated against the production bot, then
cut over via a controlled migration.

## Users

- Developers building and operating ClawMongo-based agents
- Operators deploying production bots on MongoDB Community + mongot
- The production Rom bot as the first real deployment target

## Success Criteria

- [ ] All new collections (events, entities, relations, episodes, ingest_runs, projection_runs) created with JSON Schema validation
- [ ] Canonical events become the primary write target; chunks derived from events
- [ ] Structured memory gains a formal `scope` field (session/user/agent/workspace/tenant/global)
- [ ] Source policy enforced end-to-end: cache keys include source config, no silent widening
- [ ] Retrieval planner routes queries through structured → raw-window → graph → hybrid → KB → episodic
- [ ] Graph projection via `$graphLookup` works on entities/relations collections
- [ ] Episode materialization produces daily/thread summaries from raw events
- [ ] End-to-end memory tests cover: event→chunk projection, structured extraction→recall, raw-window→episode, degraded mongot fallback
- [ ] Migration path: backfill events from existing chunks, zero data loss
- [ ] Production bot validates all paths before cutover

## Constraints

- MongoDB-only: no Neo4j, Qdrant, SQLite, or external graph/vector DB
- Community + mongot is the deployment target
- Automated embeddings via voyage-4-large remain the embedding path
- Must not break existing hybrid retrieval during development (parallel build)
- Search index budget: self-managed profile (no hard limit, but keep lean)
- Change streams require replica set; periodic sync must be the default fallback

## Out of Scope

- Multi-tenant (`tenant` scope) — defined in types but not wired in v1
- Real-time change stream materialization as the default (opt-in only)
- Automatic entity/relation extraction via LLM (manual + rule-based first)
- Cross-agent memory sharing (future multi-agent feature)

## Approach Chosen

**Migration-Safe Big Bang**: Build the full target architecture in new files alongside
the existing system. Keep current retrieval working throughout. When ready, a migration
function backfills canonical events from existing chunks, enables the new retrieval
planner, and activates graph/episode projections. Rollback = disable the v2 config flag.

## Architecture Overview

### Current State (v1)

```
Inbound → chunks (primary truth + retrieval)
       → kb_chunks (KB retrieval)
       → structured_mem (durable facts)
       → relevance_runs/artifacts/regressions (telemetry)
```

### Target State (v2)

```
Inbound → events (canonical truth)
       ├→ chunks (derived retrieval projection)
       ├→ structured_mem + scope field (durable facts)
       ├→ entities + relations (graph projection)
       ├→ episodes (summary materialization)
       └→ ingest_runs + projection_runs (operational)

Retrieval Planner → structured → raw-window → graph → hybrid → KB → episodic
```

### Migration Bridge

```
v2 enabled? ──no──→ v1 path (current behavior, unchanged)
    │yes
    ├→ writes go to events first, then project to chunks
    ├→ retrieval planner activated
    ├→ graph/episode projections enabled
    └→ source policy enforcement strict mode
```

## Components

### 1. New Collection Helpers & Schemas (`mongodb-schema.ts` additions)

New collection accessor functions:

```typescript
eventsCollection(db, prefix); // canonical truth
entitiesCollection(db, prefix); // graph nodes
relationsCollection(db, prefix); // graph edges
episodesCollection(db, prefix); // summaries
ingestRunsCollection(db, prefix); // operational
projectionRunsCollection(db, prefix); // operational
```

New JSON Schema validators for each.

### 2. Canonical Events Collection (`mongodb-events.ts` — new file)

**Schema**:

```typescript
type CanonicalEvent = {
  eventId: string; // unique event identifier
  agentId: string;
  sessionId?: string;
  channel?: string; // telegram, discord, web, etc.
  role: "user" | "assistant" | "system" | "tool";
  body: string; // raw message text
  metadata?: Record<string, unknown>;
  scope: MemoryScope; // NEW: formal scope
  timestamp: Date;
  projectedAt?: Date; // when chunks were derived
};
```

**Write path**: `writeEvent()` → canonical insert → trigger chunk projection.

**Migration**: `backfillEventsFromChunks()` — reads existing chunks, reconstructs
events with best-effort metadata, writes to events collection.

### 3. Formal Memory Scope (`types.ts` + `types.memory.ts` additions)

```typescript
type MemoryScope = "session" | "user" | "agent" | "workspace" | "tenant" | "global";
```

- Added as an indexed field on: `events`, `structured_mem`, `entities`, `relations`, `episodes`
- `structured_mem` gets `scope` added to its schema validator and unique index
- Unique index becomes: `(agentId, scope, type, key)` — allowing same key in different scopes
- Default scope: `"agent"` (backward compatible with current agentId-only scoping)

### 4. Source Policy Enforcement (`mongodb-manager.ts` + `search-manager.ts`)

**Problem**: Cache keys in `search-manager.ts` use `stableSerialize(config)` but don't
include the active source policy. If an operator changes `sources.conversation.enabled`
at runtime, the cached manager keeps the old behavior.

**Fix**:

- Include `sources` config in `buildMongoDBCacheKey()`
- Add `sourcePolicy` field to `MongoDBMemoryManager` constructor
- `search()` and `searchKB()` check source policy before every query
- `status()` reports the real active sources, not just what's configured
- Retrieval planner respects source policy per path

### 5. Retrieval Planner (`mongodb-retrieval-planner.ts` — new file)

```typescript
type RetrievalPath =
  | "structured" // direct lookup by type/key
  | "raw-window" // recent events by time range
  | "graph" // entity/relation expansion
  | "hybrid" // lexical + vector fusion
  | "kb" // knowledge base
  | "episodic"; // compressed summaries

type RetrievalPlan = {
  paths: RetrievalPath[];
  confidence: "high" | "medium" | "low";
  reasoning: string;
};

function planRetrieval(query: string, context: RetrievalContext): RetrievalPlan;
```

**Routing heuristics**:

- Contains exact key/type reference → structured first
- Contains time words ("today", "yesterday", "last week") → raw-window first
- Contains entity/person names → graph expansion
- General recall → hybrid (current default)
- Broad/historical questions → episodic

The planner is a lightweight function, not an LLM call. It uses keyword matching
and context signals to choose the cheapest effective path.

### 6. Graph Projection (`mongodb-graph.ts` — new file)

**Entity schema**:

```typescript
type Entity = {
  entityId: string;
  name: string;
  type: "person" | "org" | "project" | "topic" | "feature" | "issue" | "document" | "custom";
  aliases?: string[];
  agentId: string;
  scope: MemoryScope;
  metadata?: Record<string, unknown>;
  sourceEventIds?: string[]; // provenance
  updatedAt: Date;
};
```

**Relation schema**:

```typescript
type Relation = {
  fromEntityId: string;
  toEntityId: string;
  type:
    | "works_on"
    | "owns"
    | "depends_on"
    | "blocked_by"
    | "decided"
    | "mentioned_with"
    | "reported_by"
    | "related_to";
  weight?: number;
  agentId: string;
  scope: MemoryScope;
  sourceEventIds?: string[];
  updatedAt: Date;
};
```

**Graph queries** via `$graphLookup`:

```javascript
// Expand from an entity through relations
db.entities.aggregate([
  { $match: { name: "Rom" } },
  {
    $graphLookup: {
      from: "openclaw_relations",
      startWith: "$entityId",
      connectFromField: "toEntityId",
      connectToField: "fromEntityId",
      as: "connections",
      maxDepth: 2,
      restrictSearchWithMatch: { agentId: "..." },
    },
  },
]);
```

**Population**: Initially manual via `memory_write` with type `"entity"` or
`"relationship"`. Future: rule-based extraction from events.

### 7. Episode Materialization (`mongodb-episodes.ts` — new file)

**Episode schema**:

```typescript
type Episode = {
  episodeId: string;
  type: "daily" | "weekly" | "thread" | "topic" | "decision";
  title: string;
  summary: string; // LLM-generated summary
  agentId: string;
  scope: MemoryScope;
  timeRange: { start: Date; end: Date };
  sourceEventCount: number;
  sourceEventIds?: string[]; // sample provenance
  tags?: string[];
  updatedAt: Date;
};
```

**Materialization**: Read ordered raw events for the exact time window, pass to
LLM for summarization, store result. Never build from vector hits alone.

**Triggers**: Configurable — daily cron, on-demand via CLI command, or
change-stream trigger (opt-in).

### 8. Operational Collections (`mongodb-ops.ts` — new file)

**ingest_runs**: Track each ingest operation (file sync, session sync, KB import).

```typescript
type IngestRun = {
  runId: string;
  agentId: string;
  source: "file-sync" | "session-sync" | "kb-import" | "manual";
  status: "ok" | "partial" | "failed";
  itemsProcessed: number;
  itemsFailed: number;
  durationMs: number;
  ts: Date;
};
```

**projection_runs**: Track chunk/graph/episode projection freshness.

```typescript
type ProjectionRun = {
  runId: string;
  agentId: string;
  projectionType: "chunks" | "entities" | "relations" | "episodes";
  status: "ok" | "partial" | "failed";
  lag?: number; // seconds behind canonical truth
  itemsProjected: number;
  durationMs: number;
  ts: Date;
};
```

## Data Flow

### Write Path (v2)

```
1. Inbound message arrives
2. writeEvent() → insert into events collection (canonical truth)
3. projectChunks() → derive chunks from event (existing chunking logic)
4. extractStructured() → auto-extract facts/decisions (future: rule-based)
5. projectGraph() → update entities/relations if extraction ran
6. checkEpisodeTrigger() → queue episode materialization if threshold met
7. recordIngestRun() → operational telemetry
```

### Read Path (v2)

```
1. User query arrives
2. planRetrieval() → choose paths based on query shape
3. Execute paths in priority order:
   a. structured lookup (fast, exact)
   b. raw-window (time-bounded, ordered)
   c. graph expansion ($graphLookup)
   d. hybrid chunk retrieval (existing search)
   e. KB retrieval (existing kb_search)
   f. episodic memory (broad recall)
4. Merge results with confidence scores
5. Return with citations + retrieval path metadata
```

## Error Handling

### Degradation Rules (from blueprint)

| Component Down                | Impact                  | Fallback                                             |
| ----------------------------- | ----------------------- | ---------------------------------------------------- |
| mongot degraded               | No vector/text search   | Lexical $text fallback on chunks + structured lookup |
| Change streams unavailable    | No real-time projection | Periodic sync (default path)                         |
| Episode materialization fails | No summaries            | Raw event window queries still work                  |
| Graph projection fails        | No entity expansion     | Skip graph path, hybrid retrieval covers it          |
| Event write fails             | No canonical truth      | Fail fast — do not silently drop to chunks-only      |

### Migration Safety

- v2 config flag (`memory.runtimeMode: "mongo_v2"`) enables new paths
- Default remains `"mongo_canonical"` (current v1 behavior)
- Backfill function runs idempotently (safe to re-run)
- All new collections are created alongside existing ones (no drops)
- Rollback: set `runtimeMode` back to `"mongo_canonical"`

## Testing Strategy

### Unit Tests (per component)

- `mongodb-events.test.ts`: event write, read, backfill from chunks
- `mongodb-graph.test.ts`: entity/relation CRUD, `$graphLookup` queries
- `mongodb-episodes.test.ts`: episode materialization, time-window reads
- `mongodb-retrieval-planner.test.ts`: path selection for different query shapes
- `mongodb-ops.test.ts`: ingest/projection run recording
- `mongodb-schema.test.ts`: updated for new collections and validators

### End-to-End Tests

- `event→chunk projection`: write event, verify chunk appears, verify retrieval finds it
- `structured extraction→recall`: write structured with scope, search respects scope
- `raw-window→episode`: write events, materialize episode, verify summary quality
- `degraded mongot→fallback`: disable search indexes, verify lexical fallback works
- `source policy enforcement`: change source config, verify cache invalidation and query filtering
- `graph expansion`: create entities+relations, verify `$graphLookup` returns connected subgraph
- `migration backfill`: create v1 chunks, run backfill, verify events created correctly

### Production Validation

- This repo is the ClawMongo source code; the production bot is a separate repo that
  consumes ClawMongo as an npm package
- After all tests pass here: `npm publish` the updated package
- Update the production bot repo to pull the new version
- Deploy to production bot with `runtimeMode: "mongo_v2"`
- Monitor: ingest_runs, projection_runs, relevance_runs
- Compare retrieval quality v1 vs v2 using relevance benchmark
- Validate episode summaries against manual review

### Release Steps

1. All unit + e2e tests pass in this repo (`pnpm test`)
2. Build succeeds (`pnpm build`)
3. Publish to npm (version bump + `npm publish`)
4. Update production bot repo to new version
5. Enable `runtimeMode: "mongo_v2"` in production bot config
6. Monitor and validate

## Observability

- **Logging**: Subsystem loggers for each new module (`memory:mongodb:events`, `memory:mongodb:graph`, `memory:mongodb:episodes`, `memory:mongodb:ops`, `memory:mongodb:planner`)
- **Metrics**: ingest_runs and projection_runs collections serve as the metrics store
- **Health**: `status()` extended to report: canonical write health, retrieval path health, projection freshness, graph size, episode count

## Questions Resolved

- Q: Delivery approach? → Big bang (all 8 areas together)
- Q: Events vs chunks as primary? → Events as new primary, chunks derived
- Q: Testing target? → Production bot
- Q: Migration safety? → Parallel build with controlled cutover via config flag
- Q: Graph DB? → No, `$graphLookup` on MongoDB collections
- Q: Episode trigger? → Configurable (cron, manual, change-stream opt-in)
- Q: Entity extraction? → Manual/rule-based first, LLM extraction future

## Implementation File Map

| New/Modified | File                                           | Purpose                               |
| ------------ | ---------------------------------------------- | ------------------------------------- |
| NEW          | `src/memory/mongodb-events.ts`                 | Canonical events collection           |
| NEW          | `src/memory/mongodb-graph.ts`                  | Entity/relation graph projection      |
| NEW          | `src/memory/mongodb-episodes.ts`               | Episode materialization               |
| NEW          | `src/memory/mongodb-retrieval-planner.ts`      | Retrieval path selection              |
| NEW          | `src/memory/mongodb-ops.ts`                    | Operational collections               |
| NEW          | `src/memory/mongodb-migration.ts`              | v1→v2 backfill/migration              |
| MOD          | `src/memory/mongodb-schema.ts`                 | New collections, schemas, indexes     |
| MOD          | `src/memory/mongodb-manager.ts`                | Wire v2 paths, source policy          |
| MOD          | `src/memory/mongodb-structured-memory.ts`      | Add scope field                       |
| MOD          | `src/memory/search-manager.ts`                 | Source policy in cache key            |
| MOD          | `src/memory/types.ts`                          | MemoryScope type, extended interfaces |
| MOD          | `src/config/types.memory.ts`                   | v2 config options                     |
| NEW          | `src/memory/mongodb-events.test.ts`            | Event tests                           |
| NEW          | `src/memory/mongodb-graph.test.ts`             | Graph tests                           |
| NEW          | `src/memory/mongodb-episodes.test.ts`          | Episode tests                         |
| NEW          | `src/memory/mongodb-retrieval-planner.test.ts` | Planner tests                         |
| NEW          | `src/memory/mongodb-ops.test.ts`               | Ops tests                             |
| NEW          | `src/memory/mongodb-migration.test.ts`         | Migration tests                       |
| MOD          | `src/memory/mongodb-e2e.e2e.test.ts`           | Extended e2e scenarios                |
