# Web Research: MongoDB API Validation for ClawMongo

## Execution

- Preferred backend: websearch+webfetch
- Allowed fallbacks: webfetch-only
- Research round: 1

## Sources Used

- WebFetch: MongoDB raw GitHub docs (RST source files) -- primary source for most items
- WebFetch: MongoDB server source code on GitHub (IDL files) -- for $rankFusion/$scoreFusion confirmation
- WebFetch: mongodb.com/docs (CSS rendering issues on main site; raw sources used instead)
- Codebase verification: direct file reads of ClawMongo source

## Research Quality

- Status: COMPLETE
- Quality level: high
- Backend mode: websearch+webfetch

---

## 1. `$percentile` Aggregation with `method: "approximate"`

**ClawMongo usage** (`src/memory/mongodb-telemetry.ts:98`):

```js
{ $percentile: { input: "$durationMs", p: [0.5], method: "approximate" } }
```

**Verdict: VALID**

- Introduced in **MongoDB 7.0** (GA).
- The parameter is `p` (not `k`) -- ClawMongo uses `p` correctly.
- `p` accepts an array of values between 0.0 and 1.0 inclusive.
- The `method` parameter currently accepts **only** `"approximate"` -- this is the only documented valid value.
- Returns an array in the same order as elements in `p`.
- ClawMongo correctly accesses `results[0].p50?.[0]` since the result is an array.

**References:**

- https://raw.githubusercontent.com/mongodb/docs/master/source/reference/operator/aggregation/percentile.txt
- https://www.mongodb.com/docs/manual/reference/operator/aggregation/percentile/

---

## 2. Time Series Collection with `granularity: "seconds"` and `expireAfterSeconds`

**ClawMongo usage** (`src/memory/mongodb-schema.ts:839-846`):

```js
await db.createCollection(telemetryName, {
  timeseries: {
    timeField: "ts",
    metaField: "meta",
    granularity: "seconds",
  },
  expireAfterSeconds: 604800, // 7 days
});
```

**Verdict: VALID**

### Granularity

- Valid values: `"seconds"`, `"minutes"`, `"hours"`.
- `"seconds"` is valid and sets bucket max span to 1 hour.
- Time series collections introduced in **MongoDB 5.0**.
- Since MongoDB 6.3, custom `bucketMaxSpanSeconds` and `bucketRoundingSeconds` are also available as alternatives to `granularity`.

### expireAfterSeconds on time series

- **Supported.** Documents expire based on `timeField` value + `expireAfterSeconds`.
- A background task runs every ~60 seconds to remove expired buckets.
- Deletion is not instantaneous; documents may persist briefly beyond expiration.
- Can be set at `createCollection` time (as ClawMongo does) or modified later with `collMod`.
- Can be disabled by setting `expireAfterSeconds: "off"`.

**References:**

- https://raw.githubusercontent.com/mongodb/docs/master/source/core/timeseries/timeseries-granularity.txt
- https://raw.githubusercontent.com/mongodb/docs/master/source/core/timeseries/timeseries-automatic-removal.txt
- https://www.mongodb.com/docs/manual/core/timeseries-collections/

---

## 3. `$graphLookup` with `restrictSearchWithMatch`

**ClawMongo usage** (`src/memory/mongodb-graph.ts:633-646`):

```js
{
  $graphLookup: {
    from: `${prefix}relations`,
    startWith: "$toEntityId",
    connectFromField: "toEntityId",
    connectToField: "fromEntityId",
    as: "transitiveRelations",
    maxDepth: graphLookupDepth,
    depthField: "depth",
    restrictSearchWithMatch: {
      agentId,
      ...(scope ? { scope } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    },
  },
}
```

**Verdict: VALID**

- `restrictSearchWithMatch` is the **correct parameter name**.
- It specifies additional filter conditions for the recursive search using standard query filter syntax.
- **Limitation:** You cannot use aggregation expressions inside `restrictSearchWithMatch` -- only literal values and standard query operators are permitted. No cross-document field comparisons.
- All parameters used by ClawMongo (`from`, `startWith`, `connectFromField`, `connectToField`, `as`, `maxDepth`, `depthField`, `restrictSearchWithMatch`) are valid.
- ClawMongo's use of `restrictSearchWithMatch` for tenant isolation (filtering by `agentId`, `scope`, `scopeRef`) is a correct and recommended pattern.

**Full parameter list:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `from` | Yes | Target collection |
| `startWith` | Yes | Expression for initial traversal value |
| `connectFromField` | Yes | Field to recursively match from |
| `connectToField` | Yes | Field to match against in target docs |
| `as` | Yes | Output array field name |
| `maxDepth` | No | Maximum recursion depth |
| `depthField` | No | Field name for depth tracking |
| `restrictSearchWithMatch` | No | Additional query filter for traversal |

**References:**

- https://raw.githubusercontent.com/mongodb/docs/master/source/reference/operator/aggregation/graphLookup.txt
- https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/

---

## 4. `$rankFusion`

**ClawMongo usage** (`src/memory/mongodb-search.ts:542`):

```js
{
  $rankFusion: {
    input: {
      pipelines: {
        vector: [{ $vectorSearch: vsStage }],
        text: [{ $search: { ... } }],
      },
    },
    combination: { weights: { vector: opts.vectorWeight, text: opts.textWeight } },
  },
}
```

**Verdict: EXISTS -- but availability is limited to MongoDB Atlas with mongot**

- `$rankFusion` **exists** in the MongoDB server codebase (confirmed in `src/mongo/db/pipeline/document_source_rank_fusion.h` and `.idl`).
- Copyright header indicates 2024 introduction.
- Codebase comments label it as **MongoDB 8.0+**.
- It is a **hybrid search stage** that combines multiple sub-pipelines using Reciprocal Rank Fusion (RRF).

**IDL-confirmed parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `input` | Yes | Set of sub-pipelines whose results are merged |
| `combination` | No | Weights map (input name -> double weight, default 1) |
| `scoreDetails` | No | Boolean (default false) to include score breakdown |

**Important caveat:** `$rankFusion` requires **Atlas Search** infrastructure (mongot). It is not available on standalone/community MongoDB deployments. The ClawMongo codebase correctly guards this behind a `capabilities.rankFusion` check and falls back to JS-merge when unavailable.

**References:**

- https://github.com/mongodb/mongo/blob/master/src/mongo/db/pipeline/document_source_rank_fusion.h
- https://github.com/mongodb/mongo/blob/master/src/mongo/db/pipeline/document_source_rank_fusion.idl

---

## 5. `$scoreFusion`

**ClawMongo usage** (`src/memory/mongodb-search.ts:434`):

```js
{
  $scoreFusion: {
    input: {
      pipelines: {
        vector: [{ $vectorSearch: vsStage }],
        text: [{ $search: { ... } }],
      },
    },
    combination: { weights: { vector: opts.vectorWeight, text: opts.textWeight } },
  },
}
```

**Verdict: EXISTS -- but availability is limited to MongoDB Atlas with mongot**

- `$scoreFusion` **exists** in the MongoDB server codebase (confirmed in `src/mongo/db/pipeline/document_source_score_fusion.h`, `.cpp`, `.idl`).
- ClawMongo labels it as **MongoDB 8.2+** (newer than $rankFusion).
- It is a score-based fusion variant (combines normalized scores rather than using rank positions).
- Has companion `score_fusion_pipeline_builder` utilities.
- Source code shows `isHybridSearchStage()` returning true, confirming it is part of the hybrid search subsystem.

**Same Atlas/mongot caveat as $rankFusion.** ClawMongo correctly guards behind `capabilities.scoreFusion` with fallback chain: `$scoreFusion` -> `$rankFusion` -> JS-merge.

**References:**

- https://github.com/mongodb/mongo/blob/master/src/mongo/db/pipeline/document_source_score_fusion.h
- https://github.com/mongodb/mongo/blob/master/src/mongo/db/pipeline/document_source_score_fusion.idl

---

## 6. `cursor.sort()` vs `.toSorted()` on FindCursor

**ClawMongo usage** (multiple files):

```js
.sort({ timestamp: 1, _id: 1 })
.sort({ timestamp: -1 })
.sort({ startLine: 1 })
.sort({ "timeRange.start": -1 })
```

**Verdict: VALID -- `.sort()` is correct**

- `.sort(sort: Sort | string, direction?: SortDirection): this` is a **defined method** on `FindCursor` in the MongoDB Node.js driver.
- `.toSorted()` does **NOT exist** on FindCursor. It is a JavaScript `Array.prototype.toSorted()` method (ES2023) and is unrelated to MongoDB cursors.
- ClawMongo correctly uses `.sort()` on cursor chains before `.limit()` and `.toArray()`.
- The oxlint `unicorn/no-array-sort` disable comments in the codebase are appropriate since cursor `.sort()` is not `Array.sort()`.

**Other confirmed FindCursor methods used by ClawMongo:** `.filter()`, `.limit()`, `.skip()`, `.project()`, `.sort()`, `.toArray()`, `.map()`, `.explain()`, `.collation()`, `.allowDiskUse()`, `.hint()`, `.maxTimeMS()`.

**References:**

- https://raw.githubusercontent.com/mongodb/node-mongodb-native/main/src/cursor/find_cursor.ts
- https://www.mongodb.com/docs/drivers/node/current/fundamentals/crud/read-operations/sort/

---

## 7. `validationAction: "error"` and `validationLevel: "moderate"`

**ClawMongo usage** (`src/memory/mongodb-schema.ts:826-827`):

```js
{
  validator,
  validationLevel: "moderate",
  validationAction: "error",
}
```

**Verdict: VALID**

### validationLevel

- Valid values: `"strict"` (default) and `"moderate"`.
- `"strict"`: Applies validation to all inserts and updates.
- `"moderate"`: Validates inserts and updates to documents that already comply with the schema. Existing non-compliant documents are not forced to validate on update.
- ClawMongo's use of `"moderate"` is a good choice for migration-safe schemas (won't break existing documents that predate schema validation).

### validationAction

- Valid values: `"error"` (default), `"warn"`, and `"errorAndLog"` (added in MongoDB 8.1).
- `"error"`: Rejects any insert or update that violates validation.
- `"warn"`: Allows the operation but logs the violation.
- `"errorAndLog"`: Rejects and logs (MongoDB 8.1+).
- ClawMongo's use of `"error"` ensures invalid writes fail fast, which is the recommended approach for data integrity.

**References:**

- https://raw.githubusercontent.com/mongodb/docs/master/source/core/schema-validation/specify-validation-level.txt
- https://raw.githubusercontent.com/mongodb/docs/master/source/core/schema-validation/handle-invalid-documents.txt
- https://www.mongodb.com/docs/manual/core/schema-validation/

---

## 8. `expireAfterSeconds: 0` with Document-Level TTL

**ClawMongo usage** (`src/memory/mongodb-schema.ts:1263-1266`):

```js
await queryCache.createIndex(
  { expiresAt: 1 },
  { name: "idx_query_cache_ttl", expireAfterSeconds: 0 },
);
```

**Verdict: VALID**

- Setting `expireAfterSeconds: 0` on a TTL index means **no additional seconds are added** to the indexed field value.
- Documents expire when `current_time >= expiresAt` (the date stored in the document).
- This enables **document-level TTL**: each document controls its own expiration by setting a specific `Date` value in the `expiresAt` field.
- The indexed field must contain `Date` values. Documents without a date in the indexed field (or with a non-date value) will never expire.
- The TTL background task runs approximately every 60 seconds, so deletion is not instantaneous.
- Only one TTL index is typically enforced per collection.
- ClawMongo's query cache pattern is a textbook use of document-level TTL -- each cached query result sets its own `expiresAt` based on the configured cache duration.

**Comparison:**
| Pattern | Index | Behavior |
|---------|-------|----------|
| Fixed TTL | `expireAfterSeconds: 3600` | All docs expire 3600s after their date field |
| Document-level TTL | `expireAfterSeconds: 0` | Each doc expires at its own `expiresAt` date |

**References:**

- https://www.mongodb.com/docs/manual/tutorial/expire-data/
- https://www.mongodb.com/docs/manual/core/index-ttl/

---

## What Changed the Recommendation

All 8 MongoDB API usages in ClawMongo are **valid and correctly implemented**. The only nuance is that `$rankFusion` and `$scoreFusion` require Atlas Search infrastructure (mongot) and are not available on standalone/community MongoDB -- but ClawMongo already handles this correctly with capability detection and a JS-merge fallback chain.

The `$percentile` operator supports **only** `"approximate"` as the method value (there is no alternative), which matches ClawMongo's usage. The parameter name `p` (not `k`) is correct.

The `"errorAndLog"` validation action (MongoDB 8.1+) could be a useful addition for ClawMongo if production debugging is needed -- it combines rejection with server-side logging.

## Gotchas / Warnings

1. **$percentile `method` parameter**: Only `"approximate"` is valid. There is no `"exact"` or `"interpolated"` alternative. If a future MongoDB version adds methods, the current code would need updating.

2. **$rankFusion/$scoreFusion availability**: These require mongot (Atlas Search). They are NOT available on:
   - Standalone MongoDB (community or enterprise)
   - Self-hosted MongoDB without Atlas Search
   - atlas-local-dev images without mongot sidecar

3. **Time series TTL granularity**: With `granularity: "seconds"`, the bucket span is 1 hour. This means the actual minimum retention may be up to 1 hour longer than `expireAfterSeconds` suggests, since MongoDB deletes entire buckets.

4. **$graphLookup `restrictSearchWithMatch`**: Cannot use aggregation expressions (like `$eq`, `$expr`) inside this filter. Only standard query operators with literal values work. ClawMongo's usage (literal `agentId`, `scope`, `scopeRef` values) is correct.

5. **Document-level TTL background task**: Runs every ~60 seconds. Under heavy write load, expired documents may be visible for up to 60 seconds after their `expiresAt` time. Cache reads should check `expiresAt` in application code if sub-minute precision is required.

6. **FindCursor `.sort()` linting**: The oxlint `unicorn/no-array-sort` rule may flag cursor `.sort()` calls. ClawMongo correctly suppresses these with inline comments.

## References

- MongoDB $percentile: https://www.mongodb.com/docs/manual/reference/operator/aggregation/percentile/
- MongoDB Time Series Granularity: https://www.mongodb.com/docs/manual/core/timeseries/timeseries-granularity/
- MongoDB Time Series TTL: https://www.mongodb.com/docs/manual/core/timeseries/timeseries-automatic-removal/
- MongoDB $graphLookup: https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/
- MongoDB Schema Validation: https://www.mongodb.com/docs/manual/core/schema-validation/
- MongoDB TTL Indexes: https://www.mongodb.com/docs/manual/core/index-ttl/
- MongoDB Node.js Driver FindCursor: https://github.com/mongodb/node-mongodb-native/blob/main/src/cursor/find_cursor.ts
- MongoDB Server $rankFusion source: https://github.com/mongodb/mongo/blob/master/src/mongo/db/pipeline/document_source_rank_fusion.idl
- MongoDB Server $scoreFusion source: https://github.com/mongodb/mongo/blob/master/src/mongo/db/pipeline/document_source_score_fusion.h

---

Web research complete.
