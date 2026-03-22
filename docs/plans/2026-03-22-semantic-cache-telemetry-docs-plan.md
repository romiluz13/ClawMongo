# Semantic Query Cache + Time Series Observability + Docs Update

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** Pre-answered requirements in user request; no separate design doc.

**Goal:** Add two final pre-launch features to ClawMongo v2 (semantic query cache, time series observability) and update documentation, bringing the total to 22 collections, 58 standard indexes, and 9 search indexes.

**Architecture:** Feature 1 adds a `query_cache` regular collection with $jsonSchema validation, a unique compound index for exact-match (Tier 1), and a vector search index with autoEmbed for semantic match (Tier 2). Feature 2 adds a `memory_telemetry` time series collection with fire-and-forget emission from 5 code paths. Feature 3 updates README and docs to reflect the new capabilities.

**Tech Stack:** MongoDB Community + mongot, TypeScript ESM, Vitest, autoEmbed (voyage-4-large), time series collections.

**Prerequisites:** All v2 base + enhancements + consolidation + upstream syncs complete. Published @romiluz/clawmongo@2026.3.22.

---

## Relevant Codebase Files

### Patterns to Follow

- `src/memory/mongodb-schema.ts` (lines 457-674) — $jsonSchema validators (EVENTS_SCHEMA, ENTITIES_SCHEMA as patterns)
- `src/memory/mongodb-schema.ts` (lines 1145-1450) — ensureSearchIndexes with autoEmbed index creation pattern
- `src/memory/mongodb-schema.ts` (lines 756-960) — ensureStandardIndexes with TTL index pattern
- `src/memory/mongodb-schema.ts` (lines 676-723) — ensureCollections with validator application
- `src/memory/mongodb-search.ts` (lines 200-230) — buildVectorSearchStage with autoEmbed queryText
- `src/memory/mongodb-ops.ts` (lines 1-80) — standalone function pattern (db, prefix, ...)
- `src/memory/mongodb-manager.ts` (lines 730-790) — search() entry point where cache hooks in
- `src/memory/mongodb-manager.ts` (lines 2511-2550) — searchV2 function signature
- `src/memory/mongodb-manager.ts` (lines 2301-2400) — writeEventAndProject (telemetry emission point)
- `src/memory/mongodb-graph.ts` (lines 1-50) — expandGraph (telemetry emission point)
- `src/memory/backend-config.ts` (lines 26-80) — ResolvedMongoDBConfig type

### Configuration Files

- `src/config/types.memory.ts` — MemoryMongoDBConfig type (where cache config goes)
- `src/memory/index.ts` — barrel exports

### Existing Index/Collection Counts

- Collections: 20 (becomes 22 with query_cache + memory_telemetry)
- Standard indexes: 53 (becomes 58 with 5 new: 3 query_cache + 2 telemetry meta)
- Search indexes: 8 (becomes 9 with query_cache vector)
- Note: The telemetry TTL is handled by the time series `expireAfterSeconds` option, not a standard index

---

## Validated MongoDB Syntax (from existing codebase patterns)

### autoEmbed Vector Index Definition (mongodb-schema.ts:1224-1234)

```typescript
const vectorDef: Document = {
  fields: [
    { type: "autoEmbed", modality: "text", path: "queryNorm", model: "voyage-4-large" },
    { type: "filter", path: "agentId" },
    { type: "filter", path: "scope" },
    { type: "filter", path: "scopeRef" },
  ],
};
await collection.createSearchIndex({
  name: `${prefix}query_cache_vector`,
  type: "vectorSearch",
  definition: vectorDef,
});
```

### $vectorSearch with autoEmbed queryText (mongodb-search.ts:222-224)

```typescript
// For automated embedding mode:
base.query = { text: input.queryText };
base.path = "queryNorm"; // field path that autoEmbed indexes
```

### findOneAndUpdate with $inc (MongoDB driver pattern)

```typescript
await collection.findOneAndUpdate(
  { queryHash, agentId, scope, scopeRef },
  { $inc: { hitCount: 1 }, $set: { lastHitAt: new Date() } },
  { returnDocument: "before" }, // return cached doc before update
);
```

### Time Series Collection Creation (MongoDB driver pattern)

```typescript
await db.createCollection(`${prefix}memory_telemetry`, {
  timeseries: {
    timeField: "ts",
    metaField: "meta",
    granularity: "seconds",
  },
  expireAfterSeconds: 604800, // 7 days
});
```

**CRITICAL:** Time series collections do NOT support $jsonSchema validators. Use runtime TypeScript types only.

### Fire-and-Forget insertOne (mongodb-ops.ts:57 pattern)

```typescript
collection.insertOne(doc).catch((err) => {
  log.warn("telemetry emit failed", { error: err });
});
```

---

## Phase 1: Semantic Query Cache Collection and Schema

> **Exit Criteria:** `query_cache` collection created with $jsonSchema, unique compound index, TTL index, and vector search index. Collection accessor exported. 18+ tests pass.

### Task 1.1: Add query_cache collection accessor to mongodb-schema.ts

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (add collection accessor after line ~116)

**Step 1:** Add collection accessor function (follows existing pattern: `col(db, prefix, name)`)

```typescript
export function queryCacheCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "query_cache");
}
```

**Step 2:** Add to ensureCollections needed array (after "projection_runs" at line ~703)

Add `"query_cache"` to the `needed` array.

**Step 3:** Verify by running schema tests

```bash
pnpm test -- src/memory/mongodb-schema.test.ts
```

### Task 1.2: Add QUERY_CACHE_SCHEMA $jsonSchema validator

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (add schema constant before VALIDATED_COLLECTIONS)

**Schema definition:**

```typescript
const QUERY_CACHE_SCHEMA: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "queryHash",
      "queryNorm",
      "agentId",
      "scope",
      "scopeRef",
      "results",
      "pathUsed",
      "sourceScope",
      "createdAt",
      "expiresAt",
      "hitCount",
      "lastHitAt",
    ],
    properties: {
      queryHash: { bsonType: "string", description: "SHA-256 of normalized query" },
      queryNorm: { bsonType: "string", description: "Normalized query text (autoEmbed source)" },
      agentId: { bsonType: "string", description: "Agent that generated this cache entry" },
      scope: { enum: SCOPE_ENUM, description: "Memory scope" },
      scopeRef: { bsonType: "string", description: "Resolved scope namespace" },
      results: { bsonType: "array", description: "Cached MemorySearchResult[]" },
      pathUsed: { bsonType: "string", description: "Retrieval path that produced results" },
      sourceScope: { bsonType: "string", description: "Source scope for cache partitioning" },
      createdAt: { bsonType: "date" },
      expiresAt: { bsonType: "date", description: "Per-document TTL expiry" },
      hitCount: { bsonType: "number", minimum: 0 },
      lastHitAt: { bsonType: "date" },
    },
  },
};
```

**Step 2:** Add to VALIDATED_COLLECTIONS map

```typescript
query_cache: QUERY_CACHE_SCHEMA,
```

### Task 1.3: Add query_cache standard indexes to ensureStandardIndexes

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (add after entity_links indexes section, before `return applied`)

**Indexes:**

```typescript
// Query Cache indexes
const queryCache = queryCacheCollection(db, prefix);
await queryCache.createIndex(
  { queryHash: 1, agentId: 1, scope: 1, scopeRef: 1 },
  { name: "uq_query_cache_hash_agent_scope_scoperef", unique: true },
);
applied++;
await queryCache.createIndex(
  { expiresAt: 1 },
  { name: "idx_query_cache_ttl", expireAfterSeconds: 0 },
);
applied++;
await queryCache.createIndex(
  { agentId: 1, hitCount: -1 },
  { name: "idx_query_cache_agent_hitcount" },
);
applied++;
```

**Note:** `expireAfterSeconds: 0` on `expiresAt` field means MongoDB uses the document's `expiresAt` value as the absolute expiration time. This is the per-document TTL pattern.

### Task 1.4: Add query_cache vector search index to ensureSearchIndexes

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (add after procedures search indexes, before `return` at end)

**Vector search index (autoEmbed on queryNorm field):**

```typescript
// Query Cache search indexes
const queryCache = queryCacheCollection(db, prefix);
try {
  const cacheVectorDef: Document = {
    fields: [
      { type: "autoEmbed", modality: "text", path: "queryNorm", model: "voyage-4-large" },
      { type: "filter", path: "agentId" },
      { type: "filter", path: "scope" },
      { type: "filter", path: "scopeRef" },
    ],
  };
  await queryCache.createSearchIndex({
    name: `${prefix}query_cache_vector`,
    type: "vectorSearch",
    definition: cacheVectorDef,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (isSearchIndexManagementUnavailable(msg)) {
    log.warn(`search index management unavailable: ${msg}`);
    return { text: textCreated, vector: vectorCreated };
  }
  if (!msg.includes("already exists") && !msg.includes("duplicate")) {
    log.warn(`query_cache vector search index creation failed: ${msg}`);
  }
}
```

**Update budget:** Change `assertIndexBudget(profile, 8)` to `assertIndexBudget(profile, 9)` (adding 1 vector index).

### Task 1.5: Write schema tests for query_cache

**Files:**

- Modify: `src/memory/mongodb-schema.test.ts` (add test block)

**Tests to write:**

1. `queryCacheCollection returns prefixed collection`
2. `QUERY_CACHE_SCHEMA validates required fields` (via ensureSchemaValidation mock)
3. `unique index on (queryHash, agentId, scope, scopeRef)` — verify createIndex call
4. `TTL index on expiresAt with expireAfterSeconds: 0` — verify createIndex call
5. `hitCount index on (agentId, hitCount)` — verify createIndex call
6. `vector search index with autoEmbed on queryNorm` — verify createSearchIndex call

**Step:** Run tests

```bash
pnpm test -- src/memory/mongodb-schema.test.ts
```

### Task 1.6: Update EXPECTED_COLLECTION_SUFFIXES and EXPECTED_STANDARD_INDEX_COUNT

**Files:**

- Modify: `src/memory/mongodb-e2e.e2e.test.ts` — add `"query_cache"` and `"memory_telemetry"` to `EXPECTED_COLLECTION_SUFFIXES` array (20 becomes 22)
- Modify: `src/memory/mongodb-e2e.e2e.test.ts` — update `EXPECTED_STANDARD_INDEX_COUNT` from 53 to 58 (3 query_cache + 2 telemetry meta indexes)

**Note:** The time series collection `memory_telemetry` is created inside `ensureCollections` (separate from the regular loop), so it will appear in `db.listCollections()` and must be in the expected suffixes array.

**Step:** Verify in existing e2e test

```bash
pnpm test -- src/memory/mongodb-e2e.e2e.test.ts -t "collection suffixes"
```

### Task 1.7: Update barrel exports in index.ts

**Files:**

- Modify: `src/memory/index.ts` — add export for `queryCacheCollection` from `./mongodb-schema.js`

**Step:** Verify build

```bash
pnpm build
```

**Commit after Phase 1:**

```
Feat: add query_cache collection with $jsonSchema, indexes, and autoEmbed vector search
```

---

## Phase 2: Semantic Query Cache Implementation

> **Exit Criteria:** `mongodb-query-cache.ts` module with checkCache, writeCache functions. Two-tier lookup (exact hash + semantic), fire-and-forget write, hit counting. 20+ tests pass.

### Task 2.1: Create mongodb-query-cache.ts with types

**Files:**

- Create: `src/memory/mongodb-query-cache.ts`

**Types:**

```typescript
import { createHash } from "node:crypto";
import type { Db, Document } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemoryScope } from "../config/types.memory.js";
import { queryCacheCollection } from "./mongodb-schema.js";
import { buildVectorSearchStage } from "./mongodb-search.js";
import type { MemorySearchResult } from "./types.js";

const log = createSubsystemLogger("memory:mongodb:query-cache");

export type QueryCacheEntry = {
  queryHash: string;
  queryNorm: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
  results: MemorySearchResult[];
  pathUsed: string;
  sourceScope: string;
  createdAt: Date;
  expiresAt: Date;
  hitCount: number;
  lastHitAt: Date;
};

export type QueryCacheConfig = {
  enabled: boolean;
  conversationTtlSec: number;
  kbTtlSec: number;
  similarityThreshold: number;
};

export const DEFAULT_CACHE_CONFIG: QueryCacheConfig = {
  enabled: true,
  conversationTtlSec: 300, // 5 minutes
  kbTtlSec: 3600, // 1 hour
  similarityThreshold: 0.95,
};
```

### Task 2.2: Implement normalizeQuery and hashQuery helpers

**Files:**

- Modify: `src/memory/mongodb-query-cache.ts`

```typescript
/** Normalize query for consistent hashing: lowercase, collapse whitespace, trim. */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

/** SHA-256 hash of normalized query string. */
export function hashQuery(normalizedQuery: string): string {
  return createHash("sha256").update(normalizedQuery).digest("hex");
}
```

### Task 2.3: Implement checkCache (two-tier lookup)

**Files:**

- Modify: `src/memory/mongodb-query-cache.ts`

```typescript
export type CacheCheckResult = {
  hit: boolean;
  tier: "exact" | "semantic" | "miss";
  results: MemorySearchResult[];
  pathUsed?: string;
  sourceScope?: string;
};

/**
 * Two-tier cache check:
 * Tier 1: Exact SHA-256 hash match via findOne on unique index.
 * Tier 2: $vectorSearch with autoEmbed on queryNorm field, cosine ≥ threshold.
 *
 * On hit: increments hitCount and updates lastHitAt (fire-and-forget).
 */
export async function checkCache(params: {
  db: Db;
  prefix: string;
  query: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
  config: QueryCacheConfig;
  vectorIndexName?: string;
}): Promise<CacheCheckResult> {
  const { db, prefix, query, agentId, scope, scopeRef, config } = params;

  if (!config.enabled) {
    return { hit: false, tier: "miss", results: [] };
  }

  const normalized = normalizeQuery(query);
  if (!normalized) {
    return { hit: false, tier: "miss", results: [] };
  }

  const col = queryCacheCollection(db, prefix);
  const qHash = hashQuery(normalized);
  const now = new Date();

  // Tier 1: Exact match
  try {
    const exact = await col.findOne({
      queryHash: qHash,
      agentId,
      scope,
      scopeRef,
      expiresAt: { $gt: now },
    });
    if (exact) {
      // Fire-and-forget hit count increment
      col
        .findOneAndUpdate({ _id: exact._id }, { $inc: { hitCount: 1 }, $set: { lastHitAt: now } })
        .catch((err) => {
          log.warn("cache hit count update failed", { error: err });
        });
      return {
        hit: true,
        tier: "exact",
        results: exact.results as MemorySearchResult[],
        pathUsed: exact.pathUsed as string,
        sourceScope: exact.sourceScope as string,
      };
    }
  } catch (err) {
    log.warn("cache exact lookup failed", { error: err });
    return { hit: false, tier: "miss", results: [] };
  }

  // Tier 2: Semantic similarity via $vectorSearch with autoEmbed
  try {
    const indexName = params.vectorIndexName ?? `${prefix}query_cache_vector`;
    const vsStage = buildVectorSearchStage({
      queryVector: null,
      queryText: normalized,
      embeddingMode: "automated",
      indexName,
      numCandidates: 20,
      limit: 1,
      filter: { agentId, scope, scopeRef },
      textFieldPath: "queryNorm",
    });
    if (!vsStage) {
      return { hit: false, tier: "miss", results: [] };
    }

    const pipeline: Document[] = [
      { $vectorSearch: vsStage },
      { $limit: 1 },
      {
        $project: {
          _id: 1,
          results: 1,
          pathUsed: 1,
          sourceScope: 1,
          expiresAt: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];

    const candidates = await col.aggregate(pipeline).toArray();
    if (
      candidates.length > 0 &&
      candidates[0].score >= config.similarityThreshold &&
      candidates[0].expiresAt > now
    ) {
      const match = candidates[0];
      // Fire-and-forget hit count increment
      col
        .findOneAndUpdate({ _id: match._id }, { $inc: { hitCount: 1 }, $set: { lastHitAt: now } })
        .catch((err) => {
          log.warn("cache hit count update failed (semantic)", { error: err });
        });
      return {
        hit: true,
        tier: "semantic",
        results: match.results as MemorySearchResult[],
        pathUsed: match.pathUsed as string,
        sourceScope: match.sourceScope as string,
      };
    }
  } catch (err) {
    // Semantic tier failure is non-fatal — degrade to cache miss
    log.warn("cache semantic lookup failed", { error: err });
  }

  return { hit: false, tier: "miss", results: [] };
}
```

### Task 2.4: Implement writeCache (fire-and-forget)

**Files:**

- Modify: `src/memory/mongodb-query-cache.ts`

```typescript
/**
 * Write search results to cache. Fire-and-forget: does not block caller.
 * Uses upsert to handle race conditions (two identical queries completing simultaneously).
 */
export function writeCache(params: {
  db: Db;
  prefix: string;
  query: string;
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
  results: MemorySearchResult[];
  pathUsed: string;
  sourceScope: string;
  ttlSec: number;
}): void {
  const { db, prefix, query, agentId, scope, scopeRef, results, pathUsed, sourceScope, ttlSec } =
    params;

  const normalized = normalizeQuery(query);
  if (!normalized || results.length === 0) return;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);
  const qHash = hashQuery(normalized);
  const col = queryCacheCollection(db, prefix);

  col
    .updateOne(
      { queryHash: qHash, agentId, scope, scopeRef },
      {
        $setOnInsert: {
          queryNorm: normalized,
          createdAt: now,
          hitCount: 0,
        },
        $set: {
          results,
          pathUsed,
          sourceScope,
          expiresAt,
          lastHitAt: now,
        },
      },
      { upsert: true },
    )
    .catch((err) => {
      log.warn("cache write failed", { error: err });
    });
}
```

### Task 2.5: Write tests for mongodb-query-cache.ts

**Files:**

- Create: `src/memory/mongodb-query-cache.test.ts`

**Tests to write (20+ tests):**

1. `normalizeQuery lowercases input`
2. `normalizeQuery collapses whitespace`
3. `normalizeQuery trims`
4. `normalizeQuery handles empty string`
5. `hashQuery returns consistent SHA-256`
6. `hashQuery returns different hashes for different queries`
7. `checkCache returns miss when disabled`
8. `checkCache returns miss for empty query`
9. `checkCache Tier 1 returns exact match`
10. `checkCache Tier 1 skips expired entries`
11. `checkCache Tier 1 increments hitCount on hit (fire-and-forget)`
12. `checkCache Tier 2 returns semantic match above threshold`
13. `checkCache Tier 2 rejects match below threshold`
14. `checkCache Tier 2 rejects expired semantic match`
15. `checkCache returns miss when both tiers miss`
16. `checkCache handles Tier 1 error gracefully`
17. `checkCache handles Tier 2 error gracefully (degrades to miss)`
18. `writeCache writes entry with correct fields`
19. `writeCache skips empty query`
20. `writeCache skips empty results`
21. `writeCache uses upsert (handles race condition)`
22. `writeCache is fire-and-forget (does not throw)`
23. `writeCache sets correct expiresAt from ttlSec`

**Mock pattern:** Follow mongodb-ops.test.ts pattern — mock collection with vi.fn() for findOne, findOneAndUpdate, aggregate, updateOne.

**Step:** Run tests

```bash
pnpm test -- src/memory/mongodb-query-cache.test.ts
```

**Commit after Task 2.5:**

```
Feat: implement semantic query cache with two-tier lookup
```

---

## Phase 3: Wire Cache into Search Path

> **Exit Criteria:** Cache check runs BEFORE search pipeline construction. Cache write runs AFTER search returns. Config section added. 8+ additional tests pass.

### Task 3.1: Add cache config to MemoryMongoDBConfig

**Files:**

- Modify: `src/config/types.memory.ts` (add inside MemoryMongoDBConfig type)

```typescript
/** Semantic query cache configuration */
cache?: {
  /** Enable query caching. Default: true */
  enabled?: boolean;
  /** TTL for conversation scope cache entries in seconds. Default: 300 (5 min) */
  conversationTtlSec?: number;
  /** TTL for KB scope cache entries in seconds. Default: 3600 (1 hour) */
  kbTtlSec?: number;
  /** Cosine similarity threshold for semantic cache hits. Default: 0.95 */
  similarityThreshold?: number;
};
```

### Task 3.2: Add cache to ResolvedMongoDBConfig

**Files:**

- Modify: `src/memory/backend-config.ts`

Add to `ResolvedMongoDBConfig` type (after `graph` field):

```typescript
cache: {
  enabled: boolean;
  conversationTtlSec: number;
  kbTtlSec: number;
  similarityThreshold: number;
}
```

Add defaults in the resolve function (follow existing `!== false` pattern for default-enable):

```typescript
cache: {
  enabled: mongo.cache?.enabled !== false,
  conversationTtlSec: mongo.cache?.conversationTtlSec ?? 300,
  kbTtlSec: mongo.cache?.kbTtlSec ?? 3600,
  similarityThreshold: mongo.cache?.similarityThreshold ?? 0.95,
},
```

### Task 3.3: Wire checkCache BEFORE searchV2 in MongoDBMemoryManager.search()

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (in the `search()` method, ~line 730)

**Hook location:** After `const cleaned = query.trim()` and before the `searchV2` call.

```typescript
// Cache check: BEFORE search pipeline
if (mongoCfg.cache.enabled) {
  const cacheResult = await checkCache({
    db: this.db,
    prefix: this.prefix,
    query: cleaned,
    agentId: this.agentId,
    scope: "agent",
    scopeRef: this.agentScopeRef,
    config: mongoCfg.cache,
  });
  if (cacheResult.hit) {
    this.setLastSearchMode(`v2:cache:${cacheResult.tier}`, {
      pathUsed: cacheResult.pathUsed,
      sourceScope: cacheResult.sourceScope,
    });
    return cacheResult.results;
  }
}
```

### Task 3.4: Wire writeCache AFTER searchV2 returns results

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (after `return v2.results` in search(), ~line 777)

**Hook location:** After `if (v2.results.length > 0)` block, before the return.

```typescript
if (v2.results.length > 0) {
  this.setLastSearchMode("v2", v2Details);
  // Fire-and-forget cache write
  if (mongoCfg.cache.enabled) {
    const ttlSec = mongoCfg.kb.enabled
      ? mongoCfg.cache.kbTtlSec
      : mongoCfg.cache.conversationTtlSec;
    writeCache({
      db: this.db,
      prefix: this.prefix,
      query: cleaned,
      agentId: this.agentId,
      scope: "agent",
      scopeRef: this.agentScopeRef,
      results: v2.results,
      pathUsed: v2.metadata.pathsExecuted.join(","),
      sourceScope: "conversation",
      ttlSec,
    });
  }
  return v2.results;
}
```

### Task 3.5: Add imports to mongodb-manager.ts

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (add imports at top)

```typescript
import { checkCache, writeCache } from "./mongodb-query-cache.js";
```

### Task 3.6: Write integration tests for cache wiring

**Files:**

- Modify: `src/memory/mongodb-manager.test.ts` (add test block)

**Tests to write:**

1. `search() checks cache before searchV2 when cache enabled`
2. `search() returns cache hit without calling searchV2`
3. `search() sets searchMode to v2:cache:exact on exact cache hit`
4. `search() sets searchMode to v2:cache:semantic on semantic cache hit`
5. `search() calls searchV2 when cache misses`
6. `search() writes to cache after successful searchV2`
7. `search() skips cache when cache disabled`
8. `search() uses correct TTL for conversation vs KB`

**Step:** Run tests

```bash
pnpm test -- src/memory/mongodb-manager.test.ts
```

### Task 3.7: Export cache types and functions from barrel

**Files:**

- Modify: `src/memory/index.ts`

```typescript
export {
  checkCache,
  writeCache,
  normalizeQuery,
  hashQuery,
  type QueryCacheEntry,
  type QueryCacheConfig,
  type CacheCheckResult,
  DEFAULT_CACHE_CONFIG,
} from "./mongodb-query-cache.js";
```

**Step:** Verify build

```bash
pnpm build
```

**Commit after Phase 3:**

```
Feat: wire semantic query cache into search pipeline with two-tier lookup
```

---

## Phase 4: Time Series Observability Collection

> **Exit Criteria:** `memory_telemetry` time series collection created with 7-day TTL. Thin emitTelemetry function. 12+ tests pass.

### Task 4.1: Add memory_telemetry time series collection to ensureCollections

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (in ensureCollections function)

**CRITICAL:** Time series collections cannot use $jsonSchema validators. They must be created with `timeseries` options using `db.createCollection()` directly.

Add a separate block AFTER the regular collection loop:

```typescript
// Time series collection — created separately (no $jsonSchema support)
const telemetryName = `${prefix}memory_telemetry`;
if (!existing.has(telemetryName)) {
  try {
    await db.createCollection(telemetryName, {
      timeseries: {
        timeField: "ts",
        metaField: "meta",
        granularity: "seconds",
      },
      expireAfterSeconds: 604800, // 7 days
    });
    log.info(`created time series collection ${telemetryName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Collection may already exist or time series not supported
    if (!msg.includes("already exists") && !msg.includes("Collection already exists")) {
      log.warn(`time series collection creation failed: ${msg}`);
    }
  }
}
```

**Do NOT add to `needed` array** — time series collections cannot be created with `validator` option.

### Task 4.2: Add telemetryCollection accessor

**Files:**

- Modify: `src/memory/mongodb-schema.ts`

```typescript
export function telemetryCollection(db: Db, prefix: string): Collection {
  return col(db, prefix, "memory_telemetry");
}
```

### Task 4.3: Add standard indexes for telemetry meta queries

**Files:**

- Modify: `src/memory/mongodb-schema.ts` (in ensureStandardIndexes, after query_cache indexes)

```typescript
// Telemetry indexes (time series collection — meta field compound indexes)
const telemetry = telemetryCollection(db, prefix);
try {
  await telemetry.createIndex({ "meta.agentId": 1, ts: -1 }, { name: "idx_telemetry_agent_ts" });
  applied++;
  await telemetry.createIndex({ "meta.operation": 1, ts: -1 }, { name: "idx_telemetry_op_ts" });
  applied++;
} catch (err) {
  // Time series collection may not exist (creation failed in ensureCollections)
  const msg = err instanceof Error ? err.message : String(err);
  log.warn(`telemetry index creation skipped: ${msg}`);
}
```

### Task 4.4: Create mongodb-telemetry.ts with types and emitTelemetry

**Files:**

- Create: `src/memory/mongodb-telemetry.ts`

```typescript
import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { telemetryCollection } from "./mongodb-schema.js";

const log = createSubsystemLogger("memory:mongodb:telemetry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetryOperation =
  | "search"
  | "event-write"
  | "projection-run"
  | "cache-check"
  | "graph-expansion";

export type TelemetryMeta = {
  agentId: string;
  operation: TelemetryOperation;
};

export type TelemetryDocument = {
  ts: Date;
  meta: TelemetryMeta;
  durationMs: number;
  ok: boolean;
  pathUsed?: string;
  resultCount?: number;
  topScore?: number;
  fusionMethod?: string;
  cacheHit?: boolean;
  latencySavedMs?: number;
  itemCount?: number;
  eventType?: string;
  projectionTriggered?: boolean;
};

// ---------------------------------------------------------------------------
// Emit (fire-and-forget, error-swallowing, non-blocking)
// ---------------------------------------------------------------------------

/**
 * Emit a telemetry document to the memory_telemetry time series collection.
 * Fire-and-forget: never blocks the caller, never throws.
 * Uses insertOne with .catch() for error-swallowing.
 */
export function emitTelemetry(db: Db, prefix: string, doc: Omit<TelemetryDocument, "ts">): void {
  const entry: TelemetryDocument = { ...doc, ts: new Date() };
  telemetryCollection(db, prefix)
    .insertOne(entry)
    .catch((err) => {
      log.warn("telemetry emit failed", { operation: doc.meta.operation, error: err });
    });
}

// ---------------------------------------------------------------------------
// Aggregation helpers (dashboard metrics)
// ---------------------------------------------------------------------------

/** Get P50/P95/P99 latency stats for a given operation over a time window. */
export async function getLatencyStats(params: {
  db: Db;
  prefix: string;
  agentId: string;
  operation?: TelemetryOperation;
  windowMs?: number;
}): Promise<{ p50: number; p95: number; p99: number; count: number }> {
  const { db, prefix, agentId, operation, windowMs = 3600000 } = params;
  const since = new Date(Date.now() - windowMs);
  const matchStage: Record<string, unknown> = {
    "meta.agentId": agentId,
    ts: { $gte: since },
  };
  if (operation) {
    matchStage["meta.operation"] = operation;
  }

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: null,
        durations: { $push: "$durationMs" },
        count: { $sum: 1 },
      },
    },
  ];

  const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
  if (results.length === 0 || results[0].count === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 };
  }

  const sorted = (results[0].durations as number[]).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    p50: sorted[Math.floor(n * 0.5)] ?? 0,
    p95: sorted[Math.floor(n * 0.95)] ?? 0,
    p99: sorted[Math.floor(n * 0.99)] ?? 0,
    count: n,
  };
}

/** Get cache hit rate over a time window. */
export async function getCacheHitRate(params: {
  db: Db;
  prefix: string;
  agentId: string;
  windowMs?: number;
}): Promise<{ hitRate: number; hits: number; misses: number; total: number }> {
  const { db, prefix, agentId, windowMs = 3600000 } = params;
  const since = new Date(Date.now() - windowMs);

  const pipeline = [
    {
      $match: {
        "meta.agentId": agentId,
        "meta.operation": "cache-check",
        ts: { $gte: since },
      },
    },
    {
      $group: {
        _id: "$cacheHit",
        count: { $sum: 1 },
      },
    },
  ];

  const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
  let hits = 0;
  let misses = 0;
  for (const r of results) {
    if (r._id === true) hits = r.count;
    else misses = r.count;
  }
  const total = hits + misses;
  return { hitRate: total > 0 ? hits / total : 0, hits, misses, total };
}

/** Get operation distribution over a time window. */
export async function getOperationDistribution(params: {
  db: Db;
  prefix: string;
  agentId: string;
  windowMs?: number;
}): Promise<Array<{ operation: TelemetryOperation; count: number; avgDurationMs: number }>> {
  const { db, prefix, agentId, windowMs = 3600000 } = params;
  const since = new Date(Date.now() - windowMs);

  const pipeline = [
    {
      $match: {
        "meta.agentId": agentId,
        ts: { $gte: since },
      },
    },
    {
      $group: {
        _id: "$meta.operation",
        count: { $sum: 1 },
        avgDurationMs: { $avg: "$durationMs" },
      },
    },
    { $sort: { count: -1 } },
  ];

  const results = await telemetryCollection(db, prefix).aggregate(pipeline).toArray();
  return results.map((r) => ({
    operation: r._id as TelemetryOperation,
    count: r.count as number,
    avgDurationMs: Math.round(r.avgDurationMs as number),
  }));
}
```

### Task 4.5: Write tests for mongodb-telemetry.ts

**Files:**

- Create: `src/memory/mongodb-telemetry.test.ts`

**Tests to write (14+ tests):**

1. `emitTelemetry calls insertOne with correct document shape`
2. `emitTelemetry adds ts field automatically`
3. `emitTelemetry does not throw on insertOne failure`
4. `emitTelemetry logs warning on failure`
5. `emitTelemetry includes optional fields when provided`
6. `emitTelemetry omits optional fields when not provided`
7. `getLatencyStats returns percentiles for matching documents`
8. `getLatencyStats returns zeros when no documents match`
9. `getLatencyStats filters by operation when provided`
10. `getLatencyStats respects windowMs parameter`
11. `getCacheHitRate calculates correct hit rate`
12. `getCacheHitRate returns zero rate when no data`
13. `getOperationDistribution groups by operation`
14. `getOperationDistribution returns empty array when no data`

**Mock pattern:** Mock telemetryCollection with vi.fn() for insertOne and aggregate.

**Step:** Run tests

```bash
pnpm test -- src/memory/mongodb-telemetry.test.ts
```

**Commit after Phase 4:**

```
Feat: add memory_telemetry time series collection with emitTelemetry and dashboard helpers
```

---

## Phase 5: Wire Telemetry Emission into 5 Code Paths

> **Exit Criteria:** emitTelemetry called from search, event write, projection run, cache check, and graph expansion. Each emission is fire-and-forget. 10+ additional tests pass.

### Task 5.1: Emit from search path (mongodb-manager.ts)

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (in search() method, after searchV2 returns)

Add import:

```typescript
import { emitTelemetry } from "./mongodb-telemetry.js";
```

After `const v2 = await searchV2(...)` and before the return:

```typescript
const searchDurationMs = Date.now() - searchStart; // Add const searchStart = Date.now() before searchV2 call
emitTelemetry(this.db, this.prefix, {
  meta: { agentId: this.agentId, operation: "search" },
  durationMs: searchDurationMs,
  ok: v2.results.length > 0,
  pathUsed: v2.metadata.pathsExecuted.join(","),
  resultCount: v2.results.length,
  topScore: v2.results[0]?.score ?? 0,
  fusionMethod: mongoCfg.fusionMethod,
});
```

### Task 5.2: Emit from event write (mongodb-manager.ts writeEventAndProject)

**Files:**

- Modify: `src/memory/mongodb-manager.ts` (in writeEventAndProject function)

After the event write and projections complete:

```typescript
emitTelemetry(db, prefix, {
  meta: { agentId, operation: "event-write" },
  durationMs: Date.now() - writeStart, // Add const writeStart = Date.now() at function start
  ok: true,
  eventType: event.role,
  projectionTriggered: true,
});
```

### Task 5.3: Emit from projection run (mongodb-ops.ts)

**Files:**

- Modify: `src/memory/mongodb-ops.ts` (in recordProjectionRun)

Add import and emit after the insertOne:

```typescript
import { emitTelemetry } from "./mongodb-telemetry.js";

// After insertOne succeeds:
emitTelemetry(db, prefix, {
  meta: { agentId: run.agentId, operation: "projection-run" },
  durationMs: run.durationMs,
  ok: run.status === "ok",
  itemCount: run.itemsProjected,
});
```

### Task 5.4: Emit from cache check (mongodb-query-cache.ts)

**Files:**

- Modify: `src/memory/mongodb-query-cache.ts` (in checkCache function)

Add import and emit at each return point:

```typescript
import { emitTelemetry } from "./mongodb-telemetry.js";

// At top of checkCache: const cacheStart = Date.now();
// Before each return:
emitTelemetry(db, prefix, {
  meta: { agentId, operation: "cache-check" },
  durationMs: Date.now() - cacheStart,
  ok: true,
  cacheHit: cacheResult.hit,
});
```

**Note:** Only emit on the final return, not on early exits (disabled, empty query).

### Task 5.5: Emit from graph expansion (mongodb-graph.ts)

**Files:**

- Modify: `src/memory/mongodb-graph.ts` (in expandGraph function)

Add import and emit after expansion completes:

```typescript
import { emitTelemetry } from "./mongodb-telemetry.js";

// After $graphLookup pipeline completes:
emitTelemetry(db, prefix, {
  meta: { agentId, operation: "graph-expansion" },
  durationMs: Date.now() - graphStart, // Add const graphStart = Date.now() at function start
  ok: true,
  resultCount: result.entities.length + result.relations.length,
});
```

### Task 5.6: Write tests for telemetry emission wiring

**Files:**

- Modify: `src/memory/mongodb-manager.test.ts` (add telemetry test block)
- Modify: `src/memory/mongodb-ops.test.ts` (add telemetry test)
- Modify: `src/memory/mongodb-query-cache.test.ts` (add telemetry test)
- Modify: `src/memory/mongodb-graph.test.ts` (add telemetry test)

**Tests per file:**

- mongodb-manager.test.ts: `search() emits search telemetry after searchV2`, `writeEventAndProject emits event-write telemetry`
- mongodb-ops.test.ts: `recordProjectionRun emits projection-run telemetry`
- mongodb-query-cache.test.ts: `checkCache emits cache-check telemetry`
- mongodb-graph.test.ts: `expandGraph emits graph-expansion telemetry`

**Mock pattern:** Use vi.mock("./mongodb-telemetry.js") to spy on emitTelemetry calls.

**Step:** Run all affected test files

```bash
pnpm test -- src/memory/mongodb-manager.test.ts src/memory/mongodb-ops.test.ts src/memory/mongodb-query-cache.test.ts src/memory/mongodb-graph.test.ts
```

### Task 5.7: Export telemetry types and functions from barrel

**Files:**

- Modify: `src/memory/index.ts`

```typescript
export {
  emitTelemetry,
  getLatencyStats,
  getCacheHitRate,
  getOperationDistribution,
  type TelemetryDocument,
  type TelemetryOperation,
  type TelemetryMeta,
} from "./mongodb-telemetry.js";
```

**Step:** Verify build

```bash
pnpm build
```

**Commit after Phase 5:**

```
Feat: wire telemetry emission into search, event write, projection, cache, and graph paths
```

---

## Phase 6: Documentation Update

> **Exit Criteria:** README updated with 22 collections, 14 MongoDB capabilities table, cache + telemetry rows. Build passes.

### Task 6.1: Update README.md capabilities table

**Files:**

- Modify: `README.md` (capabilities table at lines ~47-61)

Add two new rows to the 12-capability table (making it 14):

```markdown
| 13 | **Semantic Query Cache** | Identical or near-identical queries skip the full retrieval pipeline | SHA-256 exact match + `$vectorSearch` cosine ≥ 0.95, per-document TTL, fire-and-forget writes |
| 14 | **Time Series Telemetry** | Operational visibility into every memory operation with automatic 7-day retention | Time series collection with `granularity: "seconds"`, P50/P95/P99 latency, cache hit rates |
```

### Task 6.2: Update README.md collection count and table

**Files:**

- Modify: `README.md`

Update collection count from "20" to "22" everywhere it appears.
Update index counts from "53 standard indexes" to "58 standard indexes" and "8 search indexes" to "9 search indexes".

Add to the 20 Collections table:

```markdown
| Query cache | `query_cache` |
| Observability | `memory_telemetry` (time series) |
```

### Task 6.3: Update README.md comparison table

**Files:**

- Modify: `README.md` (comparison table at lines ~68-84)

Update "Operational visibility" row:

```markdown
| Operational visibility | Limited | Ingest runs, projection runs, relevance telemetry, time series observability |
```

Add row:

```markdown
| Query caching | None | Two-tier semantic cache (SHA-256 exact + cosine similarity) |
```

Update "Data model" row:

```markdown
| Data model | Flat files + SQLite rows | 22 collections, 58 indexes |
```

### Task 6.4: Update README.md architecture diagram

**Files:**

- Modify: `README.md` (architecture diagram at lines ~96-119)

Add cache to retrieval path:

```
Retrieval Path:
  Query -> checkCache() -> HIT? return cached results
                        -> MISS -> planRetrieval() -> score 8 paths ...
           -> writeCache() (fire-and-forget on results)
```

Add telemetry emission note:

```
Observability:
  All paths emit to memory_telemetry (time series, fire-and-forget)
```

### Task 6.5: Final validation

**Step 1:** Run type check

```bash
pnpm build
```

**Step 2:** Run all memory tests

```bash
pnpm test -- src/memory/
```

**Step 3:** Run full test suite

```bash
pnpm test
```

**Commit after Phase 6:**

```
Docs: update README with semantic cache, time series telemetry, and 22-collection architecture
```

---

## Risks

| Risk                                                          | P (1-5) | I (1-5) | Score | Mitigation                                                                       |
| ------------------------------------------------------------- | ------- | ------- | ----- | -------------------------------------------------------------------------------- |
| Time series collection creation fails on older MongoDB        | 2       | 3       | 6     | Try/catch with log.warn, degrade to no telemetry                                 |
| autoEmbed vector index on query_cache not ready at query time | 3       | 2       | 6     | Tier 2 semantic check wrapped in try/catch, degrades to Tier 1 only              |
| Cache TTL too short/long for real-world use                   | 2       | 2       | 4     | Configurable via MemoryMongoDBConfig.cache section                               |
| Fire-and-forget writes create backpressure                    | 1       | 3       | 3     | insertOne is lightweight; log.warn on error provides visibility                  |
| $vectorSearch on query_cache hits cold index (no data)        | 2       | 1       | 2     | Returns empty results, Tier 2 skipped, cache miss returned                       |
| Existing test count changes break e2e assertions              | 3       | 2       | 6     | Update EXPECTED_COLLECTION_SUFFIXES and EXPECTED_STANDARD_INDEX_COUNT in Phase 1 |

---

## Success Criteria

- [ ] `query_cache` collection with $jsonSchema, unique index, TTL index, and autoEmbed vector index
- [ ] Two-tier cache check (exact hash + semantic similarity) before search pipeline
- [ ] Fire-and-forget cache write after search results
- [ ] `memory_telemetry` time series collection with 7-day TTL
- [ ] emitTelemetry called from 5 code paths (search, event write, projection, cache, graph)
- [ ] Dashboard aggregation helpers (latency percentiles, cache hit rate, operation distribution)
- [ ] Cache and telemetry config sections in MemoryMongoDBConfig
- [ ] All new types and functions exported from barrel (index.ts)
- [ ] README updated with 14 capabilities, 22 collections, cache + telemetry
- [ ] 50+ new tests pass
- [ ] `pnpm build` exit 0
- [ ] `pnpm test` — no regressions

---

## Acceptance Checks

```bash
# Phase 1: Schema tests pass
pnpm test -- src/memory/mongodb-schema.test.ts

# Phase 2: Cache module tests pass
pnpm test -- src/memory/mongodb-query-cache.test.ts

# Phase 3: Manager integration tests pass
pnpm test -- src/memory/mongodb-manager.test.ts

# Phase 4: Telemetry module tests pass
pnpm test -- src/memory/mongodb-telemetry.test.ts

# Phase 5: All affected files pass
pnpm test -- src/memory/mongodb-manager.test.ts src/memory/mongodb-ops.test.ts src/memory/mongodb-query-cache.test.ts src/memory/mongodb-graph.test.ts

# Phase 6: Full suite + build
pnpm build
pnpm test
```
