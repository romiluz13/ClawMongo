---
title: "Memory configuration reference"
summary: "Full configuration reference for ClawMongo MongoDB-first memory: embedding providers, hybrid search, vector search, and retrieval tuning"
read_when:
  - You want to configure memory search providers or embedding models
  - You want to tune hybrid search, vector search, or temporal decay
  - You want to understand the MongoDB memory backend configuration
---

# Memory configuration reference

This page covers the full configuration surface for OpenClaw memory search. For
the conceptual overview (file layout, memory tools, when to write memory, and the
automatic flush), see [Memory](/concepts/memory).

## Memory search defaults

- Enabled by default.
- Watches memory files for changes (debounced).
- Configure memory search under `agents.defaults.memorySearch` (not top-level
  `memorySearch`).
- Uses remote embeddings by default. If `memorySearch.provider` is not set, OpenClaw auto-selects:
  1. `local` if a `memorySearch.local.modelPath` is configured and the file exists.
  2. `openai` if an OpenAI key can be resolved.
  3. `gemini` if a Gemini key can be resolved.
  4. `voyage` if a Voyage key can be resolved.
  5. `mistral` if a Mistral key can be resolved.
  6. Otherwise memory search stays disabled until configured.
- ClawMongo uses Voyage AI automated embeddings through mongot (no local embedding setup needed).
- In ClawMongo, vector search is handled by MongoDB Atlas Search (mongot) with automated embeddings.
- `memorySearch.provider = "ollama"` is also supported for local/self-hosted
  Ollama embeddings (`/api/embeddings`), but it is not auto-selected.

Remote embeddings **require** an API key for the embedding provider. OpenClaw
resolves keys from auth profiles, `models.providers.*.apiKey`, or environment
variables. Codex OAuth only covers chat/completions and does **not** satisfy
embeddings for memory search. For Gemini, use `GEMINI_API_KEY` or
`models.providers.google.apiKey`. For Voyage, use `VOYAGE_API_KEY` or
`models.providers.voyage.apiKey`. For Mistral, use `MISTRAL_API_KEY` or
`models.providers.mistral.apiKey`. Ollama typically does not require a real API
key (a placeholder like `OLLAMA_API_KEY=ollama-local` is enough when needed by
local policy).
When using a custom OpenAI-compatible endpoint,
set `memorySearch.remote.apiKey` (and optional `memorySearch.remote.headers`).

## MongoDB backend (ClawMongo)

ClawMongo uses MongoDB as the **only** canonical runtime memory backend.
Set `memory.backend = "mongodb"` (this is the default and only valid value).

### Prerequisites

- **Recommended:** The `mongodb-atlas-local:preview` Docker image (bundles mongod + mongot + Atlas Search + Vector Search in one container). Start with `./docker/mongodb/start-preview.sh`.
- For automated embeddings: Voyage AI API key (`VOYAGE_API_KEY`) passed as a container environment variable.
- Alternative: A standalone MongoDB 7+ instance, but vector search and auto-embeddings require mongot which is bundled in the atlas-local image.
- See `docker/mongodb/` for Docker setup options (preview recommended, multi-container for advanced use).

### How MongoDB memory works

- **Canonical events**: Conversation turns persist directly to the `events` collection via `persistConversationMessageToMongo`. No disk intermediary.
- **Chunk projection**: Events are projected into searchable chunks in the `chunks` collection.
- **Bridge sync**: Workspace Markdown files under `memory/**/*.md` are synced to MongoDB chunks for hybrid retrieval. They remain Markdown bridge files, not a replacement for the heart files.
- **Vector search**: Handled by mongot (Atlas Search) with `$vectorSearch`. Automated embeddings via Voyage AI generate vectors at index-time and query-time.
- **Text search**: `$text` indexes provide BM25 keyword search as a fallback when vector search is unavailable.
- **Hybrid search**: `$rankFusion` / `$scoreFusion` combine vector and keyword results when both are available.
- **Graph**: Entity/relation storage with `$graphLookup` for bounded graph expansion.
- **Episodes**: Auto-materialized from event streams for navigable conversation summaries.
- **Structured memory**: Durable facts with salience, temporal validity, provenance, and supersession tracking.
- **Runtime search order**: `cache -> searchV2 -> legacy fallback`.

### Retrieval guarantees and limits

- Heart files such as `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `HEARTBEAT.md` remain Markdown-owned bootstrap inputs. They are not promoted into MongoDB runtime memory ownership.
- `memory/**/*.md` remains the bridge corpus. MongoDB indexes and retrieves bridge notes, but bridge notes do not replace MongoDB-native events, KB, or structured memory.
- Search results use reopenable MongoDB-backed locators for event, episode, relation, procedure, structured, and KB surfaces.
- Query rewriting supports deterministic `synonym-expansion` only. Unsupported rewrite modes are rejected during config resolution instead of being treated as working runtime features.

### Config surface (`memory.mongodb.*`)

- `uri`: MongoDB connection string (e.g., `mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0`).
- `database`: Database name (default: derived from connection string).
- `prefix`: Collection prefix for namespace isolation (default: agent-scoped).

### MongoDB example

```json5
memory: {
  backend: "mongodb",
  citations: "auto",
  mongodb: {
    uri: "mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true"
  }
}
```

### Citations

- `memory.citations` controls citation visibility (`auto`/`on`/`off`).
- `status().backend = "mongodb"` in diagnostics confirms the MongoDB backend is active.

### Query rewriting migration note

If you previously configured `memory.mongodb.queryRewriting.method` as `llm` or `hyde`, update it to:

- `synonym-expansion` to keep deterministic query expansion
- or disable query rewriting with `memory.mongodb.queryRewriting.enabled = false`

## Compaction tuning

### reserveTokensFloor

Controls the minimum token budget reserved for the agent before compaction
triggers. The default is `40000` (40K tokens). This gives the agent enough room
for tool use, memory search results, and multi-step reasoning before the session
auto-compacts.

```json5
agents: {
  defaults: {
    compaction: {
      reserveTokensFloor: 40000
    }
  }
}
```

Raise this value if the agent frequently compacts mid-task. Lower it only on
small-context models where compaction cost is a concern.

### Pre-compaction memory flush

Before compaction, the agent automatically runs a "memory flush" turn that
stores durable facts to MongoDB via `memory_write`. This ensures important
context survives compaction.

The flush is enabled by default. Configure it under
`agents.defaults.compaction.memoryFlush`:

- `enabled` (default: `true`) -- toggle the flush entirely.
- `softThresholdTokens` (default: `4000`) -- token margin before compaction that triggers the flush.
- `prompt` -- custom flush prompt (safety hints are always appended).
- `systemPrompt` -- custom system prompt for the flush turn.

## Additional memory paths

If you want to index Markdown files outside the default workspace layout, add
explicit paths:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Notes:

- Paths can be absolute or workspace-relative.
- Directories are scanned recursively for `.md` files.
- By default, only Markdown files are indexed.
- If `memorySearch.multimodal.enabled = true`, OpenClaw also indexes supported image/audio files under `extraPaths` only. Default memory roots (`memory/**/*.md`) stay Markdown-only.
- Symlinks are ignored (files or directories).

## Multimodal memory files (Gemini image + audio)

OpenClaw can index image and audio files from `memorySearch.extraPaths` when using Gemini embedding 2:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: ["assets/reference", "voice-notes"],
      multimodal: {
        enabled: true,
        modalities: ["image", "audio"], // or ["all"]
        maxFileBytes: 10000000
      },
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notes:

- Multimodal memory is currently supported only for `gemini-embedding-2-preview`.
- Multimodal indexing applies only to files discovered through `memorySearch.extraPaths`.
- Supported modalities in this phase: image and audio.
- `memorySearch.fallback` must stay `"none"` while multimodal memory is enabled.
- Matching image/audio file bytes are uploaded to the configured Gemini embedding endpoint during indexing.
- Supported image extensions: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif`.
- Supported audio extensions: `.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.flac`.
- Search queries remain text, but Gemini can compare those text queries against indexed image/audio embeddings.
- `memory_get` still reads Markdown only; binary files are searchable but not returned as raw file contents.

## Gemini embeddings (native)

Set the provider to `gemini` to use the Gemini embeddings API directly:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notes:

- `remote.baseUrl` is optional (defaults to the Gemini API base URL).
- `remote.headers` lets you add extra headers if needed.
- Default model: `gemini-embedding-001`.
- `gemini-embedding-2-preview` is also supported: 8192 token limit and configurable dimensions (768 / 1536 / 3072, default 3072).

### Gemini Embedding 2 (preview)

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 3072,  // optional: 768, 1536, or 3072 (default)
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

> **Re-index required:** Switching from `gemini-embedding-001` (768 dimensions)
> to `gemini-embedding-2-preview` (3072 dimensions) changes the vector size. The same is true if you
> change `outputDimensionality` between 768, 1536, and 3072.
> OpenClaw will automatically reindex when it detects a model or dimension change.

## Custom OpenAI-compatible endpoint

If you want to use a custom OpenAI-compatible endpoint (OpenRouter, vLLM, or a proxy),
you can use the `remote` configuration with the OpenAI provider:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

If you don't want to set an API key, use `memorySearch.provider = "local"` or set
`memorySearch.fallback = "none"`.

### Fallbacks

- `memorySearch.fallback` can be `openai`, `gemini`, `voyage`, `mistral`, `ollama`, `local`, or `none`.
- The fallback provider is only used when the primary embedding provider fails.

### Batch indexing (OpenAI + Gemini + Voyage)

- Disabled by default. Set `agents.defaults.memorySearch.remote.batch.enabled = true` to enable for large-corpus indexing (OpenAI, Gemini, and Voyage).
- Default behavior waits for batch completion; tune `remote.batch.wait`, `remote.batch.pollIntervalMs`, and `remote.batch.timeoutMinutes` if needed.
- Set `remote.batch.concurrency` to control how many batch jobs we submit in parallel (default: 2).
- Batch mode applies when `memorySearch.provider = "openai"` or `"gemini"` and uses the corresponding API key.
- Gemini batch jobs use the async embeddings batch endpoint and require Gemini Batch API availability.

Why OpenAI batch is fast and cheap:

- For large backfills, OpenAI is typically the fastest option we support because we can submit many embedding requests in a single batch job and let OpenAI process them asynchronously.
- OpenAI offers discounted pricing for Batch API workloads, so large indexing runs are usually cheaper than sending the same requests synchronously.
- See the OpenAI Batch API docs and pricing for details:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Config example:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

## How the memory tools work

- `memory_search` is the primary runtime recall entrypoint. It searches across active MongoDB-backed recall sources (conversation events, structured memory, KB, episodes, graph). Results include snippet text, locators, scores, and source type. The retrieval planner selects which paths to execute based on the query.
- `memory_search` now supports a richer generic request contract for selective internal search. Callers can ask for `searchMode` (`auto` / `direct` / `agentic`), ordered `sourcePreference`, bounded `timeRange`, `needExactEvidence`, `maxPasses`, and generic scope objects for conversation, structured, reference, and procedural retrieval.
- `memory_search` returns planner-visible metadata so maintainers can inspect how recall behaved in production: classification, passes, queries tried, active constraints, rejected results, evidence coverage, paths executed, and whether query rewriting or reranking ran.
- `memory_get` reopens exact locators returned by recall tools. Supports MongoDB-backed locators for events, episodes, relations, procedures, KB, and structured memory.
- `kb_search` is a dedicated search for imported docs and reference material.
- `memory_write` persists durable structured facts (decisions, preferences, todos, people, projects) with salience, temporal validity, provenance, and supersession metadata.
- All tools are enabled only when the MongoDB memory backend is configured.

### Selective agentic internal search

- `memory_search` stays the single public recall tool. ClawMongo does not introduce `memory_search_v2`.
- `searchMode: "auto"` keeps simple lookups cheap and escalates only when the query shape looks family-style, comparative, temporal, scoped, or multi-hop.
- Hard constraints such as explicit time windows, scope filters, and `needExactEvidence` are enforced near MongoDB-backed retrieval lanes and are preserved across passes.
- Legacy fallback remains part of the runtime search order, but constrained requests do not silently weaken into unconstrained fallback behavior.
- Search index evolution is part of the feature. ClawMongo refreshes existing Search / Vector Search definitions when runtime-required filter fields drift.

## What gets indexed (and when)

- **Canonical events**: Written directly to MongoDB on the runtime write path. No disk intermediary.
- **Bridge sync**: Markdown files (`memory/**/*.md`) are synced to MongoDB chunks for hybrid retrieval. Watcher marks dirty (debounce 1.5s), sync runs asynchronously.
- **Chunk projection**: Canonical events are projected into searchable chunks for retrieval.
- **Reindex triggers**: The index stores the embedding **provider/model + endpoint fingerprint + chunking params**. If any change, ClawMongo automatically resets and reindexes.

## Hybrid search (BM25 + vector)

When enabled, OpenClaw combines:

- **Vector similarity** (semantic match, wording can differ)
- **BM25 keyword relevance** (exact tokens like IDs, env vars, code symbols)

If full-text search is unavailable on your platform, OpenClaw falls back to vector-only search.

### Why hybrid

Vector search is great at "this means the same thing":

- "Mac Studio gateway host" vs "the machine running the gateway"
- "debounce file updates" vs "avoid indexing on every write"

But it can be weak at exact, high-signal tokens:

- IDs (`a828e60`, `b3b9895a...`)
- code symbols (`memorySearch.query.hybrid`)
- error strings ("sqlite-vec unavailable")

BM25 (full-text) is the opposite: strong at exact tokens, weaker at paraphrases.
Hybrid search is the pragmatic middle ground: **use both retrieval signals** so you get
good results for both "natural language" queries and "needle in a haystack" queries.

### How we merge results (the current design)

Implementation sketch:

1. Retrieve a candidate pool from both sides:

- **Vector**: top `maxResults * candidateMultiplier` by cosine similarity.
- **BM25**: top `maxResults * candidateMultiplier` by FTS5 BM25 rank (lower is better).

2. Convert BM25 rank into a 0..1-ish score:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Union candidates by chunk id and compute a weighted score:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notes:

- `vectorWeight` + `textWeight` is normalized to 1.0 in config resolution, so weights behave as percentages.
- If embeddings are unavailable (or the provider returns a zero-vector), we still run BM25 and return keyword matches.
- If FTS5 can't be created, we keep vector-only search (no hard failure).

This isn't "IR-theory perfect", but it's simple, fast, and tends to improve recall/precision on real notes.
If we want to get fancier later, common next steps are Reciprocal Rank Fusion (RRF) or score normalization
(min/max or z-score) before mixing.

### Post-processing pipeline

After merging vector and keyword scores, two optional post-processing stages
refine the result list before it reaches the agent:

```
Vector + Keyword -> Weighted Merge -> Temporal Decay -> Sort -> MMR -> Top-K Results
```

Both stages are **off by default** and can be enabled independently.

### MMR re-ranking (diversity)

When hybrid search returns results, multiple chunks may contain similar or overlapping content.
For example, searching for "home network setup" might return five nearly identical snippets
from different daily notes that all mention the same router configuration.

**MMR (Maximal Marginal Relevance)** re-ranks the results to balance relevance with diversity,
ensuring the top results cover different aspects of the query instead of repeating the same information.

How it works:

1. Results are scored by their original relevance (vector + BM25 weighted score).
2. MMR iteratively selects results that maximize: `lambda x relevance - (1-lambda) x max_similarity_to_selected`.
3. Similarity between results is measured using Jaccard text similarity on tokenized content.

The `lambda` parameter controls the trade-off:

- `lambda = 1.0` -- pure relevance (no diversity penalty)
- `lambda = 0.0` -- maximum diversity (ignores relevance)
- Default: `0.7` (balanced, slight relevance bias)

**Example -- query: "home network setup"**

Given these memory files:

```
memory/2026-02-10.md  -> "Configured Omada router, set VLAN 10 for IoT devices"
memory/2026-02-08.md  -> "Configured Omada router, moved IoT to VLAN 10"
memory/2026-02-05.md  -> "Set up AdGuard DNS on 192.168.10.2"
memory/network.md     -> "Router: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

Without MMR -- top 3 results:

```
1. memory/2026-02-10.md  (score: 0.92)  <- router + VLAN
2. memory/2026-02-08.md  (score: 0.89)  <- router + VLAN (near-duplicate!)
3. memory/network.md     (score: 0.85)  <- reference doc
```

With MMR (lambda=0.7) -- top 3 results:

```
1. memory/2026-02-10.md  (score: 0.92)  <- router + VLAN
2. memory/network.md     (score: 0.85)  <- reference doc (diverse!)
3. memory/2026-02-05.md  (score: 0.78)  <- AdGuard DNS (diverse!)
```

The near-duplicate from Feb 8 drops out, and the agent gets three distinct pieces of information.

**When to enable:** If you notice `memory_search` returning redundant or near-duplicate snippets,
especially with daily notes that often repeat similar information across days.

### Temporal decay (recency boost)

Agents with daily notes accumulate hundreds of dated files over time. Without decay,
a well-worded note from six months ago can outrank yesterday's update on the same topic.

**Temporal decay** applies an exponential multiplier to scores based on the age of each result,
so recent memories naturally rank higher while old ones fade:

```
decayedScore = score x e^(-lambda x ageInDays)
```

where `lambda = ln(2) / halfLifeDays`.

With the default half-life of 30 days:

- Today's notes: **100%** of original score
- 7 days ago: **~84%**
- 30 days ago: **50%**
- 90 days ago: **12.5%**
- 180 days ago: **~1.6%**

**Evergreen files are never decayed:**

- Non-dated files in `memory/` (e.g., `memory/projects.md`, `memory/network.md`)
- These contain durable reference information that should always rank normally.

**Dated daily files** (`memory/YYYY-MM-DD.md`) use the date extracted from the filename.
Other sources (e.g., session transcripts) fall back to file modification time (`mtime`).

**Example -- query: "what's Rod's work schedule?"**

Given these memory files (today is Feb 10):

```
memory/2025-09-15.md  -> "Rod works Mon-Fri, standup at 10am, pairing at 2pm"  (148 days old)
memory/2026-02-10.md  -> "Rod has standup at 14:15, 1:1 with Zeb at 14:45"    (today)
memory/2026-02-03.md  -> "Rod started new team, standup moved to 14:15"        (7 days old)
```

Without decay:

```
1. memory/2025-09-15.md  (score: 0.91)  <- best semantic match, but stale!
2. memory/2026-02-10.md  (score: 0.82)
3. memory/2026-02-03.md  (score: 0.80)
```

With decay (halfLife=30):

```
1. memory/2026-02-10.md  (score: 0.82 x 1.00 = 0.82)  <- today, no decay
2. memory/2026-02-03.md  (score: 0.80 x 0.85 = 0.68)  <- 7 days, mild decay
3. memory/2025-09-15.md  (score: 0.91 x 0.03 = 0.03)  <- 148 days, nearly gone
```

The stale September note drops to the bottom despite having the best raw semantic match.

**When to enable:** If your agent has months of daily notes and you find that old,
stale information outranks recent context. A half-life of 30 days works well for
daily-note-heavy workflows; increase it (e.g., 90 days) if you reference older notes frequently.

### Hybrid search configuration

Both features are configured under `memorySearch.query.hybrid`:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          // Diversity: reduce redundant results
          mmr: {
            enabled: true,    // default: false
            lambda: 0.7       // 0 = max diversity, 1 = max relevance
          },
          // Recency: boost newer memories
          temporalDecay: {
            enabled: true,    // default: false
            halfLifeDays: 30  // score halves every 30 days
          }
        }
      }
    }
  }
}
```

You can enable either feature independently:

- **MMR only** -- useful when you have many similar notes but age doesn't matter.
- **Temporal decay only** -- useful when recency matters but your results are already diverse.
- **Both** -- recommended for agents with large, long-running daily note histories.

## Embedding cache

OpenClaw can cache **chunk embeddings** in SQLite so reindexing and frequent updates (especially session transcripts) don't re-embed unchanged text.

Config:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

## Session memory in ClawMongo

In ClawMongo, session conversation events are persisted directly to MongoDB as canonical events on the runtime write path. There is no need for opt-in session indexing -- conversation events are the primary write target and are immediately available for retrieval.

- Conversation events are written to the `events` collection via `persistConversationMessageToMongo`.
- Chunk projection derives searchable chunks from canonical events.
- Episode materialization groups related events into navigable summaries.
- Structured memory promotion extracts durable facts from the event stream.

**Architecture boundary**: Delivery mirrors (outbound message confirmations in the session transcript) are transcript-level bookkeeping and are intentionally NOT written to the canonical MongoDB event stream. This prevents duplicate entries and keeps the event timeline clean. The canonical persistence path fires only for agent conversation turns through `guardSessionManager`.

Delta thresholds (defaults shown):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

## Vector search (MongoDB Atlas Search)

ClawMongo uses MongoDB Atlas Search (mongot) for vector similarity queries.
Vector indexes are defined in `src/memory/mongodb-schema.ts` and created
automatically via `ensureSearchIndexes()`.

- Automated embeddings: mongot generates vectors at index-time using
  the configured Voyage AI endpoint. No separate embedding step needed.
- Query-time embeddings: `$vectorSearch` with `queryText` triggers
  automated embedding at query time.
- Fallback: when vector search is unavailable (e.g., standalone without
  mongot), ClawMongo falls back to `$text` search (BM25).

## Automated embeddings (Voyage AI)

ClawMongo uses MongoDB's automated embedding feature with Voyage AI:

- **Index-time**: mongot generates embeddings when documents are inserted/updated, using the Voyage AI endpoint configured in the mongot config.
- **Query-time**: `$vectorSearch` with `queryText` triggers automated embedding for the search query.
- **Models**: `voyage-4-large` (recommended for high accuracy) or `voyage-4` (faster, smaller).
- **Key separation**: MongoDB recommends separate Voyage API keys for indexing and querying. Configure via `VOYAGE_API_INDEXING_KEY` and `VOYAGE_API_QUERY_KEY` in the Docker setup.
- **No local embedding needed**: Unlike upstream OpenClaw which uses node-llama-cpp / GGUF models, ClawMongo delegates all embedding to Voyage AI through mongot.

## Custom OpenAI-compatible endpoint example

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Notes:

- `remote.*` takes precedence over `models.providers.openai.*`.
- `remote.headers` merge with OpenAI headers; remote wins on key conflicts. Omit `remote.headers` to use the OpenAI defaults.
