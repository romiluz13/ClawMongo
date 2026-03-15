# ClawMongo Memory Architecture v2 Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** See `docs/plans/2026-03-15-memory-architecture-v2-design.md` for full specification.
> **Blueprint:** See `CLAWMONGO-MONGODB-MEMORY-BLUEPRINT.md` for the north star architecture.

**Goal:** Implement the full canonical-truth-first memory architecture: events as primary write target, chunks derived from events, graph projection, episode materialization, retrieval planner, operational collections, source policy enforcement, formal scopes, and migration from v1.

**Architecture:** Build v2 in new files alongside v1. A `runtimeMode: "mongo_v2"` config flag activates v2 paths. Default remains `"mongo_canonical"` (current v1). Migration backfills events from existing chunks. Rollback = set `runtimeMode` back to `"mongo_canonical"`.

**Tech Stack:** TypeScript ESM, MongoDB Community + mongot, Vitest, `$graphLookup`, automated embeddings (voyage-4-large), JSON Schema validation.

**Prerequisites:**

- Working MongoDB 8.2+ instance for e2e tests
- Existing codebase patterns understood (see Context References below)

---

## Relevant Codebase Files

### Patterns to Follow

- `src/memory/mongodb-schema.ts` (lines 32-34) - `col()` helper pattern for collection accessors
- `src/memory/mongodb-schema.ts` (lines 84-237) - JSON Schema validator pattern (VALIDATED_COLLECTIONS)
- `src/memory/mongodb-schema.ts` (lines 239-275) - `ensureCollections()` idempotent creation pattern
- `src/memory/mongodb-schema.ts` (lines 308-519) - `ensureStandardIndexes()` index creation pattern with TTL
- `src/memory/mongodb-schema.ts` (lines 525-732) - `ensureSearchIndexes()` search index pattern
- `src/memory/mongodb-structured-memory.ts` (lines 47-103) - Write upsert pattern with `$set` / `$setOnInsert`
- `src/memory/mongodb-structured-memory.ts` (lines 121-261) - Search pattern: vector first, `$text` fallback
- `src/memory/mongodb-kb.ts` (lines 60-80) - KB ingestion pattern with transactions
- `src/memory/mongodb-manager.ts` - Main manager class with `create()` static factory
- `src/memory/search-manager.ts` (lines 73-89) - Cache key generation (the source policy leak)
- `src/memory/backend-config.ts` (lines 26-79) - `ResolvedMongoDBConfig` type definition
- `src/memory/backend-config.ts` (lines 99-354) - Config resolution with validation
- `src/config/types.memory.ts` - All memory config types
- `src/memory/types.ts` - `MemorySearchManager` interface, `MemorySearchResult`, `MemoryProviderStatus`
- `src/memory/mongodb-e2e.e2e.test.ts` - E2E test setup pattern (MongoDB test container)

### Key Architecture Decisions (from Design)

- Events are canonical truth; chunks derived, never primary
- `MemoryScope` = `"session" | "user" | "agent" | "workspace" | "tenant" | "global"`; default `"agent"`
- `$graphLookup` on single `relations` collection for graph traversal
- Retrieval planner is keyword/heuristic-based, not LLM-based
- Episode materialization reads raw ordered events, passes to LLM for summary
- Entities/relations populated manually first (via `memory_write`), not auto-extracted

---

## Phase 1: Foundation Types and Config

> **Exit Criteria:** `runtimeMode: "mongo_v2"` accepted by config resolver, `MemoryScope` type exported, all new collection schemas defined and validated.

### Task 1.1: Add `MemoryScope` type and extend `MemoryRuntimeMode`

**Files:**

- Modify: `src/config/types.memory.ts`
- Modify: `src/memory/types.ts`

**Step 1: Add MemoryScope and v2 runtime mode to types.memory.ts**

In `src/config/types.memory.ts`:

- Change `MemoryRuntimeMode` from `"mongo_canonical"` to `"mongo_canonical" | "mongo_v2"`
- Add `MemoryScope` type: `"session" | "user" | "agent" | "workspace" | "tenant" | "global"`
- Add v2-specific config fields to `MemoryMongoDBConfig`:
  ```typescript
  /** Episode materialization config (v2 only) */
  episodes?: {
    /** Enable episode materialization. Default: true when v2 */
    enabled?: boolean;
    /** Minimum events to trigger episode. Default: 10 */
    minEventsForEpisode?: number;
  };
  /** Graph projection config (v2 only) */
  graph?: {
    /** Enable graph projection. Default: true when v2 */
    enabled?: boolean;
    /** Max depth for $graphLookup. Default: 2 */
    maxGraphDepth?: number;
  };
  ```

**Step 2: Update backend-config.ts to accept "mongo_v2"**

In `src/memory/backend-config.ts`:

- Remove the hard error for `runtimeMode !== "mongo_canonical"` (line 112-116)
- Accept `"mongo_v2"` as a valid value
- Add resolved v2 config fields to `ResolvedMongoDBConfig`:
  ```typescript
  runtimeMode: "mongo_canonical" | "mongo_v2";
  episodes: {
    enabled: boolean;
    minEventsForEpisode: number;
  }
  graph: {
    enabled: boolean;
    maxGraphDepth: number;
  }
  ```
- Default `episodes.enabled` and `graph.enabled` to `true` when `runtimeMode === "mongo_v2"`, `false` otherwise
- Default `episodes.minEventsForEpisode` to `10`
- Default `graph.maxGraphDepth` to `2`

**Step 3: Write test for new config resolution**

Create test in `src/memory/backend-config.test.ts` (extend existing if present, create if not):

- Test: `"mongo_v2"` runtimeMode resolves without error
- Test: `"mongo_canonical"` still works (regression)
- Test: v2 config defaults when `runtimeMode === "mongo_v2"`
- Test: invalid runtimeMode still throws

**Step 4: Run tests**

Run: `pnpm test src/memory/backend-config`
Expected: PASS

**Step 5: Commit**

```
feat(memory): add MemoryScope type and mongo_v2 runtime mode
```

---

### Task 1.2: Define new collection schemas and accessors in mongodb-schema.ts

**Files:**

- Modify: `src/memory/mongodb-schema.ts`

**Step 1: Add collection accessor functions**

After the existing collection helpers (after line 74), add:

```typescript
export function eventsCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "events");
}
export function entitiesCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "entities");
}
export function relationsCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "relations");
}
export function episodesCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "episodes");
}
export function ingestRunsCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "ingest_runs");
}
export function projectionRunsCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "projection_runs");
}
```

**Step 2: Add JSON Schema validators for each new collection**

Follow the existing `CHUNKS_SCHEMA` / `STRUCTURED_MEM_SCHEMA` pattern. Define:

- `EVENTS_SCHEMA`: required fields `eventId`, `agentId`, `role`, `body`, `scope`, `timestamp`
- `ENTITIES_SCHEMA`: required fields `entityId`, `name`, `type`, `agentId`, `scope`, `updatedAt`
- `RELATIONS_SCHEMA`: required fields `fromEntityId`, `toEntityId`, `type`, `agentId`, `scope`, `updatedAt`
- `EPISODES_SCHEMA`: required fields `episodeId`, `type`, `title`, `summary`, `agentId`, `scope`, `timeRange`, `sourceEventCount`, `updatedAt`
- `INGEST_RUNS_SCHEMA`: required fields `runId`, `agentId`, `source`, `status`, `itemsProcessed`, `itemsFailed`, `durationMs`, `ts`
- `PROJECTION_RUNS_SCHEMA`: required fields `runId`, `agentId`, `projectionType`, `status`, `itemsProjected`, `durationMs`, `ts`

Use exact types from design document. Use `bsonType` for all fields. `scope` should be an `enum` of the 6 scope values.

**Step 3: Register new collections in VALIDATED_COLLECTIONS and ensureCollections**

- Add all 6 new collection names to `VALIDATED_COLLECTIONS` map
- Add all 6 names to the `needed` array in `ensureCollections()`
- Keep the function signature the same — new collections are always created regardless of runtimeMode (schema preparation is cheap)

**Step 4: Write tests**

Extend `src/memory/mongodb-schema.test.ts`:

- Test: all new collection accessors return correct collection names
- Test: `VALIDATED_COLLECTIONS` now has entries for all 6 new collections
- Test: `ensureCollections` creates all expected collections (check expected count changed from 10 to 16)

**Step 5: Run tests**

Run: `pnpm test src/memory/mongodb-schema`
Expected: PASS

**Step 6: Commit**

```
feat(memory): add schema definitions and accessors for v2 collections
```

---

### Task 1.3: Add standard indexes for new collections

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (inside `ensureStandardIndexes`)

**Step 1: Add indexes after the existing relevance indexes section**

Events indexes:

```typescript
const events = eventsCollection(db, prefix);
await events.createIndex({ agentId: 1, timestamp: -1 }, { name: "idx_events_agent_ts" });
await events.createIndex({ eventId: 1 }, { name: "uq_events_eventid", unique: true });
await events.createIndex({ scope: 1, timestamp: -1 }, { name: "idx_events_scope_ts" });
await events.createIndex(
  { sessionId: 1, timestamp: -1 },
  { name: "idx_events_session_ts", sparse: true },
);
await events.createIndex({ projectedAt: 1 }, { name: "idx_events_projected", sparse: true });
```

Entities indexes:

```typescript
const entities = entitiesCollection(db, prefix);
await entities.createIndex({ entityId: 1 }, { name: "uq_entities_entityid", unique: true });
await entities.createIndex(
  { agentId: 1, type: 1, name: 1 },
  { name: "idx_entities_agent_type_name" },
);
await entities.createIndex({ name: "text", aliases: "text" }, { name: "idx_entities_text" });
```

Relations indexes:

```typescript
const relations = relationsCollection(db, prefix);
await relations.createIndex({ fromEntityId: 1, type: 1 }, { name: "idx_relations_from_type" });
await relations.createIndex({ toEntityId: 1 }, { name: "idx_relations_to" });
await relations.createIndex({ agentId: 1, scope: 1 }, { name: "idx_relations_agent_scope" });
```

Episodes indexes:

```typescript
const episodes = episodesCollection(db, prefix);
await episodes.createIndex({ episodeId: 1 }, { name: "uq_episodes_episodeid", unique: true });
await episodes.createIndex(
  { agentId: 1, type: 1, "timeRange.start": -1 },
  { name: "idx_episodes_agent_type_start" },
);
await episodes.createIndex({ summary: "text", title: "text" }, { name: "idx_episodes_text" });
```

Operational indexes:

```typescript
const ingestRuns = ingestRunsCollection(db, prefix);
await ingestRuns.createIndex({ agentId: 1, ts: -1 }, { name: "idx_ingestruns_agent_ts" });

const projectionRuns = projectionRunsCollection(db, prefix);
await projectionRuns.createIndex(
  { agentId: 1, projectionType: 1, ts: -1 },
  { name: "idx_projruns_agent_type_ts" },
);
```

Update the `applied` counter accordingly.

**Step 2: Add search indexes for events and episodes**

In `ensureSearchIndexes()`, after structured memory search indexes, add:

Events text + vector search indexes (text search on `body`, vector on `body`):

```typescript
const events = eventsCollection(db, prefix);
// text search index
// vector search index with autoEmbed on body
```

Episodes text + vector search indexes (text search on `summary`, vector on `summary`):

```typescript
const episodes = episodesCollection(db, prefix);
// text search index
// vector search index with autoEmbed on summary
```

Update the budget count from 6 to 10 (4 new search indexes).

**Step 3: Update schema test expected index count**

In `src/memory/mongodb-schema.test.ts`, update `EXPECTED_STANDARD_INDEX_COUNT` to the new total.
In `src/memory/mongodb-e2e.e2e.test.ts`, update `EXPECTED_STANDARD_INDEX_COUNT` and `EXPECTED_COLLECTION_SUFFIXES`.

**Step 4: Run tests**

Run: `pnpm test src/memory/mongodb-schema`
Expected: PASS

**Step 5: Commit**

```
feat(memory): add standard and search indexes for v2 collections
```

---

### Task 1.4: Add scope field to structured memory

**Files:**

- Modify: `src/memory/mongodb-structured-memory.ts`
- Modify: `src/memory/mongodb-schema.ts`

**Step 1: Add scope to StructuredMemoryEntry type**

In `src/memory/mongodb-structured-memory.ts`, add to `StructuredMemoryEntry`:

```typescript
scope?: MemoryScope;  // defaults to "agent" for backward compat
```

Import `MemoryScope` from `../config/types.memory.js`.

**Step 2: Update writeStructuredMemory to persist scope**

In `writeStructuredMemory()`:

- Add `scope: entry.scope ?? "agent"` to the `setDoc`
- The upsert filter remains `{ agentId, type, key }` for backward compatibility
  (v2 can use `{ agentId, scope, type, key }` when runtimeMode is `"mongo_v2"`)

**Step 3: Update STRUCTURED_MEM_SCHEMA to include scope**

In `mongodb-schema.ts`, add `scope` to the `STRUCTURED_MEM_SCHEMA` properties:

```typescript
scope: {
  enum: ["session", "user", "agent", "workspace", "tenant", "global"],
  description: "Memory scope. Default: agent",
},
```

Do NOT add `scope` to `required` (backward compat — existing docs lack scope).

**Step 4: Migrate the unique index when v2 is active**

In `ensureStandardIndexes()`, after the existing structured memory indexes, add a conditional v2 index. For now, just add the v2-aware unique index alongside the v1 one:

```typescript
// v2-ready: scope-aware unique index (superset of v1 index)
// Does not conflict with v1 index — different name, broader compound key
await structured.createIndex(
  { agentId: 1, scope: 1, type: 1, key: 1 },
  { name: "uq_structured_agent_scope_type_key", unique: true, sparse: true },
);
```

Use `sparse: true` so existing docs without `scope` are not affected.

**Step 5: Update searchStructuredMemory to accept scope filter**

In `searchStructuredMemory()`, add `scope?: MemoryScope` to the filter options. When provided, include `scope` in both the vector search filter and the `$text` match filter.

**Step 6: Write/extend tests**

In `src/memory/mongodb-structured-memory.test.ts`:

- Test: write with explicit scope, read back confirms scope persisted
- Test: write without scope, defaults to `"agent"`
- Test: search with scope filter returns only matching scope
- Test: same key in different scopes are distinct entries

**Step 7: Run tests**

Run: `pnpm test src/memory/mongodb-structured-memory`
Expected: PASS

**Step 8: Commit**

```
feat(memory): add formal scope field to structured memory
```

---

## Phase 2: Canonical Events and Chunk Projection

> **Exit Criteria:** Events can be written and read. Chunks are derived from events. Backfill from v1 chunks to events works.

### Task 2.1: Implement canonical events module

**Files:**

- Create: `src/memory/mongodb-events.ts`
- Create: `src/memory/mongodb-events.test.ts`

**Step 1: Write failing test**

Create `src/memory/mongodb-events.test.ts`:

- Test: `writeEvent` inserts an event and returns the eventId
- Test: `writeEvent` with duplicate eventId is idempotent (upsert or skip)
- Test: `getEventsByTimeRange` returns events in timestamp order
- Test: `getEventsBySession` filters by sessionId
- Test: `getUnprojectedEvents` returns events where `projectedAt` is null
- Test: `markEventsProjected` sets `projectedAt` on given eventIds

**Step 2: Implement mongodb-events.ts**

```typescript
// src/memory/mongodb-events.ts
import { randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { eventsCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:events");

export type CanonicalEvent = {
  eventId: string;
  agentId: string;
  sessionId?: string;
  channel?: string;
  role: "user" | "assistant" | "system" | "tool";
  body: string;
  metadata?: Record<string, unknown>;
  scope: MemoryScope;
  timestamp: Date;
  projectedAt?: Date;
};

export async function writeEvent(params: {
  db: Db;
  prefix: string;
  event: Omit<CanonicalEvent, "eventId" | "timestamp"> & {
    eventId?: string;
    timestamp?: Date;
  };
}): Promise<{ eventId: string }> {
  const { db, prefix, event } = params;
  const collection = eventsCollection(db, prefix);
  const eventId = event.eventId ?? randomUUID();
  const timestamp = event.timestamp ?? new Date();

  const doc: CanonicalEvent = {
    eventId,
    agentId: event.agentId,
    role: event.role,
    body: event.body,
    scope: event.scope ?? "agent",
    timestamp,
    ...(event.sessionId && { sessionId: event.sessionId }),
    ...(event.channel && { channel: event.channel }),
    ...(event.metadata && { metadata: event.metadata }),
  };

  await collection.updateOne({ eventId }, { $setOnInsert: doc }, { upsert: true });

  log.info(`event written: ${eventId} role=${event.role}`);
  return { eventId };
}

export async function getEventsByTimeRange(params: {
  db: Db;
  prefix: string;
  agentId: string;
  start: Date;
  end: Date;
  scope?: MemoryScope;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, start, end, scope, limit } = params;
  const collection = eventsCollection(db, prefix);
  const filter: Document = {
    agentId,
    timestamp: { $gte: start, $lte: end },
  };
  if (scope) filter.scope = scope;

  return (await collection
    .find(filter)
    .sort({ timestamp: 1 })
    .limit(limit ?? 1000)
    .toArray()) as unknown as CanonicalEvent[];
}

export async function getEventsBySession(params: {
  db: Db;
  prefix: string;
  agentId: string;
  sessionId: string;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, sessionId, limit } = params;
  const collection = eventsCollection(db, prefix);
  return (await collection
    .find({ agentId, sessionId })
    .sort({ timestamp: 1 })
    .limit(limit ?? 1000)
    .toArray()) as unknown as CanonicalEvent[];
}

export async function getUnprojectedEvents(params: {
  db: Db;
  prefix: string;
  agentId: string;
  limit?: number;
}): Promise<CanonicalEvent[]> {
  const { db, prefix, agentId, limit } = params;
  const collection = eventsCollection(db, prefix);
  return (await collection
    .find({ agentId, projectedAt: { $exists: false } })
    .sort({ timestamp: 1 })
    .limit(limit ?? 500)
    .toArray()) as unknown as CanonicalEvent[];
}

export async function markEventsProjected(params: {
  db: Db;
  prefix: string;
  eventIds: string[];
}): Promise<number> {
  const { db, prefix, eventIds } = params;
  if (eventIds.length === 0) return 0;
  const collection = eventsCollection(db, prefix);
  const result = await collection.updateMany(
    { eventId: { $in: eventIds } },
    { $set: { projectedAt: new Date() } },
  );
  return result.modifiedCount;
}
```

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-events`
Expected: PASS

**Step 4: Commit**

```
feat(memory): implement canonical events collection module
```

---

### Task 2.2: Implement chunk projection from events

**Files:**

- Modify: `src/memory/mongodb-events.ts` (add `projectChunksFromEvents`)
- Extend: `src/memory/mongodb-events.test.ts`

**Step 1: Write failing test**

Add to `src/memory/mongodb-events.test.ts`:

- Test: `projectChunksFromEvents` reads unprojected events, creates chunks, marks events projected
- Test: `projectChunksFromEvents` with zero unprojected events is a no-op
- Test: projected chunks have correct `source: "events"` and `path` referencing eventId

**Step 2: Implement projectChunksFromEvents**

This function:

1. Calls `getUnprojectedEvents` to get batch
2. For each event, creates a chunk document in the chunks collection (using existing chunk schema: `path`, `text`, `hash`, `source`, `updatedAt`)
3. Calls `markEventsProjected` for the batch
4. Returns `{ eventsProcessed: number, chunksCreated: number }`

The chunk `path` should be `events/${eventId}` and `source` should be `"conversation"` (to fit the existing source vocabulary). The `text` is the event body. The `hash` is a content hash of the body.

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-events`
Expected: PASS

**Step 4: Commit**

```
feat(memory): add chunk projection from canonical events
```

---

### Task 2.3: Implement migration backfill (v1 chunks to events)

**Files:**

- Create: `src/memory/mongodb-migration.ts`
- Create: `src/memory/mongodb-migration.test.ts`

**Step 1: Write failing test**

Create `src/memory/mongodb-migration.test.ts`:

- Test: `backfillEventsFromChunks` reads existing chunks with `source: "memory"` or `"sessions"`, creates events
- Test: backfill is idempotent (re-running doesn't duplicate events)
- Test: backfill preserves chunk text as event body
- Test: backfill sets `scope: "agent"` as default
- Test: backfill reports `{ eventsCreated, chunksProcessed, skipped }`

**Step 2: Implement mongodb-migration.ts**

```typescript
// src/memory/mongodb-migration.ts
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { chunksCollection, eventsCollection } from "./mongodb-schema.js";
import type { CanonicalEvent } from "./mongodb-events.js";

const log = createSubsystemLogger("memory:mongodb:migration");

export async function backfillEventsFromChunks(params: {
  db: Db;
  prefix: string;
  agentId: string;
  batchSize?: number;
}): Promise<{ eventsCreated: number; chunksProcessed: number; skipped: number }> {
  // Read all conversation chunks (source: "memory" or "sessions")
  // For each, create a canonical event if no event with matching hash exists
  // Use chunk.updatedAt as timestamp, chunk.text as body
  // Generate deterministic eventId from chunk hash to ensure idempotency
  ...
}
```

Key implementation details:

- Generate deterministic `eventId` from `createHash("sha256").update(chunk.path + chunk.hash).digest("hex").slice(0, 32)` for idempotency
- Set `role: "user"` as default (best-effort reconstruction)
- Set `scope: "agent"` as default
- Process in batches of `batchSize` (default 100) for memory safety
- Use `bulkWrite` with `updateOne` + `upsert: true` for efficiency and idempotency

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-migration`
Expected: PASS

**Step 4: Commit**

```
feat(memory): add v1-to-v2 event backfill migration
```

---

## Phase 3: Source Policy Enforcement

> **Exit Criteria:** Cache keys include source config. Source policy changes invalidate cached managers. Search respects per-agent source policy.

### Task 3.1: Fix source policy leak in search-manager cache key

**Files:**

- Modify: `src/memory/search-manager.ts`
- Modify or create: `src/memory/search-manager.test.ts`

**Step 1: Write failing test**

- Test: two configs with different `sources` produce different cache keys
- Test: same config produces same cache key (stability)

**Step 2: Fix buildMongoDBCacheKey**

The current `stableSerialize(config)` already serializes the full `ResolvedMongoDBConfig` which includes `sources`. However, the `sources` field was added in the previous iteration and the cache key is based on the resolved config. Verify that `sources` is included in serialization.

If sources is already included (which it should be since `stableSerialize` serializes all keys), then the fix is verified as already working. Document this explicitly with a comment.

If not included (e.g., if the config is partially serialized), add `sources` to the serialization explicitly.

Additionally, add a comment making the intent explicit:

```typescript
// IMPORTANT: stableSerialize includes sources config in the cache key.
// Changing source policy (reference/conversation/structured enabled/disabled)
// at runtime will produce a different cache key, ensuring no stale managers.
```

**Step 3: Run tests**

Run: `pnpm test src/memory/search-manager`
Expected: PASS

**Step 4: Commit**

```
fix(memory): document and verify source policy in cache key
```

---

### Task 3.2: Enforce source policy in retrieval paths

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**Step 1: Identify all search paths in mongodb-manager.ts**

The `search()` method currently calls:

- `mongoSearch()` for hybrid chunk search
- `searchStructuredMemory()` for structured search
- Then merges results

Each path must check whether its source is enabled before executing.

**Step 2: Add source policy guards**

In the `search()` method of `MongoDBMemoryManager`:

```typescript
// Before hybrid chunk search:
const conversationEnabled = this.resolved.mongodb?.sources.conversation.enabled !== false;
const referenceEnabled = this.resolved.mongodb?.sources.reference.enabled !== false;
const structuredEnabled = this.resolved.mongodb?.sources.structured.enabled !== false;

// Skip chunk search if neither conversation nor reference is enabled
// Skip structured search if structured is not enabled
// Skip KB search if reference is not enabled
```

**Step 3: Update status() to report active sources**

In the `status()` method, ensure the reported `sources` array only lists sources that are actually enabled.

**Step 4: Write tests**

In `src/memory/mongodb-manager.test.ts`:

- Test: search with `conversation.enabled: false` skips chunk results
- Test: search with `structured.enabled: false` skips structured results
- Test: status reports correct active sources

**Step 5: Run tests**

Run: `pnpm test src/memory/mongodb-manager`
Expected: PASS

**Step 6: Commit**

```
fix(memory): enforce source policy end-to-end in retrieval
```

---

## Phase 4: Graph Projection

> **Exit Criteria:** Entities and relations can be created, updated, queried. `$graphLookup` returns connected subgraphs.

### Task 4.1: Implement graph module

**Files:**

- Create: `src/memory/mongodb-graph.ts`
- Create: `src/memory/mongodb-graph.test.ts`

**Step 1: Write failing tests**

Create `src/memory/mongodb-graph.test.ts`:

- Test: `upsertEntity` creates a new entity
- Test: `upsertEntity` updates existing entity (same entityId)
- Test: `upsertRelation` creates a relation between two entities
- Test: `findEntitiesByName` returns matching entities (text search)
- Test: `expandGraph` uses `$graphLookup` to find connected entities within maxDepth
- Test: `expandGraph` respects agentId filter
- Test: `getEntitiesByType` returns all entities of a given type
- Test: `deleteEntity` removes entity and its relations

**Step 2: Implement mongodb-graph.ts**

```typescript
// src/memory/mongodb-graph.ts
import type { Db, Document } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { entitiesCollection, relationsCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:graph");

export type EntityType = "person" | "org" | "project" | "topic" |
  "feature" | "issue" | "document" | "custom";

export type Entity = {
  entityId: string;
  name: string;
  type: EntityType;
  aliases?: string[];
  agentId: string;
  scope: MemoryScope;
  metadata?: Record<string, unknown>;
  sourceEventIds?: string[];
  updatedAt: Date;
};

export type RelationType = "works_on" | "owns" | "depends_on" | "blocked_by" |
  "decided" | "mentioned_with" | "reported_by" | "related_to";

export type Relation = {
  fromEntityId: string;
  toEntityId: string;
  type: RelationType;
  weight?: number;
  agentId: string;
  scope: MemoryScope;
  sourceEventIds?: string[];
  updatedAt: Date;
};

export type GraphExpansionResult = {
  rootEntity: Entity;
  connections: Array<{
    entity: Entity;
    relation: Relation;
    depth: number;
  }>;
};

export async function upsertEntity(params: {
  db: Db; prefix: string; entity: Entity;
}): Promise<{ upserted: boolean }> { ... }

export async function upsertRelation(params: {
  db: Db; prefix: string; relation: Relation;
}): Promise<{ upserted: boolean }> { ... }

export async function findEntitiesByName(params: {
  db: Db; prefix: string; query: string; agentId: string;
  limit?: number;
}): Promise<Entity[]> { ... }

export async function getEntitiesByType(params: {
  db: Db; prefix: string; type: EntityType; agentId: string;
  limit?: number;
}): Promise<Entity[]> { ... }

export async function expandGraph(params: {
  db: Db; prefix: string; entityId: string; agentId: string;
  maxDepth?: number;
}): Promise<GraphExpansionResult | null> {
  // 1. Find root entity
  // 2. $graphLookup on relations collection
  //    startWith: "$entityId"
  //    connectFromField: relation's toEntityId
  //    connectToField: fromEntityId
  //    maxDepth: params.maxDepth ?? 2
  //    restrictSearchWithMatch: { agentId }
  // 3. For each connected relation, look up the target entity
  // 4. Return structured result
  ...
}

export async function deleteEntity(params: {
  db: Db; prefix: string; entityId: string;
}): Promise<{ deletedEntity: boolean; deletedRelations: number }> { ... }
```

The `$graphLookup` implementation:

```typescript
// Graph expansion using $graphLookup on the relations collection
// Relations are stored with fromEntityId/toEntityId as edges
// We start from the root entity's entityId and follow edges outward
const pipeline: Document[] = [
  { $match: { entityId: params.entityId } },
  {
    $graphLookup: {
      from: `${prefix}relations`,
      startWith: "$entityId",
      connectFromField: "toEntityId", // follow the edge target
      connectToField: "fromEntityId", // match against edge source
      as: "reachableRelations",
      maxDepth: params.maxDepth ?? 2,
      depthField: "depth",
      restrictSearchWithMatch: { agentId: params.agentId },
    },
  },
];
```

**Note:** `$graphLookup` does recursive self-joins on a single collection. Since relations and entities are in separate collections, we run `$graphLookup` on the relations collection to find all reachable edges, then use `$lookup` to resolve entity details for the connected entityIds.

Alternative approach (simpler, may be needed):

```typescript
// Run $graphLookup on relations collection directly
const relPipeline = [
  { $match: { fromEntityId: params.entityId, agentId: params.agentId } },
  {
    $graphLookup: {
      from: `${prefix}relations`,
      startWith: "$toEntityId",
      connectFromField: "toEntityId",
      connectToField: "fromEntityId",
      as: "transitiveRelations",
      maxDepth: (params.maxDepth ?? 2) - 1,
      depthField: "depth",
      restrictSearchWithMatch: { agentId: params.agentId },
    },
  },
];
```

The builder should choose the approach that works correctly with MongoDB 8.2 `$graphLookup` semantics. Test both approaches and use whichever returns correct results.

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-graph`
Expected: PASS

**Step 4: Commit**

```
feat(memory): implement graph projection with $graphLookup
```

---

## Phase 5: Episode Materialization

> **Exit Criteria:** Episodes can be materialized from raw events. Episode search returns relevant summaries.

### Task 5.1: Implement episode module

**Files:**

- Create: `src/memory/mongodb-episodes.ts`
- Create: `src/memory/mongodb-episodes.test.ts`

**Step 1: Write failing tests**

Create `src/memory/mongodb-episodes.test.ts`:

- Test: `materializeEpisode` creates an episode from a time range of events
- Test: `materializeEpisode` stores `sourceEventCount` and sample `sourceEventIds`
- Test: `getEpisodesByTimeRange` returns episodes overlapping the range
- Test: `getEpisodesByType` returns episodes of a given type
- Test: `searchEpisodes` uses text search on summary/title
- Test: duplicate materialization for same time range updates existing episode (idempotent)

**Step 2: Implement mongodb-episodes.ts**

```typescript
// src/memory/mongodb-episodes.ts
import { randomUUID } from "node:crypto";
import type { Db, Document, Collection } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { episodesCollection } from "./mongodb-schema.js";
import { getEventsByTimeRange } from "./mongodb-events.js";

const log = createSubsystemLogger("memory:mongodb:episodes");

export type EpisodeType = "daily" | "weekly" | "thread" | "topic" | "decision";

export type Episode = {
  episodeId: string;
  type: EpisodeType;
  title: string;
  summary: string;
  agentId: string;
  scope: MemoryScope;
  timeRange: { start: Date; end: Date };
  sourceEventCount: number;
  sourceEventIds?: string[];
  tags?: string[];
  updatedAt: Date;
};

// Summarizer function type — allows injection of LLM or mock summarizer
export type EpisodeSummarizer = (events: Array<{ role: string; body: string; timestamp: Date }>) => Promise<{
  title: string;
  summary: string;
  tags?: string[];
}>;

export async function materializeEpisode(params: {
  db: Db;
  prefix: string;
  agentId: string;
  type: EpisodeType;
  timeRange: { start: Date; end: Date };
  scope?: MemoryScope;
  summarizer: EpisodeSummarizer;
}): Promise<Episode | null> {
  // 1. Read raw events for the time range
  // 2. If fewer than minEventsForEpisode (default 2 for materialize), return null
  // 3. Call summarizer with ordered events
  // 4. Upsert episode document
  // 5. Return the episode
  ...
}

export async function getEpisodesByTimeRange(params: {
  db: Db; prefix: string; agentId: string;
  start: Date; end: Date;
  type?: EpisodeType;
}): Promise<Episode[]> { ... }

export async function getEpisodesByType(params: {
  db: Db; prefix: string; agentId: string;
  type: EpisodeType; limit?: number;
}): Promise<Episode[]> { ... }

export async function searchEpisodes(params: {
  db: Db; prefix: string; query: string; agentId: string;
  limit?: number;
}): Promise<Episode[]> {
  // Use $text search on summary + title
  ...
}
```

The `summarizer` is injected to keep the module testable. In tests, use a mock that returns a fixed summary. In production, wire to the agent's LLM call.

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-episodes`
Expected: PASS

**Step 4: Commit**

```
feat(memory): implement episode materialization from raw events
```

---

## Phase 6: Operational Collections

> **Exit Criteria:** Ingest runs and projection runs can be recorded and queried for operational observability.

### Task 6.1: Implement operational module

**Files:**

- Create: `src/memory/mongodb-ops.ts`
- Create: `src/memory/mongodb-ops.test.ts`

**Step 1: Write failing tests**

Create `src/memory/mongodb-ops.test.ts`:

- Test: `recordIngestRun` inserts an ingest run document
- Test: `recordProjectionRun` inserts a projection run document
- Test: `getRecentIngestRuns` returns runs sorted by ts descending
- Test: `getRecentProjectionRuns` filters by projectionType
- Test: `getProjectionLag` returns seconds since last successful projection of a given type

**Step 2: Implement mongodb-ops.ts**

```typescript
// src/memory/mongodb-ops.ts
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ingestRunsCollection, projectionRunsCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:ops");

export type IngestSource = "file-sync" | "session-sync" | "kb-import" | "manual" | "event-write";
export type RunStatus = "ok" | "partial" | "failed";
export type ProjectionType = "chunks" | "entities" | "relations" | "episodes";

export type IngestRun = {
  runId: string;
  agentId: string;
  source: IngestSource;
  status: RunStatus;
  itemsProcessed: number;
  itemsFailed: number;
  durationMs: number;
  ts: Date;
};

export type ProjectionRun = {
  runId: string;
  agentId: string;
  projectionType: ProjectionType;
  status: RunStatus;
  lag?: number;
  itemsProjected: number;
  durationMs: number;
  ts: Date;
};

export async function recordIngestRun(params: {
  db: Db; prefix: string; run: Omit<IngestRun, "runId" | "ts">;
}): Promise<string> { ... }

export async function recordProjectionRun(params: {
  db: Db; prefix: string; run: Omit<ProjectionRun, "runId" | "ts">;
}): Promise<string> { ... }

export async function getRecentIngestRuns(params: {
  db: Db; prefix: string; agentId: string; limit?: number;
}): Promise<IngestRun[]> { ... }

export async function getRecentProjectionRuns(params: {
  db: Db; prefix: string; agentId: string;
  projectionType?: ProjectionType; limit?: number;
}): Promise<ProjectionRun[]> { ... }

export async function getProjectionLag(params: {
  db: Db; prefix: string; agentId: string; projectionType: ProjectionType;
}): Promise<number | null> {
  // Find the most recent successful projection run of this type
  // Return seconds between now and that run's ts
  // Return null if no successful run exists
  ...
}
```

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-ops`
Expected: PASS

**Step 4: Commit**

```
feat(memory): implement operational collections for ingest and projection tracking
```

---

## Phase 7: Retrieval Planner

> **Exit Criteria:** Retrieval planner selects paths based on query shape. Planner integrates with MongoDBMemoryManager for v2 mode.

### Task 7.1: Implement retrieval planner

**Files:**

- Create: `src/memory/mongodb-retrieval-planner.ts`
- Create: `src/memory/mongodb-retrieval-planner.test.ts`

**Step 1: Write failing tests**

Create `src/memory/mongodb-retrieval-planner.test.ts`:

- Test: query with "remember that I prefer" -> structured first
- Test: query with "today" / "yesterday" / "last week" -> raw-window first
- Test: query with a person name + "what does X work on" -> graph first
- Test: generic recall query -> hybrid first
- Test: broad historical "summarize this month" -> episodic first
- Test: "what's in the docs about X" -> kb first
- Test: planner returns `confidence` and `reasoning`
- Test: planner respects source policy (disabled sources excluded from plan)
- Test: when multiple signals present, correct priority order

**Step 2: Implement mongodb-retrieval-planner.ts**

```typescript
// src/memory/mongodb-retrieval-planner.ts
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:planner");

export type RetrievalPath = "structured" | "raw-window" | "graph" | "hybrid" | "kb" | "episodic";

export type RetrievalPlan = {
  paths: RetrievalPath[];
  confidence: "high" | "medium" | "low";
  reasoning: string;
};

export type RetrievalContext = {
  /** Available sources based on config */
  availablePaths: Set<RetrievalPath>;
  /** Known entity names for graph matching */
  knownEntityNames?: string[];
  /** Whether episodes exist */
  hasEpisodes?: boolean;
  /** Whether graph has entities */
  hasGraphData?: boolean;
};

// Time-related keywords for raw-window detection
const TIME_KEYWORDS = [
  "today",
  "yesterday",
  "this morning",
  "this afternoon",
  "this evening",
  "last hour",
  "last week",
  "this week",
  "last month",
  "this month",
  "recent",
  "recently",
  "earlier today",
  "just now",
  "latest",
];

// Structured memory keywords
const STRUCTURED_KEYWORDS = [
  "prefer",
  "preference",
  "decision",
  "decided",
  "rule",
  "convention",
  "remember that",
  "my name",
  "i like",
  "i don't like",
  "always",
  "never",
  "todo",
  "task",
  "remind me",
];

// KB keywords
const KB_KEYWORDS = [
  "docs",
  "documentation",
  "reference",
  "manual",
  "guide",
  "how to",
  "instructions",
  "spec",
  "specification",
];

// Episodic / summary keywords
const EPISODIC_KEYWORDS = [
  "summarize",
  "summary",
  "overview",
  "recap",
  "what happened",
  "highlights",
  "review",
  "report on",
  "digest",
];

export function planRetrieval(query: string, context: RetrievalContext): RetrievalPlan {
  const lower = query.toLowerCase();
  const paths: RetrievalPath[] = [];
  const reasons: string[] = [];

  // Score each path
  const scores: Record<RetrievalPath, number> = {
    structured: 0,
    "raw-window": 0,
    graph: 0,
    hybrid: 0,
    kb: 0,
    episodic: 0,
  };

  // Check structured signals
  if (STRUCTURED_KEYWORDS.some((kw) => lower.includes(kw))) {
    scores.structured += 3;
    reasons.push("structured keywords detected");
  }

  // Check time signals
  if (TIME_KEYWORDS.some((kw) => lower.includes(kw))) {
    scores["raw-window"] += 3;
    reasons.push("time-related keywords detected");
  }

  // Check entity/graph signals
  if (context.knownEntityNames?.some((name) => lower.includes(name.toLowerCase()))) {
    scores.graph += 3;
    reasons.push("known entity name detected");
  }
  if (lower.includes("who") || lower.includes("relationship") || lower.includes("connected")) {
    scores.graph += 2;
    reasons.push("relationship query detected");
  }

  // Check KB signals
  if (KB_KEYWORDS.some((kw) => lower.includes(kw))) {
    scores.kb += 3;
    reasons.push("KB/documentation keywords detected");
  }

  // Check episodic signals
  if (EPISODIC_KEYWORDS.some((kw) => lower.includes(kw))) {
    scores.episodic += 3;
    reasons.push("episodic/summary keywords detected");
  }

  // Hybrid is always baseline
  scores.hybrid += 1;

  // Sort by score, filter by availability
  const sorted = (Object.entries(scores) as [RetrievalPath, number][])
    .filter(([path]) => context.availablePaths.has(path))
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);

  // Always include at least hybrid if available
  const finalPaths = sorted.length > 0 ? sorted : ["hybrid" as RetrievalPath];

  // Confidence based on signal strength
  const topScore = scores[finalPaths[0]] ?? 0;
  const confidence = topScore >= 3 ? "high" : topScore >= 2 ? "medium" : "low";

  return {
    paths: finalPaths,
    confidence,
    reasoning: reasons.length > 0 ? reasons.join("; ") : "no strong signals, defaulting to hybrid",
  };
}
```

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-retrieval-planner`
Expected: PASS

**Step 4: Commit**

```
feat(memory): implement heuristic retrieval planner for v2
```

---

## Phase 8: Wire v2 into MongoDBMemoryManager

> **Exit Criteria:** When `runtimeMode: "mongo_v2"`, the manager uses the retrieval planner, writes to events first, and supports graph/episodic retrieval. When `runtimeMode: "mongo_canonical"`, behavior is unchanged.

### Task 8.1: Wire v2 write path

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**Step 1: Add v2 write path in MongoDBMemoryManager**

In the `MongoDBMemoryManager` class:

1. Import `writeEvent`, `projectChunksFromEvents` from `./mongodb-events.js`
2. Import `recordIngestRun` from `./mongodb-ops.js`
3. Add a `runtimeMode` property from the resolved config
4. In the session/file sync path, when `runtimeMode === "mongo_v2"`:
   - Write to events first via `writeEvent()`
   - Then project chunks via `projectChunksFromEvents()`
   - Record the ingest run
5. When `runtimeMode === "mongo_canonical"`:
   - Keep existing behavior unchanged

Add a new method `writeEventAndProject()` that encapsulates the v2 write path:

```typescript
async writeEventAndProject(event: Omit<CanonicalEvent, "eventId" | "timestamp"> & {
  eventId?: string; timestamp?: Date;
}): Promise<{ eventId: string; chunksCreated: number }> {
  // 1. writeEvent
  // 2. projectChunksFromEvents (for this single event)
  // 3. recordIngestRun
  // Return result
}
```

**Step 2: Wire v2 into the sync path**

The existing `sync()` method calls `syncToMongoDB()`. For v2, the sync should:

- Still run `syncToMongoDB()` for file watching (the existing mechanism)
- But after syncing files, also run `projectChunksFromEvents()` to catch any events that were written but not yet projected

This is a lightweight addition. The main behavioral change is that `writeStructuredMemory` and the new `writeEventAndProject` become the primary write paths in v2.

**Step 3: Write test**

In `src/memory/mongodb-manager.test.ts`:

- Test: v2 mode `writeEventAndProject` creates event + chunk
- Test: v1 mode does not call event write

**Step 4: Run tests**

Run: `pnpm test src/memory/mongodb-manager`
Expected: PASS

**Step 5: Commit**

```
feat(memory): wire v2 event write path into MongoDBMemoryManager
```

---

### Task 8.2: Wire v2 retrieval path

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**Step 1: Add v2 retrieval in search()**

In the `search()` method of `MongoDBMemoryManager`, when `runtimeMode === "mongo_v2"`:

1. Import and call `planRetrieval()` to get the retrieval plan
2. Execute paths in the planned order:
   - `"structured"` -> call existing `searchStructuredMemory()`
   - `"raw-window"` -> call `getEventsByTimeRange()` and convert to `MemorySearchResult[]`
   - `"graph"` -> call `expandGraph()` if entity names found, convert to results
   - `"hybrid"` -> call existing `mongoSearch()`
   - `"kb"` -> call existing `searchKB()`
   - `"episodic"` -> call `searchEpisodes()` and convert to results
3. Merge and deduplicate results from all paths
4. Return with metadata about which paths were used

When `runtimeMode === "mongo_canonical"`:

- Keep existing behavior unchanged (no planner, existing hybrid + structured)

**Step 2: Add graph/episode context to search**

Before calling `planRetrieval()`, gather context:

- Check if graph has entities (quick count query)
- Check if episodes exist (quick count query)
- Get known entity names (cached, refreshed periodically)

Cache this context in the manager instance, refresh on sync or every N searches.

**Step 3: Expose retrieval plan in search results**

Add to `MemorySearchResult` or return metadata alongside:

```typescript
type V2SearchMetadata = {
  plan: RetrievalPlan;
  pathsExecuted: RetrievalPath[];
  resultsByPath: Record<RetrievalPath, number>;
};
```

For now, log the metadata. Surface it via `status()` or a new method later.

**Step 4: Write tests**

In `src/memory/mongodb-manager.test.ts`:

- Test: v2 search with time query hits raw-window path
- Test: v2 search with entity name hits graph path
- Test: v1 search ignores planner entirely

**Step 5: Run tests**

Run: `pnpm test src/memory/mongodb-manager`
Expected: PASS

**Step 6: Commit**

```
feat(memory): wire v2 retrieval planner into search path
```

---

### Task 8.3: Extend status() for v2 health

**Files:**

- Modify: `src/memory/mongodb-manager.ts`
- Modify: `src/memory/types.ts`

**Step 1: Extend MemoryProviderStatus type**

In `src/memory/types.ts`, add v2-specific fields to `MemoryProviderStatus`:

```typescript
v2?: {
  runtimeMode: "mongo_v2";
  events?: { count: number; latestTimestamp?: Date };
  entities?: { count: number };
  relations?: { count: number };
  episodes?: { count: number; latestTimestamp?: Date };
  projectionLag?: Record<string, number | null>;
  retrievalPaths: string[];
};
```

**Step 2: Populate v2 status in status()**

When `runtimeMode === "mongo_v2"`, gather:

- Event count + latest timestamp
- Entity/relation counts
- Episode count + latest
- Projection lag per type
- Available retrieval paths

**Step 3: Run tests**

Run: `pnpm test src/memory/mongodb-manager`
Expected: PASS

**Step 4: Commit**

```
feat(memory): extend status() with v2 health metrics
```

---

## Phase 9: End-to-End Tests

> **Exit Criteria:** All e2e scenarios from the design document pass against a real MongoDB instance.

### Task 9.1: Add v2 e2e test scenarios

**Files:**

- Modify: `src/memory/mongodb-e2e.e2e.test.ts`

**Step 1: Add event->chunk projection e2e test**

```typescript
describe("v2: event -> chunk projection", () => {
  it("writes event, projects chunk, retrieves via search", async () => {
    // 1. writeEvent with body text
    // 2. projectChunksFromEvents
    // 3. Verify chunk exists in chunks collection with correct source
    // 4. Verify text search finds the chunk
  });
});
```

**Step 2: Add structured memory scope e2e test**

```typescript
describe("v2: structured memory with scope", () => {
  it("writes structured entries with different scopes, searches respect scope", async () => {
    // 1. Write structured entry with scope "user"
    // 2. Write structured entry with scope "session"
    // 3. Search with scope "user" -> only user-scoped result
    // 4. Search without scope filter -> both results
  });
});
```

**Step 3: Add graph expansion e2e test**

```typescript
describe("v2: graph expansion", () => {
  it("creates entities and relations, expands graph via $graphLookup", async () => {
    // 1. Create entity "Rom" (person)
    // 2. Create entity "ClawMongo" (project)
    // 3. Create relation Rom -> works_on -> ClawMongo
    // 4. expandGraph from "Rom" -> finds ClawMongo connection
  });
});
```

**Step 4: Add episode materialization e2e test**

```typescript
describe("v2: episode materialization", () => {
  it("writes events, materializes daily episode, searches episode", async () => {
    // 1. Write 5 events over a day
    // 2. materializeEpisode with mock summarizer
    // 3. Verify episode created with correct sourceEventCount
    // 4. searchEpisodes finds the episode
  });
});
```

**Step 5: Add migration backfill e2e test**

```typescript
describe("v2: migration backfill", () => {
  it("backfills events from existing v1 chunks", async () => {
    // 1. Insert chunks directly (simulating v1 state)
    // 2. Run backfillEventsFromChunks
    // 3. Verify events created with correct body/timestamp
    // 4. Run backfill again -> no duplicates (idempotent)
  });
});
```

**Step 6: Add source policy e2e test**

```typescript
describe("v2: source policy enforcement", () => {
  it("respects disabled sources in retrieval", async () => {
    // 1. Create manager with conversation.enabled: false
    // 2. Write chunks (conversation source)
    // 3. Search -> no conversation results returned
  });
});
```

**Step 7: Run e2e tests**

Run: `MONGODB_TEST_URI=mongodb://localhost:27117 pnpm test src/memory/mongodb-e2e.e2e.test.ts`
Expected: PASS

**Step 8: Commit**

```
test(memory): add v2 e2e test scenarios for all new subsystems
```

---

## Phase 10: Integration and Final Validation

> **Exit Criteria:** All unit and e2e tests pass. Build succeeds. No regressions in v1 mode.

### Task 10.1: Full test suite run and build check

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

**Step 2: Run build**

Run: `pnpm build`
Expected: Build succeeds, no TypeScript errors

**Step 3: Run lint/format**

Run: `pnpm check`
Expected: No lint errors

**Step 4: Commit any fixes**

```
chore(memory): fix lint/type issues from v2 integration
```

### Task 10.2: Update exports and module index

**Files:**

- Modify: `src/memory/index.ts` (if it exports memory modules)

**Step 1: Add exports for new modules**

Ensure all new public APIs are exported:

- `mongodb-events.ts` exports
- `mongodb-graph.ts` exports
- `mongodb-episodes.ts` exports
- `mongodb-retrieval-planner.ts` exports
- `mongodb-ops.ts` exports
- `mongodb-migration.ts` exports

**Step 2: Verify no circular imports**

Run: `pnpm build`
Expected: No circular dependency warnings

**Step 3: Commit**

```
feat(memory): export v2 modules from memory index
```

---

## Risks

| Risk                                                       | P   | I   | Score | Mitigation                                                                                                                      |
| ---------------------------------------------------------- | --- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `$graphLookup` cross-collection limitation                 | 3   | 3   | 9     | Use `$graphLookup` on relations only, then `$lookup` entities separately                                                        |
| Schema validation rejects existing docs on upgrade         | 2   | 4   | 8     | Use `validationLevel: moderate` (validates on insert/update, not existing docs). New fields like `scope` are optional in schema |
| Retrieval planner heuristics miss important query patterns | 3   | 2   | 6     | Start with conservative defaults, add patterns based on production data. Hybrid is always fallback                              |
| Backfill migration loses metadata (role, channel)          | 3   | 2   | 6     | Document best-effort nature. Default to `role: "user"`, `scope: "agent"`. Original chunk text preserved                         |
| Search index budget exceeded with 4 new indexes            | 2   | 3   | 6     | Self-managed profile has no hard limit. Add events/episodes indexes only when v2 enabled                                        |
| Event write failure blocks conversation flow               | 2   | 5   | 10    | Fail fast on event write (design decision). Monitor via ingest_runs. Operator can fall back to v1 mode                          |
| Performance regression from dual-write (events + chunks)   | 2   | 3   | 6     | Chunk projection is batched. Events write is a single insert. Monitor via projection_runs                                       |

---

## Success Criteria

- [ ] All new collections created with JSON Schema validation
- [ ] Canonical events are primary write target in v2 mode
- [ ] Chunks derived from events in v2 mode
- [ ] Structured memory has formal `scope` field
- [ ] Source policy enforced end-to-end
- [ ] Retrieval planner routes queries through all 6 paths
- [ ] `$graphLookup` returns connected subgraphs
- [ ] Episode materialization produces summaries from raw events
- [ ] Migration backfill creates events from v1 chunks
- [ ] All unit tests pass
- [ ] All e2e tests pass
- [ ] Build succeeds
- [ ] v1 mode behavior unchanged (regression-free)
