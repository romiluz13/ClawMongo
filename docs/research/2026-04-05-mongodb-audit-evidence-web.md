# MongoDB Audit Evidence Dossier - Official Docs Only

> Research date: 2026-04-05
> Research mode: MongoDB official web documentation only
> Repo scope: `src/memory/*`
> Goal: map each MongoDB audit finding to official MongoDB documentation, then compare that documentation to the current code on `main`

---

## Scope

This note covers the MongoDB surfaces involved in the earlier ClawMongo memory audit:

1. Atlas Search field mappings and boolean filtering
2. Atlas Vector Search pre-filtering and stage behavior
3. MongoDB data modeling guidance for chunk-level retrieval
4. Regex search versus Atlas Search
5. Change stream resumability
6. Atlas Stream Processing as a neighboring MongoDB technology that was considered but is not the root of these findings

The intent here is strict:

- use MongoDB official docs as the source of truth
- use repo code only as evidence of what ClawMongo does
- separate direct doc rules from repo-specific inferences

---

## Source List

- Define Field Mappings
  - <https://www.mongodb.com/docs/atlas/atlas-search/define-field-mappings/>
- Atlas Search `compound`
  - <https://www.mongodb.com/docs/atlas/atlas-search/operators-collectors/compound/>
- Atlas Search `range`
  - <https://www.mongodb.com/docs/atlas/atlas-search/operators-collectors/range/>
- MongoDB Vector Search Overview
  - <https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/>
- `$vectorSearch` Aggregation Stage
  - <https://www.mongodb.com/docs/manual/reference/operator/aggregation/vectorsearch/>
- Vector Search tutorial and query docs
  - <https://www.mongodb.com/docs/atlas/atlas-vector-search/tutorials/vector-search-tutorial/>
- Use MongoDB Search Instead of Regex Queries
  - <https://www.mongodb.com/docs/atlas/schema-suggestions/case-insensitive-regex/>
- MongoDB Data Modeling
  - <https://www.mongodb.com/docs/v8.0/data-modeling/>
- Change Streams
  - <https://www.mongodb.com/docs/manual/changestreams/>
- Atlas Stream Processing
  - <https://www.mongodb.com/docs/atlas/atlas-stream-processing/>

---

## Reading Key

- **Doc rule** means MongoDB documentation states the behavior directly.
- **Inference from docs** means MongoDB documentation states enough behavior that the repo risk follows logically, even if the docs do not mention this repo's exact pattern.
- **Current status** reflects the code currently on `main`, not the historical pre-fix state.

---

## 1. Chunk `status` Filtering and Search Index Coverage

### Historical finding

Conversation and bridge chunk retrieval filtered on `status != "deleted"` while the search path depended on Atlas Search and Vector Search indexes.

### MongoDB official documentation

- Atlas Search field mapping docs say that with static mappings, Atlas Search indexes only the fields you explicitly specify.
- MongoDB Vector Search docs say you can pre-filter with `$vectorSearch` against indexed fields.
- Atlas Search compound docs say exclusion belongs in `mustNot`, while non-scoring constraints belong in `filter`.

### Why the finding was valid

If a field is used as a Search or Vector Search filter but is not included in the relevant index definition, the query shape does not match the documented MongoDB indexing model.

That makes this a **doc rule**, not just a tuning preference.

### Repo evidence

- Filter usage:
  - `src/memory/mongodb-manager.ts:621`
- Current Atlas Search mapping includes `status`:
  - `src/memory/mongodb-schema.ts:1500`
- Current Vector Search filter fields include `status`:
  - `src/memory/mongodb-schema.ts:1537`

### Assessment

The original finding was correct under MongoDB docs. The current code now aligns with the docs because `status` is explicitly indexed for both Atlas Search and Vector Search.

### Current status

Resolved on `main`.

---

## 2. Search Boolean and Range Semantics

### Historical finding

The search layer needed to express exclusion and time windows in Atlas Search rather than relying on weaker post-filter paths.

### MongoDB official documentation

- Atlas Search `compound` documents `must`, `mustNot`, `should`, and `filter`.
- Atlas Search `range` documents numeric and date range constraints.
- Atlas Search operator docs consistently frame `filter` as the right place for non-scoring constraints.

### Why the finding was valid

This is a **doc rule**. MongoDB documents the intended boolean and range query structure for Atlas Search. If exclusion or range filtering is left outside the search stage when the stage itself supports that logic, the query shape is weaker than the documented pattern.

### Repo evidence

- Vector/search stage builder:
  - `src/memory/mongodb-search.ts:246`
- Current chunk filter uses indexed date and status fields:
  - `src/memory/mongodb-manager.ts:621`
  - `src/memory/mongodb-manager.ts:642`

### Assessment

The underlying concern was doc-backed. The repo now has the required indexed fields in place, which is the prerequisite for doc-aligned filtering.

### Current status

Substantially aligned on `main`.

---

## 3. Structured Memory `currentOnly` and Vector Stage Eligibility

### Historical finding

Freshness logic for structured memory needed to run inside the vector stage filter, not after vector retrieval had already been limited.

### MongoDB official documentation

- `$vectorSearch` is documented as a dedicated aggregation stage for semantic retrieval.
- MongoDB docs say `$vectorSearch` can pre-filter against indexed fields.
- MongoDB docs also make clear that `$vectorSearch` is a pipeline stage and later aggregation stages operate on the output of earlier stages.

### Why the finding was valid

This is an **inference from docs**.

MongoDB does not say, in these exact words, "post-filtering after `$vectorSearch` can drop valid results." But once the docs establish:

- the vector stage performs retrieval,
- the vector stage supports pre-filtering,
- later stages only process stage output,

it follows that eligibility logic like "current only" belongs in the vector filter if it is supposed to constrain which documents can occupy the retrieval budget.

### Repo evidence

- Current `currentOnly` logic is pushed into the vector filter:
  - `src/memory/mongodb-structured-memory.ts:688`
- Current vector stage still uses `limit: opts.maxResults`:
  - `src/memory/mongodb-structured-memory.ts:695`
- Current structured memory vector index includes the filterable lifecycle fields:
  - `src/memory/mongodb-schema.ts:1694`

### Assessment

The original concern was valid from documented stage behavior. The repo now matches the doc-backed retrieval model by indexing and filtering on `state`, `temporalScope`, `validFrom`, and `validTo`.

### Current status

Resolved on `main`.

---

## 4. KB Search Metadata Placement

### Historical finding

Knowledge-base metadata filters should operate on the chunk documents that are actually searched, rather than depending on a separate parent-document narrowing pass.

### MongoDB official documentation

- MongoDB data modeling docs emphasize a central principle: data that is accessed together should be stored together.
- The same modeling guidance recommends shaping documents around access patterns rather than preserving normalized entity separation when that increases query cost.

### Why the finding was valid

This is a **MongoDB best-practice rule**, not a single operator constraint.

MongoDB docs do not say "a 10k parent-doc cap is invalid." That specific incompleteness risk was repo-specific. But the docs strongly support placing retrieval-time metadata on the searched chunk documents themselves if chunk search is the access path.

### Repo evidence

- KB chunks now mirror `sourceType`, `category`, and `tags`:
  - `src/memory/mongodb-kb.ts:150`
- KB chunk schema now validates those mirrored fields:
  - `src/memory/mongodb-schema.ts:170`
- KB search and vector index definitions now index those mirrored fields:
  - `src/memory/mongodb-schema.ts:1584`
  - `src/memory/mongodb-schema.ts:1619`
- KB search now builds chunk-local filters directly:
  - `src/memory/mongodb-kb-search.ts:58`

### Assessment

The original finding was best understood as a MongoDB modeling issue: the queried unit and the filtered unit should match. The current code now matches MongoDB’s data-modeling guidance much better.

### Current status

Resolved on `main`.

---

## 5. Regex Search Versus Atlas Search

### Historical finding

Entity and episode lookups should use Atlas Search rather than regex-based search patterns for user-facing retrieval.

### MongoDB official documentation

- MongoDB’s schema suggestion docs explicitly recommend using MongoDB Search instead of case-insensitive regex queries.
- The docs explain that regex search can be inefficient and may not use indexes effectively for search-style workloads.
- MongoDB positions Atlas Search as the correct solution for relevance-ranked text retrieval, multi-field text search, and search-style matching behavior.

### Why the finding was valid

This is the clearest **doc rule** in the set. MongoDB explicitly tells users to prefer Atlas Search over regex for these workloads.

### Repo evidence

- Current entity lookup uses `$search`:
  - `src/memory/mongodb-graph.ts:480`
- Current episode lookup uses `$search` with `mustNot` for deleted rows:
  - `src/memory/mongodb-episodes.ts:424`

### Assessment

The original regex concern was fully supported by MongoDB docs. The repo now follows MongoDB’s documented recommendation.

### Current status

Resolved on `main`.

---

## 6. Change Stream Resumability

### Historical finding

Transient change-stream failures should reopen the stream from the latest resume token instead of only logging the error.

### MongoDB official documentation

- Change stream docs describe resumable behavior using `resumeAfter` and `startAfter`.
- MongoDB docs show reopening a change stream from the last known token after interruption.
- MongoDB docs also note operational considerations around change streams and connections.

### Why the finding was valid

This is a **doc rule**. If the application persists resume tokens and intends continuous watching, then reopening from `resumeAfter` is the documented MongoDB recovery path.

### Repo evidence

- Current watcher supports `resumeAfter` on startup:
  - `src/memory/mongodb-change-stream.ts:53`
- Current runtime error handling resumes from the last token:
  - `src/memory/mongodb-change-stream.ts:82`

### Assessment

The original finding was directly supported by MongoDB’s change-stream docs. The current code now follows that guidance.

### Current status

Resolved on `main`.

---

## 7. Atlas Stream Processing Review

### Historical finding

Atlas Stream Processing was named as a skill to consider, so it needed to be evaluated as a possible root technology.

### MongoDB official documentation

- Atlas Stream Processing is documented as a streaming system for continuously processing data from sources such as Kafka, Atlas change streams, and other event streams.
- Its role is pipeline-oriented stream transformation and enrichment, not Atlas Search or Vector Search query design.

### Why it was not the root of these issues

This is a **technology-boundary assessment** based on the docs.

The audit findings were about:

- Atlas Search mappings
- Vector Search filter fields
- chunk-level data modeling
- regex anti-patterns
- change stream resumability

Those are separate MongoDB surfaces from Atlas Stream Processing.

### Repo evidence

No repo path in the audited memory layer currently uses Atlas Stream Processing as the implementation surface for these retrieval paths.

### Assessment

Reviewing ASP was still correct, but MongoDB’s own product docs show it is not the technology that explains these findings.

### Current status

Not applicable as the root cause for this audit set.

---

## Final Verdict

### Fully doc-backed findings

- chunk filter fields must be indexed for Search and Vector Search
- Atlas Search boolean exclusion should use documented boolean operators
- regex search should be replaced by Atlas Search for search workloads
- change streams should resume using resume tokens

### Doc-backed best-practice findings

- KB metadata should live on the searched chunk documents because data accessed together should be stored together

### Findings that require one inference step from documented behavior

- `currentOnly` belongs inside the vector filter because later pipeline stages only operate on the vector stage output, and the stage itself has a retrieval limit

---

## Repo Status Summary

The key point after the reread is not that the audit was overstated. It is the opposite:

- the original findings were well-grounded in MongoDB documentation
- the repo now reflects those MongoDB recommendations much more closely than it did before the fixes

The one MongoDB-adjacent technology that did not end up mattering for root-cause analysis was Atlas Stream Processing, because the audited problems belonged to Search, Vector Search, data modeling, and change streams instead.
