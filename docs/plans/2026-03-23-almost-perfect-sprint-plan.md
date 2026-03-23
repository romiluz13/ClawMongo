# Almost Perfect Sprint Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD. Each phase extends `production-readiness.e2e.test.ts` and MUST NOT break the existing 66 tests.
> **Research:** See `docs/research/2026-03-23-almost-perfect-mongodb-docs.md` for MongoDB capability verification.

**Goal:** Implement 8 harmony-filtered memory improvements that are MongoDB-native, zero-risk to the existing 66 production-readiness tests, and verified against official MongoDB 8.2 documentation.

**Architecture:** Extend existing standalone-function pattern (db, prefix, ...) with new functions in existing modules. One new collection (`memory_mutations`), schema additions to existing collections, and prompt-engineering changes for entity extraction. All features are additive -- no breaking changes.

**Tech Stack:** TypeScript ESM, MongoDB 8.2 (community + mongot), Vitest, Voyage AI (autoEmbed)

**Prerequisites:** All 66 production-readiness.e2e.test.ts tests pass. MongoDB 8.2 with mongot available via atlas-local:preview.

---

## Plan Mode

- Plan mode: `execution_plan`
- Verification rigor: `critical_path`

## Requirements Snapshot

1. **Tiered Token-Efficient Retrieval** -- `$project` after `$vectorSearch` to return IDs+scores first, full content on demand
2. **Mutation Audit Trail** -- Application-level audit records for structured_mem/entity/relation writes with before/after snapshots
3. **Status Lifecycle** -- `status` field on episodes and chunks (active/archived/deleted) with retrieval filter
4. **Procedural Memory Evolution** -- Version tracking, success/fail counts, and bounded evolution history on procedures
5. **Conservative Graph Deletion** -- Conflict detection before graph entity/relation deletion, audit trail integration
6. **Working Memory Bounds** -- Configurable capacity limit on session event queries with `$sort + $limit` optimization
7. **Temporal Grounding** -- Date/time extraction in entity extractor prompts + `extractedAt` field on entities
8. **Role-Based Memory Extraction** -- Separate extraction prompts for user vs assistant events + `sourceRole` field on entities

## Constraints Snapshot

- MongoDB-native only (no external graph/vector DB)
- Zero risk to existing 66 production-readiness e2e tests
- Every feature verified against MongoDB 8.2 official docs
- Must extend `production-readiness.e2e.test.ts` with new Phase 14+
- Standalone function pattern (db, prefix, ...) -- not class methods
- Idempotent upserts with $setOnInsert for creation-time fields
- All new schema fields are optional (backward compatible)
- TypeScript strict typing, no `any`

## In Scope

- 8 features listed above
- New `memory_mutations` collection + schema + indexes
- Schema additions to: `procedures`, `episodes`, `chunks`, `entities`
- New functions in existing modules
- New Phase 14-21 in production-readiness.e2e.test.ts (one phase per feature)
- Barrel exports from `src/memory/index.ts`

## Out Of Scope

- ACT-R vitality, LLM mutation arbitration, RMH paradigm
- Q-value learning, LinUCB, co-occurrence auto-generation
- Emotional valence scoring
- Changes to searchV2 signature (only internal behavior changes)
- Changes to existing test assertions (zero regression)
- Vector search index definition changes (status filter deferred to when search indexes rebuilt)

## Open Decisions

None -- all pre-answered by research and verification.

## Differences From Agreement

None.

## Recommended Defaults

- Working memory bound: 50 events (matches research recommendation, configurable)
- Mutation audit TTL: 90 days (7776000 seconds)
- Evolution history cap: 20 entries per procedure ($push + $slice: -20)
- Status lifecycle default: "active" (backward compatible)

---

## Critical-Path Verification Design

### Behavior Contract

Each feature MUST satisfy:

1. **Additive only** -- no existing collection schemas modified in breaking ways; all new fields optional
2. **Idempotent** -- all write operations safe to retry
3. **Isolated** -- each feature testable independently; no cross-feature coupling in Phase 14+
4. **Observable** -- each feature emits telemetry via `emitTelemetry`
5. **Bounded** -- no unbounded arrays or queries; all arrays capped, all queries limited

### Edge-Case Catalog

| Feature               | Edge Case                             | Mitigation                                                 |
| --------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Tiered retrieval      | Empty results from $vectorSearch      | Return empty array, no expand step                         |
| Tiered retrieval      | getEpisodesByIds with 0 IDs           | Early return, no DB call                                   |
| Mutation audit        | oldValue is null (new insert)         | Record operation as "create", oldValue: null               |
| Mutation audit        | Concurrent writes to same doc         | Each mutation gets unique mutationId (randomUUID)          |
| Status lifecycle      | Episodes without status field         | Default to "active" in queries via `$ne: "deleted"` filter |
| Status lifecycle      | Archived episodes in time range query | `$ne: "deleted"` filter excludes only deleted              |
| Procedural evolution  | Procedure at version 0 (new)          | $setOnInsert sets version: 1, evolutionHistory: []         |
| Procedural evolution  | evolutionHistory at cap (20)          | $push + $slice: -20 keeps bounded                          |
| Conservative deletion | Entity not found                      | Return { deletedEntity: false, deletedRelations: 0 }       |
| Conservative deletion | Entity has 0 relations                | Skip conflict check, proceed with delete                   |
| Working memory bounds | bound=0                               | Clamp to minimum 1                                         |
| Working memory bounds | Fewer events than bound               | Return all events                                          |
| Temporal grounding    | No dates in text                      | No temporal entities extracted, no error                   |
| Role-based extraction | role="system" or "tool"               | Fall through to user prompt (safe default)                 |

### Provable Properties

1. `recordMutation` always writes to `memory_mutations` collection with TTL index -- never grows unbounded
2. `evolutionHistory.length <= 20` enforced by `$push` + `$slice: -20`
3. `workingMemoryBound >= 1` enforced by `Math.max(1, bound)` clamp
4. All `status` queries use `{ status: { $ne: "deleted" } }` -- never return deleted records
5. `sourceRole` is always `"user"` or `"assistant"` -- validated before write

### Purity Boundary Map

| Module                      | Pure Functions                  | IO Functions                       |
| --------------------------- | ------------------------------- | ---------------------------------- |
| mongodb-mutations.ts        | buildMutationRecord             | recordMutation, getMutationHistory |
| mongodb-graph.ts            | existing pure fns               | deleteEntityConservative (new)     |
| mongodb-episodes.ts         | existing pure fns               | getEpisodesByIds (new)             |
| mongodb-events.ts           | existing pure fns               | getSessionEvents (new)             |
| mongodb-entity-extractor.ts | buildExtractionPrompt variants  | extract (existing)                 |
| mongodb-schema.ts           | MEMORY_MUTATIONS_SCHEMA (const) | ensureCollections (modified)       |

### Verification Strategy

- **Unit tests:** Each new function gets dedicated tests via TDD
- **E2e tests:** Phase 14-21 in production-readiness.e2e.test.ts (8 new phases)
- **Regression:** All 66 existing tests must pass after every phase
- **Index health:** New indexes verified via explain() in Phase 4 additions
- **Scale:** New features tested against 200+ event dataset from Phase 13

---

## Relevant Codebase Files

### Files to Modify

- `src/memory/mongodb-schema.ts` (lines 293-333, 570-610, 382-398, 698-748, 822-1220) -- Add MEMORY_MUTATIONS_SCHEMA, add status to EPISODES_SCHEMA/CHUNKS_SCHEMA, add evolution fields to PROCEDURES_SCHEMA, add sourceRole/extractedAt to ENTITIES_SCHEMA, add memory_mutations to ensureCollections/ensureStandardIndexes
- `src/memory/mongodb-graph.ts` (lines 768-800) -- Wrap deleteEntity with conflict detection + audit trail
- `src/memory/mongodb-episodes.ts` (lines 279-317) -- Add status filter + getEpisodesByIds
- `src/memory/mongodb-events.ts` (lines 40-60) -- Add getSessionEvents with working memory bound
- `src/memory/mongodb-entity-extractor.ts` (lines 170-265) -- Add role-based prompts + temporal grounding
- `src/memory/mongodb-manager.ts` (lines 2603-2660) -- Wire tiered retrieval projection mode into searchV2
- `src/memory/index.ts` -- Export new functions
- `src/memory/production-readiness.e2e.test.ts` -- Add Phase 14-21

### Files to Create

- `src/memory/mongodb-mutations.ts` -- Mutation audit trail module
- `src/memory/mongodb-mutations.test.ts` -- Unit tests for mutations

### Patterns to Follow

- `src/memory/mongodb-graph.ts` (lines 179-226) -- Standalone function pattern with db/prefix params
- `src/memory/mongodb-episodes.ts` (lines 98-273) -- Idempotent upsert with $setOnInsert
- `src/memory/mongodb-ops.ts` -- Simple CRUD module pattern
- `src/memory/mongodb-telemetry.ts` -- emitTelemetry fire-and-forget pattern

---

## Phase Plan

### Phase 1: Mutation Audit Trail (Foundation)

**ID:** P1-mutations
**Objective:** Create `memory_mutations` collection with application-level audit records. This comes first because later phases (conservative graph deletion) depend on it.

**Inputs:** Research item #2 (app-level audit trail)

**Files:**

- Create: `src/memory/mongodb-mutations.ts`
- Create: `src/memory/mongodb-mutations.test.ts`
- Modify: `src/memory/mongodb-schema.ts` -- Add MEMORY_MUTATIONS_SCHEMA + collection helper + ensureCollections entry + indexes
- Modify: `src/memory/index.ts` -- Export new functions

**Implementation Details:**

New collection schema `memory_mutations`:

```typescript
// Required fields
type MutationRecord = {
  mutationId: string; // randomUUID
  collectionName: string; // "structured_mem" | "entities" | "relations" | "procedures"
  documentId: string; // _id or entityId of the modified document
  operation: "create" | "update" | "delete";
  agentId: string;
  oldValue: Document | null; // null for creates
  newValue: Document | null; // null for deletes
  changedFields?: string[]; // field names that changed (for updates)
  timestamp: Date;
  actorRole?: "user" | "assistant" | "system";
};
```

New indexes:

- `{ agentId: 1, collectionName: 1, timestamp: -1 }` (compound query index)
- `{ timestamp: 1 }` with `expireAfterSeconds: 7776000` (90-day TTL)
- `{ documentId: 1, collectionName: 1, timestamp: -1 }` (per-document history)

New functions in `mongodb-mutations.ts`:

```typescript
export async function recordMutation(params: {
  db: Db;
  prefix: string;
  mutation: Omit<MutationRecord, "mutationId" | "timestamp">;
}): Promise<{ mutationId: string }>;

export async function getMutationHistory(params: {
  db: Db;
  prefix: string;
  agentId: string;
  collectionName?: string;
  documentId?: string;
  limit?: number;
  since?: Date;
}): Promise<MutationRecord[]>;
```

**Expected Artifacts:**

- `src/memory/mongodb-mutations.ts` with recordMutation + getMutationHistory
- `src/memory/mongodb-mutations.test.ts` with ~8 tests
- Updated schema in `mongodb-schema.ts`

**TDD Scenarios:**

1. `recordMutation` inserts a document into memory_mutations
2. `getMutationHistory` returns records filtered by agentId
3. `getMutationHistory` filters by collectionName
4. `getMutationHistory` filters by documentId
5. `getMutationHistory` respects limit
6. `getMutationHistory` respects since date
7. `recordMutation` with operation "create" stores oldValue as null
8. `recordMutation` with operation "delete" stores newValue as null

**E2E Test (Phase 14):**

```
Phase 14: Mutation Audit Trail
- records mutation on structured_mem write (verify count > 0)
- getMutationHistory returns correct collectionName filter
- mutation TTL index exists with expireAfterSeconds=7776000
- mutation records include changedFields for updates
```

**Required Checks:**

- `pnpm test -- src/memory/mongodb-mutations.test.ts` -- all pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 66 existing + 4 new pass

**Checkpoint:** None (straightforward CRUD)

**Exit Criteria:**

- memory_mutations collection created with schema validation
- recordMutation + getMutationHistory work with unit tests
- Phase 14 e2e tests pass
- 0 regressions in existing 66 tests

---

### Phase 2: Status Lifecycle

**ID:** P2-status
**Objective:** Add `status` field (active/archived/deleted) to episodes and chunks schemas. Default retrieval queries filter `{ status: { $ne: "deleted" } }`.

**Inputs:** Research item #3 ($vectorSearch pre-filter on enum)

**Files:**

- Modify: `src/memory/mongodb-schema.ts` -- Add `status` to EPISODES_SCHEMA and CHUNKS_SCHEMA
- Modify: `src/memory/mongodb-episodes.ts` -- Add status filter to queries + `updateEpisodeStatus` function
- Modify: `src/memory/mongodb-manager.ts` -- searchV2 raw-window path adds `status: { $ne: "deleted" }` to chunk queries
- Modify: `src/memory/index.ts` -- Export updateEpisodeStatus

**Implementation Details:**

Schema additions (EPISODES_SCHEMA + CHUNKS_SCHEMA):

```typescript
status: {
  enum: ["active", "archived", "deleted"],
  description: "Lifecycle status (default: active)"
}
```

New function in `mongodb-episodes.ts`:

```typescript
export async function updateEpisodeStatus(params: {
  db: Db;
  prefix: string;
  episodeId: string;
  agentId: string;
  status: "active" | "archived" | "deleted";
}): Promise<boolean>;
```

Query changes:

- `getEpisodesByTimeRange`: add `status: { $ne: "deleted" }` to filter
- `getEpisodesByType`: add `status: { $ne: "deleted" }` to filter
- `searchEpisodes`: add `status: { $ne: "deleted" }` to filter
- searchV2 raw-window path: add `status: { $ne: "deleted" }` to chunk filter
- New episodes default to `status: "active"` via $setOnInsert in materializeEpisode

**Critical consideration:** Existing episodes have no `status` field. `{ $ne: "deleted" }` matches documents where the field is absent or any value other than "deleted", so all existing episodes are included. This is backward compatible by design.

**TDD Scenarios:**

1. `updateEpisodeStatus` sets status field on episode
2. `getEpisodesByTimeRange` excludes deleted episodes
3. `getEpisodesByTimeRange` includes episodes without status field (backward compat)
4. `searchEpisodes` excludes deleted episodes
5. `materializeEpisode` sets status: "active" on new episodes

**E2E Test (Phase 15):**

```
Phase 15: Status Lifecycle
- new episodes have status "active"
- updateEpisodeStatus changes status to "archived"
- archived episodes still returned by time-range queries (only deleted excluded)
- deleted episodes excluded from search results
```

**Required Checks:**

- `pnpm test -- src/memory/mongodb-episodes.test.ts` -- all pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 70+ tests pass, 0 regressions

**Checkpoint:** None

**Exit Criteria:**

- Episodes and chunks have optional `status` field
- Retrieval queries filter out deleted records
- Backward compatible (existing records without status still returned)
- Phase 15 e2e tests pass

---

### Phase 3: Procedural Memory Evolution

**ID:** P3-procedures
**Objective:** Add version tracking, success/fail counts, and bounded evolution history to the procedures collection.

**Inputs:** Research item #4 (document versioning pattern)

**Files:**

- Modify: `src/memory/mongodb-schema.ts` -- Add evolution fields to PROCEDURES_SCHEMA
- Create or modify: `src/memory/mongodb-procedures.ts` -- Add `evolveProcedure` and `recordProcedureOutcome` functions
- Modify: `src/memory/index.ts` -- Export new functions

**Implementation Details:**

Schema additions (PROCEDURES_SCHEMA):

```typescript
version: { bsonType: "number", minimum: 1, description: "Current version number" },
successCount: { bsonType: "number", minimum: 0 },
failCount: { bsonType: "number", minimum: 0 },
lastSuccessAt: { bsonType: "date" },
lastFailureAt: { bsonType: "date" },
evolutionHistory: {
  bsonType: "array",
  items: {
    bsonType: "object",
    properties: {
      version: { bsonType: "number" },
      changeType: { bsonType: "string" },
      changeDescription: { bsonType: "string" },
      timestamp: { bsonType: "date" },
    },
  },
  description: "Capped at 20 entries via $push + $slice: -20"
}
```

New functions:

```typescript
// Record success/fail outcome on a procedure (atomic $inc)
export async function recordProcedureOutcome(params: {
  db: Db;
  prefix: string;
  procedureId: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  success: boolean;
}): Promise<boolean>;

// Evolve a procedure: bump version, update steps, record in evolutionHistory
export async function evolveProcedure(params: {
  db: Db;
  prefix: string;
  procedureId: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  newSteps: string[];
  changeType: string;
  changeDescription: string;
}): Promise<{ newVersion: number }>;
```

MongoDB pattern for evolveProcedure:

```javascript
db.procedures.updateOne(
  { procedureId, agentId, scope, scopeRef },
  {
    $inc: { version: 1 },
    $set: { steps: newSteps, updatedAt: new Date() },
    $push: {
      evolutionHistory: {
        $each: [{ version, changeType, changeDescription, timestamp }],
        $slice: -20,
      },
    },
  },
);
```

**TDD Scenarios:**

1. `recordProcedureOutcome` increments successCount on success
2. `recordProcedureOutcome` increments failCount on failure
3. `recordProcedureOutcome` sets lastSuccessAt/lastFailureAt
4. `evolveProcedure` increments version
5. `evolveProcedure` updates steps
6. `evolveProcedure` appends to evolutionHistory
7. `evolveProcedure` caps evolutionHistory at 20 via $slice
8. New procedures get version: 1, successCount: 0, failCount: 0

**E2E Test (Phase 16):**

```
Phase 16: Procedural Memory Evolution
- recordProcedureOutcome increments counts atomically
- evolveProcedure bumps version and records history
- evolutionHistory is bounded at 20 entries
- procedure version and counts survive concurrent updates
```

**Required Checks:**

- Unit tests for new functions pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 74+ tests pass, 0 regressions

**Checkpoint:** None

**Exit Criteria:**

- Procedures collection extended with version/evolution fields
- $inc + $push + $slice pattern works atomically
- Phase 16 e2e tests pass
- Bounded arrays proven (provable property #2)

---

### Phase 4: Mutation Audit Integration

**ID:** P4-audit-integration
**Objective:** Wire mutation audit into structured_mem writes and entity/relation writes. This phase depends on Phase 1 (mutations module exists).

**Inputs:** Phase 1 (mongodb-mutations.ts)

**Files:**

- Modify: `src/memory/mongodb-structured-memory.ts` -- Add recordMutation call after upsertStructured
- Modify: `src/memory/mongodb-graph.ts` -- Add recordMutation call after upsertEntity and upsertRelation

**Implementation Details:**

In `upsertStructuredMemory` (mongodb-structured-memory.ts):

- After the updateOne call, fire-and-forget `recordMutation` with operation "create" or "update"
- For updates: read old value before write (find + updateOne), compute changedFields
- Use Promise.allSettled to not block the write path

In `upsertEntity` (mongodb-graph.ts):

- After the updateOne call, fire-and-forget `recordMutation`
- For new entities: operation "create", oldValue: null
- For updates: operation "update" (old value approximated from $set fields)

In `upsertRelation` (mongodb-graph.ts):

- Same pattern as upsertEntity

**Critical consideration:** Audit writes are fire-and-forget (Promise.allSettled). If the audit fails, the primary write still succeeds. This preserves the existing behavior contract.

**TDD Scenarios:**

1. Structured memory upsert records a mutation
2. Entity upsert records a mutation
3. Relation upsert records a mutation
4. Audit failure does not break primary write (mock recordMutation to throw)
5. Update operations record changedFields

**E2E Test (Phase 17):**

```
Phase 17: Audit Integration
- structured memory write produces mutation record
- entity upsert produces mutation record
- mutation records have correct operation type (create vs update)
- getMutationHistory returns records sorted by timestamp desc
```

**Required Checks:**

- Unit tests pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 78+ tests pass, 0 regressions

**[CHECKPOINT] Dependency gate:** Phase 1 must be complete before Phase 4 can start.

**Exit Criteria:**

- All structured_mem/entity/relation writes produce audit records
- Audit writes are fire-and-forget (non-blocking)
- Phase 17 e2e tests pass

---

### Phase 5: Conservative Graph Deletion

**ID:** P5-graph-delete
**Objective:** Wrap `deleteEntity` with conflict detection (check relation count) and audit trail integration. Depends on Phase 1 (mutations) and Phase 4 (audit integration).

**Inputs:** Research item #5 (conservative graph deletion)

**Files:**

- Modify: `src/memory/mongodb-graph.ts` -- Add `deleteEntityConservative` function

**Implementation Details:**

New function in `mongodb-graph.ts`:

```typescript
export async function deleteEntityConservative(params: {
  db: Db;
  prefix: string;
  entityId: string;
  agentId: string;
  force?: boolean; // skip conflict check
}): Promise<{
  deletedEntity: boolean;
  deletedRelations: number;
  conflictDetected: boolean;
  conflictingRelationCount?: number;
  auditRecorded: boolean;
}>;
```

Logic:

1. Query relations collection for `{ $or: [{ fromEntityId }, { toEntityId }], agentId }` with count
2. If relations exist and `force !== true`:
   - Return `{ deletedEntity: false, conflictDetected: true, conflictingRelationCount }`
   - Do NOT delete
3. If force=true or no relations:
   - Read entity document before delete (for audit oldValue)
   - Call existing `deleteEntity`
   - Record mutation via `recordMutation` with operation "delete"
   - Return result

Existing `deleteEntity` remains unchanged (backward compatible). `deleteEntityConservative` is the new safe wrapper.

**TDD Scenarios:**

1. Entity with relations: returns conflictDetected=true, does not delete
2. Entity with no relations: deletes and records audit
3. Entity with relations + force=true: deletes, records audit
4. Entity not found: returns deletedEntity=false, conflictDetected=false
5. Audit failure does not prevent deletion (fire-and-forget)

**E2E Test (Phase 18):**

```
Phase 18: Conservative Graph Deletion
- deleteEntityConservative blocks deletion when relations exist
- deleteEntityConservative with force=true deletes despite relations
- deletion produces mutation audit record
- entity with no relations deletes without conflict
```

**Required Checks:**

- Unit tests pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 82+ tests pass, 0 regressions

**[CHECKPOINT] Dependency gate:** Phase 1 and Phase 4 must be complete.

**Exit Criteria:**

- `deleteEntityConservative` prevents accidental data loss
- Audit trail records all deletions
- Existing `deleteEntity` unchanged (backward compatible)
- Phase 18 e2e tests pass

---

### Phase 6: Working Memory Bounds

**ID:** P6-working-memory
**Objective:** Add configurable capacity limit on session event queries using `$sort + $limit` optimization (MongoDB coalesces adjacent $sort + $limit).

**Inputs:** Research item #6 ($sort + $limit optimization)

**Files:**

- Modify: `src/memory/mongodb-events.ts` -- Add `getSessionEventsWithBound` function
- Modify: `src/memory/mongodb-manager.ts` -- Wire into searchV2 raw-window path
- Modify: `src/memory/index.ts` -- Export new function

**Implementation Details:**

New function in `mongodb-events.ts`:

```typescript
export async function getSessionEventsWithBound(params: {
  db: Db;
  prefix: string;
  agentId: string;
  sessionId: string;
  bound?: number; // default 50, minimum 1
  scope?: MemoryScope;
  scopeRef?: string;
}): Promise<CanonicalEvent[]>;
```

Implementation:

```javascript
const effectiveBound = Math.max(1, bound ?? 50);
db.events
  .find({ agentId, sessionId, ...scopeFilter })
  .sort({ timestamp: -1 })
  .limit(effectiveBound)
  .toArray();
// Reverse to chronological order after fetch
```

MongoDB $sort + $limit optimization: when $sort precedes $limit with no intervening stages, the optimizer coalesces them so only top-N are tracked during sort.

Existing index `{ sessionId: 1, timestamp: -1 }` (idx_events_session_ts) already supports this pattern.

**TDD Scenarios:**

1. Returns at most `bound` events
2. Default bound is 50
3. bound=0 clamped to 1
4. Fewer events than bound returns all events
5. Events returned in chronological order (oldest first)
6. Respects agentId filter

**E2E Test (Phase 19):**

```
Phase 19: Working Memory Bounds
- getSessionEventsWithBound returns at most N events
- bound clamp: bound=0 returns 1 event (not 0)
- events returned in chronological order
- uses idx_events_session_ts index (explain)
```

**Required Checks:**

- Unit tests pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 86+ tests pass, 0 regressions

**Checkpoint:** None

**Exit Criteria:**

- Working memory bounded by configurable limit
- $sort + $limit optimization verified via explain
- Provable property #3 (bound >= 1) enforced
- Phase 19 e2e tests pass

---

### Phase 7: Temporal Grounding in Entity Extraction

**ID:** P7-temporal
**Objective:** Enhance entity extraction prompts to include temporal grounding (dates/times). Add optional `extractedAt` field to entities schema.

**Inputs:** Research item #7 (prompt-level, no MongoDB feature needed)

**Files:**

- Modify: `src/memory/mongodb-entity-extractor.ts` -- Add temporal grounding to LLM prompt
- Modify: `src/memory/mongodb-schema.ts` -- Add `extractedAt` to ENTITIES_SCHEMA

**Implementation Details:**

Schema addition (ENTITIES_SCHEMA):

```typescript
extractedAt: { bsonType: "date", description: "When this entity was extracted" }
```

Prompt modification in `buildExtractionPrompt`:

```typescript
// Add temporal grounding instruction
`Rules:
- Only extract entities explicitly mentioned in the text
- Do not invent entities that are not present
- When extracting facts, ALWAYS include dates/times if mentioned in the text
  Example: "met with Alice on May 7, 2023" should extract "Alice" AND "May 7, 2023" as entities
- Extract dates as type "concept" with name as the date string
- Confidence should be 0.0-1.0 based on how certain you are
- Normalize names (capitalize properly, no leading/trailing whitespace)`;
```

RegexEntityExtractor enhancement -- add date pattern:

```typescript
const DATE_REGEX = /\b(\d{4}-\d{2}-\d{2}|\w+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})\b/g;
// Extract matches as type "concept" with confidence 0.7
```

Entity upsert: when extractedAt is not set on the entity, the graph module sets it to `new Date()`.

**TDD Scenarios:**

1. LLM prompt includes temporal grounding instruction
2. Regex extractor finds ISO dates (2023-05-07)
3. Regex extractor finds natural dates (May 7, 2023)
4. Regex extractor finds US dates (5/7/2023)
5. No dates in text: no temporal entities extracted
6. Entity upsert includes extractedAt timestamp

**E2E Test (Phase 20):**

```
Phase 20: Temporal Grounding
- entity extraction captures date references from event text
- extractedAt field set on newly extracted entities
- date entity has type "concept"
- text without dates: no temporal entities extracted
```

**Required Checks:**

- `pnpm test -- src/memory/mongodb-entity-extractor.test.ts` -- all pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 90+ tests pass, 0 regressions

**Checkpoint:** None

**Exit Criteria:**

- Entity extraction captures temporal references
- extractedAt field populated on entities
- Backward compatible (existing entities without extractedAt still work)
- Phase 20 e2e tests pass

---

### Phase 8: Role-Based Memory Extraction

**ID:** P8-role-extraction
**Objective:** Use different extraction prompts for user vs assistant events. Add `sourceRole` field to entities schema.

**Inputs:** Research item #8 (prompt-level, no MongoDB feature needed)

**Files:**

- Modify: `src/memory/mongodb-entity-extractor.ts` -- Add role-aware prompts + `sourceRole` to ExtractedEntity type
- Modify: `src/memory/mongodb-schema.ts` -- Add `sourceRole` to ENTITIES_SCHEMA
- Modify: `src/memory/mongodb-graph.ts` -- Pass `sourceRole` to entity upsert, set on entity document

**Implementation Details:**

Schema addition (ENTITIES_SCHEMA):

```typescript
sourceRole: {
  enum: ["user", "assistant"],
  description: "Role of the event that produced this entity"
}
```

New prompt builders in `mongodb-entity-extractor.ts`:

```typescript
export function buildUserExtractionPrompt(
  content: string,
  context?: EntityExtractionContext,
): string {
  // Focus on: user preferences, personal facts, relationships, goals
  return `Extract entities from the following USER message. Focus on:
- People the user mentions (type: person)
- User preferences and interests (type: concept)
- Projects or tools the user references (type: project)
- Locations (type: location)
- Organizations (type: org)
...`;
}

export function buildAssistantExtractionPrompt(
  content: string,
  context?: EntityExtractionContext,
): string {
  // Focus on: capabilities used, tools invoked, approaches taken
  return `Extract entities from the following ASSISTANT response. Focus on:
- Tools or capabilities mentioned (type: system)
- Technical concepts discussed (type: concept)
- Projects being worked on (type: project)
- People referenced (type: person)
...`;
}
```

Updated `LLMEntityExtractor.extract`:

```typescript
async extract(content: string, context?: EntityExtractionContext & { role?: string }): Promise<ExtractedEntity[]> {
  const role = context?.role;
  // Choose prompt based on role
  const prompt = role === "assistant"
    ? buildAssistantExtractionPrompt(content, context)
    : buildUserExtractionPrompt(content, context);
  // ... existing logic with role-specific prompt
}
```

Updated `extractAndUpsertEntities` in `mongodb-graph.ts`:

```typescript
// Accept optional role parameter
export async function extractAndUpsertEntities(params: {
  // ... existing params
  role?: "user" | "assistant" | "system" | "tool";
}): Promise<...> {
  // Pass role to extractor context
  // Set sourceRole on entity upsert doc
}
```

**TDD Scenarios:**

1. `buildUserExtractionPrompt` includes user-specific focus areas
2. `buildAssistantExtractionPrompt` includes assistant-specific focus areas
3. LLMEntityExtractor uses user prompt for role="user"
4. LLMEntityExtractor uses assistant prompt for role="assistant"
5. LLMEntityExtractor defaults to user prompt for unknown roles
6. Entity upsert sets sourceRole field
7. sourceRole validated as "user" or "assistant" before write

**E2E Test (Phase 21):**

```
Phase 21: Role-Based Memory Extraction
- entity extracted from user event has sourceRole "user"
- entity extracted from assistant event has sourceRole "assistant"
- sourceRole field persisted on entity document
- regex extractor returns entities regardless of role (no regression)
```

**Required Checks:**

- `pnpm test -- src/memory/mongodb-entity-extractor.test.ts` -- all pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- 94+ tests pass, 0 regressions

**Checkpoint:** None

**Exit Criteria:**

- Role-specific extraction prompts reduce hallucination
- sourceRole field tracks extraction source
- Backward compatible (existing entities without sourceRole still work)
- Phase 21 e2e tests pass

---

### Phase 9: Tiered Token-Efficient Retrieval

**ID:** P9-tiered
**Objective:** Add projection mode to searchV2 and episode queries to return IDs+scores first, then expand to full content on demand. This phase is last because it modifies the searchV2 internal behavior.

**Inputs:** Research item #1 ($project after $vectorSearch)

**Files:**

- Modify: `src/memory/mongodb-episodes.ts` -- Add `getEpisodesByIds` function
- Modify: `src/memory/mongodb-manager.ts` -- Add `projection` option to searchV2 context
- Modify: `src/memory/index.ts` -- Export getEpisodesByIds

**Implementation Details:**

New function in `mongodb-episodes.ts`:

```typescript
export async function getEpisodesByIds(params: {
  db: Db;
  prefix: string;
  episodeIds: string[];
  agentId: string;
  projection?: "full" | "ids-only";
}): Promise<Episode[]>;
```

searchV2 context extension:

```typescript
context: {
  // ... existing fields
  searchOptions?: {
    // ... existing fields
    projection?: "full" | "ids-only"; // default "full" (backward compatible)
  };
};
```

When `projection: "ids-only"`:

- Episodic path uses `$project: { _id: 1, episodeId: 1, title: 1, score: { $meta: "vectorSearchScore" } }` (lightweight)
- Conversation path uses `$project: { _id: 1, path: 1, score: { $meta: "vectorSearchScore" } }` (lightweight)
- Result `text` field is empty string (caller must fetch full content separately)

When `projection: "full"` (default):

- Existing behavior unchanged

**TDD Scenarios:**

1. `getEpisodesByIds` returns episodes by ID list
2. `getEpisodesByIds` returns empty array for empty IDs
3. `getEpisodesByIds` respects agentId filter
4. searchV2 with projection: "ids-only" returns results with empty text
5. searchV2 with projection: "full" returns results with full text (default)
6. searchV2 default behavior unchanged (backward compatible)

**E2E Test (Phase 22 -- bonus consolidated):**

```
Phase 22: Tiered Retrieval
- getEpisodesByIds returns correct episodes
- getEpisodesByIds with empty array returns empty
- searchV2 projection: "ids-only" returns lightweight results
- searchV2 default projection unchanged (backward compat)
```

**Required Checks:**

- Unit tests pass
- `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- all tests pass, 0 regressions

**Checkpoint:** None

**Exit Criteria:**

- IDs-only retrieval mode available for token-efficient use
- Default behavior preserved (backward compatible)
- Phase 22 e2e tests pass

---

## Final Validation Phase

**ID:** P10-final
**Objective:** Run full regression + constant verification + export wiring.

**Steps:**

1. Run `pnpm test -- src/memory/production-readiness.e2e.test.ts` -- all phases pass
2. Run `pnpm test -- src/memory/` -- full memory module regression
3. Run `pnpm build` -- build exit 0
4. Verify EXPECTED_COLLECTION_SUFFIXES in `src/memory/mongodb-e2e.e2e.test.ts` updated (was 21 with telemetry, now 22 with memory_mutations)
5. Verify EXPECTED_STANDARD_INDEX_COUNT in `src/memory/mongodb-e2e.e2e.test.ts` updated (was 58, now 61 with +3 for memory_mutations indexes)
6. Verify all new functions exported from `src/memory/index.ts`

**Exit Criteria:**

- All production-readiness tests pass (66 existing + ~32 new = ~98 total)
- Build passes
- No TypeScript errors in new code
- Collection and index counts match constants

---

## Phase Dependency Graph

```
P1 (Mutations) ─────────────> P4 (Audit Integration) ───> P5 (Conservative Delete)
P2 (Status Lifecycle) ────────────────────────────────┐
P3 (Procedural Evolution) ────────────────────────────┤
P6 (Working Memory Bounds) ───────────────────────────┤
P7 (Temporal Grounding) ──────────────────────────────┼──> P10 (Final Validation)
P8 (Role-Based Extraction) ───────────────────────────┤
P9 (Tiered Retrieval) ────────────────────────────────┘
```

Phases 2, 3, 6, 7, 8, 9 are independent of each other and of P1.
P4 depends on P1. P5 depends on P1 and P4.
All phases feed into P10 (final validation).

## Acceptance Checks

1. `MONGODB_TEST_URI=<uri> pnpm test -- src/memory/production-readiness.e2e.test.ts` -- all phases pass
2. `pnpm test -- src/memory/` -- 0 regressions in memory module
3. `pnpm build` -- exit 0
4. `pnpm check` -- clean (pre-existing baseline only)
5. Each new function has at least 3 unit tests
6. Each feature has at least 3 e2e test assertions
7. No `any` types in new code
8. All new collections have schema validation
9. All new indexes named with `idx_` or `uq_` prefix convention
10. Mutation audit TTL verified at 90 days (7776000s)

## Risks And Mitigations

| Risk                                            | Probability | Impact | Score | Mitigation                                                           |
| ----------------------------------------------- | ----------- | ------ | ----- | -------------------------------------------------------------------- |
| Status filter breaks existing queries           | 1           | 5      | 5     | `$ne: "deleted"` matches docs without status field (backward compat) |
| Mutation audit adds write latency               | 2           | 2      | 4     | Fire-and-forget via Promise.allSettled                               |
| Evolution history unbounded                     | 1           | 3      | 3     | `$push + $slice: -20` enforced in MongoDB atomic op                  |
| Conservative delete blocks legitimate deletions | 2           | 2      | 4     | `force: true` override parameter                                     |
| Temporal regex matches non-dates                | 2           | 1      | 2     | Low confidence (0.5) on regex matches; LLM path more accurate        |
| Role-based prompts reduce entity recall         | 2           | 2      | 4     | Regex fallback unaffected; LLM timeout falls back to regex           |
| EXPECTED_INDEX_COUNT drift                      | 3           | 1      | 3     | Final validation phase explicitly verifies count                     |
| Tiered retrieval empty text confuses callers    | 1           | 3      | 3     | Only used when explicitly requested via projection param             |

---

## Summary

- Plan saved: docs/plans/2026-03-23-almost-perfect-sprint-plan.md
- Phases: 10 (8 features + 1 integration + 1 final validation)
- Risks: 8 identified (all LOW score)
- Key decisions: app-level audit over Change Streams, `$ne: "deleted"` for backward compat, fire-and-forget audit writes, $push + $slice for bounded arrays
- New collection: `memory_mutations`
- New functions: ~12 across 6 modules
- New tests: ~32 e2e + ~40 unit = ~72 new tests
- Total e2e target: ~98 tests (66 existing + ~32 new)

## Recommended Skills for BUILD (SKILL_HINTS for Router)

- `cc10x:architecture-patterns` (multi-component schema/integration work)

## Confidence Score: 92/100

- Context References included with file:line (+25) -- all key files mapped
- All edge cases documented (+20) -- edge-case catalog complete
- Test commands specific (+20) -- exact pnpm test paths
- Risk mitigations defined (+20) -- all 8 risks addressed
- File paths exact (+15) -- every file to create/modify listed
- Score deduction: -8 for complexity of wiring mutation audit across 3 modules (Phase 4)

**Key Assumptions:**

1. MongoDB 8.2 atlas-local:preview Docker environment available for e2e tests
2. Existing 66 production-readiness tests pass at build start
3. `$ne: "deleted"` backward-compatible filter works with documents lacking the status field
4. Fire-and-forget Promise.allSettled for audit writes does not cause test flakiness

## Findings

- Score-weighted RRF already fully implemented (skip)
- Cognitive profile synthesis already fully implemented (skip)
- Cross-encoder reranker already fully implemented (skip)
- Query rewriter already fully implemented (skip)
- 4 of 12 original research items already exist -- sprint is focused on the 8 remaining gaps
- Procedures collection exists but lacks evolution fields -- extension only
- Structured memory already has state field (active/invalidated/conflicted) -- episodes/chunks do not
