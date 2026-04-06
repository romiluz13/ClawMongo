# Dreaming + Wiki: MongoDB-Native Evaluation (Wave 7)

> **Status:** Evaluation only. No implementation.
> **Date:** 2026-04-06
> **Context:** Upstream added Dreaming (memory-core plugin) and Wiki (memory-wiki plugin) during the Wave 7 window (4,510 commits). This document evaluates both concepts for potential MongoDB-native re-implementation.

## Executive Summary

Upstream's Dreaming system promotes short-term recalls into durable memories through three cooperative phases (light, deep, REM) with configurable frequency, aging, and narrative generation. The Wiki system provides a persistent corpus of curated knowledge pages that supplement the agent prompt. Both are built on SQLite/file-based storage. ClawMongo already has most of the foundational primitives (episodes, structured memory, TTL, KB collection, retrieval planner) to implement MongoDB-native equivalents with lower latency and richer query capabilities.

---

## Upstream Dreaming System Analysis

### Architecture Overview

The Dreaming system lives in `extensions/memory-core/src/dreaming*.ts` (~2,550 LOC across 5 files):

- **dreaming.ts** (630 LOC): Main orchestrator. Manages cron jobs for automated promotion sweeps. Three legacy phases (light, deep, REM) consolidated into a single short-term promotion flow.
- **dreaming-phases.ts** (1,348 LOC): Phase execution engine. Reads daily notes, chunks them, runs light/deep/REM sweeps with configurable thresholds.
- **dreaming-narrative.ts** (299 LOC): LLM-powered narrative generation for dream diary entries.
- **dreaming-markdown.ts** (148 LOC): Writes dreaming results to `dreams.md` file.
- **dreaming-command.ts** (125 LOC): `/dreaming` CLI command handler.

### Key Concepts and Data Flow

1. **Short-term recall tracking**: Records which memories are recalled frequently (`recallCount`, `uniqueQueries`, `score`).
2. **Weighted promotion**: Candidates scored by recency half-life decay (`recencyHalfLifeDays`) and recall frequency. Minimum thresholds gate promotion.
3. **Three cooperative phases** (now implementation detail):
   - **Light**: Scan daily notes, identify new content chunks.
   - **Deep**: Evaluate recall patterns, promote high-value memories to durable storage (MEMORY.md).
   - **REM**: Preview staging -- possible lasting truths surfaced before final promotion.
4. **Aging controls**: `recencyHalfLifeDays` (default 7), `maxAgeDays` -- exponential decay on recall value.
5. **Dream diary**: Written to `dreams.md` as a human-readable narrative surface.
6. **Cron-based scheduling**: Managed cron jobs trigger sweeps automatically.

### What ClawMongo Already Has

| Upstream Concept           | ClawMongo Equivalent                            | Status                                                     |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Daily ingestion sweep      | `checkAutoEpisodeTriggers()`                    | Exists, daily/weekly/event-count triggers                  |
| Recall frequency tracking  | `accessCount` + `lastAccessedAt` on episodes    | Identified in AWM gap analysis, not yet implemented        |
| Weighted promotion scoring | `rerankResults()` heuristic reranker            | Exists, uses episode boost + diversity scoring             |
| Aging/decay controls       | TTL indexes on caches                           | Partial -- TTL exists for caches, not for importance decay |
| Narrative generation       | Episode `summary` field via `EpisodeSummarizer` | Exists -- episodes already have LLM-generated summaries    |
| Durable memory             | `structured_memory` collection                  | Exists -- type/key/value with scope                        |
| Cron scheduling            | Not in MongoDB layer                            | External concern -- ClawMongo doesn't own scheduling       |

### What Would Be New

1. **Importance scoring field** (EASY): Add `importance: number` (0-1) to events and episodes. Use in retrieval ranking.
2. **Recall tracking** (EASY): Add `accessCount: number` and `lastAccessedAt: Date` to episodes. Increment on retrieval.
3. **Importance decay** (EASY): Compute effective importance as `importance * Math.pow(0.5, daysSinceCreation / recencyHalfLifeDays)`.
4. **Dream diary type** (EASY): New structured memory type `"diary"` for narrative dream entries.
5. **REM preview status** (EASY): Extend episode `status` lifecycle: `"active" | "draft" | "deleted"` -- `"draft"` serves as REM preview.
6. **Promotion pipeline** (MEDIUM): Background job that reads high-access episodes, generates promotion candidates, writes to structured_memory.

### MongoDB Implementation Path

```
# New fields on existing collections:
events:    + importance (Number, default 0.5)
episodes:  + importance (Number, default 0.5)
           + accessCount (Number, default 0)
           + lastAccessedAt (Date)
           + status: "draft" (new value, REM preview)

# New index:
episodes:  { agentId: 1, importance: -1, accessCount: -1 }  (promotion candidate query)

# New structured_memory type:
{ type: "diary", key: "dream-{date}", value: "narrative text" }

# Promotion query (candidates):
db.episodes.find({
  agentId,
  importance: { $gte: 0.3 },
  accessCount: { $gte: 3 },
  status: "active"
}).sort({ importance: -1, accessCount: -1 }).limit(10)
```

### Estimated Effort

**T-shirt size: MEDIUM (3-5 phases)**

- Phase 1: Add importance/accessCount/lastAccessedAt fields + index (EASY)
- Phase 2: Wire access tracking into retrieval paths (EASY)
- Phase 3: Implement importance decay in retrieval ranking (EASY)
- Phase 4: Promotion pipeline (query candidates, generate diary entries) (MEDIUM)
- Phase 5: Draft/preview status lifecycle (EASY)

---

## Upstream Wiki System Analysis

### Architecture Overview

The Wiki system is a new plugin at `extensions/memory-wiki/` (~36 source files):

- **bridge.ts**: Imports memory events and daily notes into wiki pages.
- **compile.ts**: Compiles wiki sources into searchable pages.
- **query.ts**: Search interface for wiki content.
- **corpus-supplement.ts**: Registers wiki as a corpus supplement for prompt injection.
- **prompt-section.ts**: Builds wiki content for system prompt.
- **ingest.ts**: Ingests external sources into wiki.
- **vault.ts**: Manages wiki vault (directory structure).
- **obsidian.ts**: Obsidian vault compatibility.
- **tool.ts**: Wiki tool registration.

### Key Concepts and Data Flow

1. **Wiki corpus**: Collection of curated knowledge pages organized in a vault structure.
2. **Source sync**: Imports from memory events, daily notes, and external sources.
3. **Prompt supplement**: Wiki pages injected into agent system prompt as supplemental context.
4. **Compile pipeline**: Sources compiled into searchable, renderable pages.
5. **Memory search bridge**: Wiki content searchable via the standard memory search interface.
6. **LLM generation**: Content can be generated/refined by LLM during compilation.

### What ClawMongo Already Has

| Upstream Concept    | ClawMongo Equivalent               | Status                                       |
| ------------------- | ---------------------------------- | -------------------------------------------- |
| Wiki corpus storage | `kb_entries` collection            | Exists -- reference material with embeddings |
| Search bridge       | KB retrieval lane in planner       | Exists -- `kb_search` tool wired             |
| Prompt supplement   | `buildMongoDBBridgeSection()`      | Exists -- MongoDB bridge in system prompt    |
| Source ingestion    | KB ingestion pipeline              | Exists -- separate from conversation events  |
| Content indexing    | Atlas Search + Vector Search on KB | Exists -- dual-mode search                   |

### What Would Be New

1. **Wiki source category** (EASY): Add `source: "wiki"` to KB entries to distinguish from other reference material.
2. **Vault structure metadata** (EASY): Add `vault: string` and `section: string` fields to KB entries for hierarchical organization.
3. **LLM compilation pipeline** (MEDIUM): Pipeline that takes raw sources, refines via LLM, and writes to KB entries.
4. **Prompt supplement registration** (EASY): Register wiki KB entries as prompt supplements using the existing `registerMemoryCorpusSupplement` hook.
5. **Obsidian import** (MEDIUM): Parser for Obsidian vault format into KB entries.

### MongoDB Implementation Path

```
# New fields on kb_entries collection:
kb_entries: + source ("wiki" | "reference" | "imported")
            + vault (String, optional)
            + section (String, optional)
            + compiledAt (Date)
            + compiledFrom (Array of source refs)

# New index:
kb_entries: { agentId: 1, source: 1, vault: 1 }

# Wiki query:
db.kb_entries.find({
  agentId,
  source: "wiki",
  vault: "main"
}).sort({ section: 1 })

# Prompt supplement:
// Retrieve top wiki pages by relevance for prompt injection
db.kb_entries.aggregate([
  { $match: { agentId, source: "wiki" } },
  { $sort: { importance: -1 } },
  { $limit: 5 },
  { $project: { title: 1, content: 1 } }
])
```

### Estimated Effort

**T-shirt size: MEDIUM (3-4 phases)**

- Phase 1: Add wiki source/vault/section fields to KB schema (EASY)
- Phase 2: Wiki-specific retrieval in planner (EASY)
- Phase 3: LLM compilation pipeline (MEDIUM)
- Phase 4: Obsidian import support (MEDIUM, optional)

---

## Priority Recommendation

| Feature                                        | Priority          | Rationale                                                    |
| ---------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| Dreaming: importance scoring + access tracking | **P1 - HIGH**     | Immediate retrieval quality improvement. 2 fields + 1 index. |
| Dreaming: importance decay in ranking          | **P1 - HIGH**     | Direct reranker enhancement. Pure function change.           |
| Dreaming: promotion pipeline                   | **P2 - MEDIUM**   | Requires background job. Builds on P1 fields.                |
| Dreaming: dream diary                          | **P3 - LOW**      | Nice-to-have narrative surface. Low utility.                 |
| Wiki: source categorization                    | **P2 - MEDIUM**   | Better KB organization. Trivial schema change.               |
| Wiki: LLM compilation                          | **P3 - LOW**      | Complex pipeline. ClawMongo KB already serves this role.     |
| Wiki: Obsidian import                          | **P4 - DEFERRED** | Niche use case. Import tools can be external.                |

**Recommended build order:**

1. Importance scoring + access tracking (extends existing episode/event schemas)
2. Importance decay in reranker (extends existing `rerankResults()`)
3. Wiki source categorization (extends existing KB entries)
4. Promotion pipeline (new background job, depends on 1+2)

---

## Dependencies and Risks

- **No new collections required** -- all changes extend existing schemas.
- **No breaking changes** -- new fields are optional with defaults.
- **Risk: access tracking overhead** -- incrementing `accessCount` on every retrieval adds a write per search. Mitigate with batched updates or periodic sync.
- **Risk: importance decay computation** -- must be computed at query time, not storage time. Adds minor CPU overhead to ranking.
- **Risk: promotion pipeline reliability** -- background jobs need failure recovery. Use existing `ingest_runs` pattern for tracking.

---

## NOT in scope

This document evaluates concepts only. **No implementation changes were made.** Any implementation would follow a separate plan/design/build cycle.
