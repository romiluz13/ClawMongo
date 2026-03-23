# MongoDB Docs Research: Almost Perfect Sprint (8 Harmony-Filtered Steal Items)

**Date:** 2026-03-23
**Sources:** MongoDB official docs (8.2), MongoDB Knowledge Base, Bright Data scrapes
**Purpose:** Bible for the Almost Perfect sprint plan. Every feature verified against MongoDB capabilities.

---

## 1. Tiered Token-Efficient Retrieval ($project after $vectorSearch)

**Source:** https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/

**MongoDB Docs Confirmation:**

> The `$vectorSearch` stage is the first stage in an aggregation pipeline. You can use standard aggregation stages after `$vectorSearch` to process the results.

`$project` can follow `$vectorSearch` to return only `_id` + score:

```js
db.collection.aggregate([
  { "$vectorSearch": { index: "...", path: "embedding", queryVector: [...], numCandidates: 100, limit: 20 } },
  { "$project": { "_id": 1, "score": { "$meta": "vectorSearchScore" }, "title": 1 } }
])
```

**For ClawMongo:** Add `projection` parameter to `searchV2()` and `searchEpisodes()`. When `projection: "ids-only"`, use `$project: { _id: 1, score: { $meta: "vectorSearchScore" }, agentId: 1 }`. Add `getEpisodesByIds(ids[], fullContent: boolean)` for the expand step.

**Verdict:** NATIVE | **Risk:** LOW

---

## 2. Mutation Audit Trail (Change Streams with Pre/Post Images)

**Source:** https://www.mongodb.com/docs/manual/changeStreams/ (MongoDB 8.2 Current)

**MongoDB Docs Confirmation:**

> Starting in MongoDB 6.0, you can use change stream events to output the version of a document before and after changes (the document pre- and post-images).
>
> Enable `changeStreamPreAndPostImages` for a collection using `db.createCollection()`, `create`, or `collMod`:
>
> ```javascript
> db.runCommand({ collMod: <collection>, changeStreamPreAndPostImages: { enabled: true } })
> ```

**Update Event Fields** (from https://www.mongodb.com/docs/manual/reference/change-events/update/):

- `updateDescription.updatedFields` — document with keys for modified fields and new values
- `updateDescription.removedFields` — array of removed field names
- `updateDescription.truncatedArrays` — records array truncations
- `fullDocumentBeforeChange` — full document pre-image (when enabled)
- `fullDocument` — post-image (with `updateLookup` or pre/post images enabled)

**Important Constraints:**

> - Pre-images are written to `config.system.preimages` collection
> - Enabling pre- and post-images consumes storage space and adds processing time
> - `expireAfterSeconds` controls retention (can be set cluster-wide)
> - Pre-images are removed asynchronously by a background process

**For ClawMongo — SIMPLER ALTERNATIVE:** Instead of Change Streams (which require replica set watchers), use an **application-level audit trail**:

- New `memory_mutations` collection
- On every `structured_mem`, `entity`, or `relation` write, also write a mutation record: `{ collectionName, documentId, operation: "add"|"update"|"delete", oldValue, newValue, timestamp, agentId, actorRole }`
- TTL index: `{ timestamp: 1 }, { expireAfterSeconds: 7776000 }` (90 days)
- This is simpler, doesn't require `changeStreamPreAndPostImages` enabled, works on any MongoDB deployment

**Verdict:** NATIVE (Change Streams) or NATIVE (app-level) | **Risk:** LOW (app-level preferred)

---

## 3. Status Lifecycle ($vectorSearch Pre-Filter on Enum Fields)

**Source:** https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/#atlas-vector-search-pre-filter

**MongoDB Docs Confirmation:**

> The `$vectorSearch` `filter` option matches BSON boolean, date, objectId, numeric, string, and UUID values, including arrays of these types.
>
> Supported operators: `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$nor`, `$and`, `$or`

**Key requirement:** Fields used in filter MUST be indexed as `filter` type in the vectorSearch index definition:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
    { "type": "filter", "path": "status" },
    { "type": "filter", "path": "agentId" }
  ]
}
```

**For ClawMongo:** Add `status` field to episodes/chunks schemas with values: `activated | archived | deleted`. Add `status` as `filter` type in vector search index definitions. Default retrieval filters `{ status: { $ne: "deleted" } }`. Structured memory already has `state: active|invalidated|conflicted` — extend to all collections.

**Verdict:** NATIVE | **Risk:** LOW

---

## 4. Procedural Memory Evolution (Document Versioning Pattern)

**Source:** https://www.mongodb.com/docs/manual/tutorial/model-data-for-schema-versioning/

**MongoDB Docs Confirmation:**

> The Schema Versioning pattern uses a `schema_version` field in each document. Applications route document processing based on this field value.

**For ClawMongo — Document Versioning Pattern:**
The `procedures` collection already exists in schema with: `procedureId`, `steps`, `successSignals`, `confidence`, `openedCount`, `lastUsedAt`.

**Missing fields to add:**

- `version: number` (current version, atomic `$inc`)
- `successCount: number` / `failCount: number` (atomic `$inc`)
- `lastSuccessAt: Date` / `lastFailureAt: Date`
- `evolutionHistory: Array<{ version, changeType, changeDescription, timestamp }>` (embedded, capped at 20)
- `trigger: string` (what triggers this procedure)

**Atomic version bump:**

```js
db.procedures.updateOne(
  { procedureId, agentId },
  {
    $inc: { version: 1, successCount: 1 },
    $set: { lastSuccessAt: new Date(), steps: newSteps },
    $push: {
      evolutionHistory: {
        $each: [
          {
            version: oldVersion,
            changeType: "step_modified",
            changeDescription: "...",
            timestamp: new Date(),
          },
        ],
        $slice: -20,
      },
    },
  },
);
```

`$push` with `$slice: -20` keeps the array bounded. `$inc` is atomic. No transaction needed.

**Verdict:** NATIVE | **Risk:** LOW

---

## 5. Conservative Graph Deletion ($graphLookup for Conflict Detection)

**Source:** https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/

**MongoDB Docs Confirmation:**

> `$graphLookup` performs a recursive search on a collection. Parameters:
>
> - `from` — target collection
> - `startWith` — expression for starting value
> - `connectFromField` — field in documents to use for recursive lookup
> - `connectToField` — field to match against
> - `as` — name of the output array
> - `maxDepth` — optional maximum recursion depth
> - `restrictSearchWithMatch` — optional additional match condition

**For ClawMongo:** The graph deletion feature doesn't need $graphLookup directly — it's an **application-level LLM arbitration** pattern:

1. When `extractAndUpsertEntities` finds new relations, query existing relations for the same entity pair
2. If conflicting (same `fromEntityId` + `toEntityId` but different `relationType`), call LLM with:
   - Existing relation(s)
   - New relation(s)
   - Decision: DELETE existing (contradictory) or KEEP BOTH (additive)
3. Conservative rule: "loves pizza" + "loves burger" → KEEP BOTH (same relationType, different target)
4. Write deletion audit to `memory_mutations` collection (from item #2)

**No new MongoDB features needed** — this is pure application logic + existing `updateOne`/`deleteOne`.

**Verdict:** NATIVE (no new MongoDB features) | **Risk:** LOW

---

## 6. Working Memory Bounds ($sort + $limit Optimization)

**Source:** https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/

**MongoDB Docs Confirmation:**

> When a `$sort` precedes a `$limit` and there are no intervening stages that modify the number of documents, the optimizer can coalesce the `$limit` into the `$sort`. This allows the sort operation to only maintain the top n results as it progresses, where n is the specified limit.

**For ClawMongo:** Add configurable `workingMemoryBound` (default: 50) to session event queries. When fetching events for context injection:

```js
db.events.find({ agentId, sessionId }).sort({ timestamp: -1 }).limit(workingMemoryBound);
```

MongoDB optimizes this to only track top-N during sort (no full sort needed). Existing compound index `{ agentId: 1, timestamp: -1 }` already supports this pattern.

**Verdict:** NATIVE | **Risk:** LOW

---

## 7. Temporal Grounding in Entity Extraction (Prompt-Level)

**No MongoDB feature needed.** This is a prompt engineering change in `mongodb-entity-extractor.ts`.

**Enhancement:** Add to entity extraction prompt:

> "When extracting facts, ALWAYS include dates/times if mentioned in the text. Example: 'attended meeting on May 7, 2023' should be extracted as-is with the date."

Add optional `extractedAt` field to entities for when extraction happened (already exists as `updatedAt`).

**Verdict:** N/A (prompt only) | **Risk:** LOW

---

## 8. Role-Based Memory Extraction (Prompt-Level)

**No MongoDB feature needed.** This is a prompt engineering change in `mongodb-entity-extractor.ts`.

**Enhancement:** In the LLM entity extraction code path:

- If event `role === "assistant"`, use `AGENT_MEMORY_EXTRACTION_PROMPT` (captures agent capabilities, tool usage, approach patterns)
- If event `role === "user"`, use `USER_MEMORY_EXTRACTION_PROMPT` (captures user preferences, facts, relationships)
- Prevents the LLM from hallucinating user preferences from assistant responses

**For ClawMongo:** Already tracks `role` on events. Add `sourceRole: "user" | "assistant"` field to entities to distinguish extraction source.

**Verdict:** N/A (prompt only) | **Risk:** LOW

---

## Summary Table

| #   | Feature                     | MongoDB Feature Used                          | Verdict | Risk | New Collection?         | Schema Change?                        |
| --- | --------------------------- | --------------------------------------------- | ------- | ---- | ----------------------- | ------------------------------------- |
| 1   | Tiered retrieval            | `$project` after `$vectorSearch`              | NATIVE  | LOW  | No                      | Add projection param                  |
| 2   | Mutation audit trail        | App-level audit (simpler than Change Streams) | NATIVE  | LOW  | Yes: `memory_mutations` | New collection + TTL index            |
| 3   | Status lifecycle            | `$vectorSearch` pre-filter on string          | NATIVE  | LOW  | No                      | Add `status` field to episodes/chunks |
| 4   | Procedural memory evolution | `$inc`, `$push` with `$slice`, atomic updates | NATIVE  | LOW  | No (collection exists)  | Add version/evolution fields          |
| 5   | Conservative graph deletion | `updateOne`/`deleteOne` (application logic)   | NATIVE  | LOW  | No                      | No                                    |
| 6   | Working memory bounds       | `$sort` + `$limit` optimization               | NATIVE  | LOW  | No                      | Add config param                      |
| 7   | Temporal grounding          | None (prompt only)                            | N/A     | LOW  | No                      | Optional field                        |
| 8   | Role-based extraction       | None (prompt only)                            | N/A     | LOW  | No                      | Add `sourceRole` field                |

## Overall Risk Assessment

**ALL 8 ITEMS: LOW RISK, NATIVE MongoDB support.**

- 0 items fighting the database
- 1 new collection (`memory_mutations`)
- 6 schema additions to existing collections (fields only, no structural changes)
- 2 prompt-only changes (zero schema impact)
- All patterns documented in official MongoDB docs
- All compatible with existing ClawMongo architecture
- All testable in atlas-local:preview Docker environment
