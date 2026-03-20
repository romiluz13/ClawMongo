---
title: "Memory"
summary: "How ClawMongo memory works with workspace files and MongoDB"
read_when:
  - You want the memory file layout and workflow
  - You want to tune the automatic pre-compaction memory flush
---

# Memory

ClawMongo keeps OpenClaw's workspace model and makes MongoDB the only runtime
memory backend and canonical memory truth.

The mental model is simple:

- Workspace Markdown remains the human-authored heart and bridge surface.
- MongoDB is the only live retrieval and durable system-memory backend.
- Canonical runtime truth is event-first.
- Chunks, graph entities, relations, episodes, summaries, and embeddings are derived products.
- The agent uses four memory tools: `memory_search`, `memory_get`, `kb_search`,
  and `memory_write`.

## Workspace memory files

The standard workspace files keep their upstream roles:

- `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
  - Prompt/bootstrap context files.
  - These are not DB-native memory records.
- `MEMORY.md` or `memory.md`
  - Human-authored bridge notes.
  - Injected according to the normal OpenClaw bootstrap rules.
  - Guidance only, not canonical runtime memory.
- `memory/YYYY-MM-DD.md`
  - Human-authored daily bridge log.
  - Read today + yesterday at session start.
  - Not the durable runtime memory target for agent-written facts.
- `MEMORY.md` (optional)
  - Curated bridge guidance for direct/private sessions.
  - If both `MEMORY.md` and `memory.md` exist at the workspace root, OpenClaw only loads `MEMORY.md`.
  - Lowercase `memory.md` is only used as a fallback when `MEMORY.md` is absent.
  - **Only load in the main, private session** (never in group contexts).

See [Agent workspace](/concepts/agent-workspace) for the full workspace map.
For the ownership contract between workspace files and MongoDB, see
[Heart brain boundary](/reference/heart-brain-boundary).

## Runtime ownership split

ClawMongo keeps one source of truth per kind of data:

- Markdown owns:
  - operator-authored notes
  - workspace identity/policy files
  - informal scratch notes and daily logs
- MongoDB owns:
  - canonical conversation and runtime events
  - derived synchronized Markdown chunks used for recall
  - derived synchronized session chunks
  - imported KB documents and KB chunks
  - structured memory records written by `memory_write`
  - derived graph entities, relations, episodes, and future summary references
  - retrieval diagnostics and relevance telemetry

Do not treat MongoDB exports back to Markdown as canonical records. They are
projections for readability only.

## Memory tools

ClawMongo exposes four memory tools:

- `memory_search`
  - Primary runtime recall entrypoint.
  - Searches across active MongoDB-backed recall sources.
  - May include KB-backed snippets when those sources are enabled, but it should be treated as memory-first recall.
- `kb_search`
  - Dedicated search for imported docs and reference material.
  - Use when the target is documentation, FAQs, architecture specs, or other explicit reference content.
- `memory_get`
  - Exact read by locator.
  - Supports MongoDB-backed locators returned by recall tools.
- `memory_write`
  - Durable structured writes for facts, decisions, preferences, todos, people,
    projects, and architecture notes.

Routing guidance:

- broad recall: `memory_search`
- imported reference docs: `kb_search`
- exact item returned by search: `memory_get`
- durable structured fact/decision/preference: `memory_write`
- informal operator note: `MEMORY.md` or `memory/YYYY-MM-DD.md`
  - keep these human-authored; do not use them as the canonical durable runtime store

## MongoDB deployment model

ClawMongo is community-first.

### Official ClawMongo target

Use `community-mongot` with automatic embeddings:

```json5
{
  memory: {
    mongodb: {
      uri: "mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true",
      deploymentProfile: "community-mongot",
      embeddingMode: "automated",
    },
  },
}
```

Or via environment:

```bash
export OPENCLAW_MONGODB_URI="mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true"
```

ClawMongo supports one official deployment profile:

| Profile            | Role in ClawMongo        | Retrieval shape           |
| ------------------ | ------------------------ | ------------------------- |
| `community-mongot` | Official and only target | lexical + vector + hybrid |

### Embeddings

ClawMongo defaults to `embeddingMode: "automated"`.

In this mode, `mongot` delegates embedding generation to the Voyage AI API
using the API keys you configure during `mongot` initialization. ClawMongo
does not require application-side embedding code — `mongot` handles embedding
at index time and query time — but you do need Voyage AI API keys configured
in your `mongot` deployment.

## Search behavior

ClawMongo searches only from MongoDB at runtime.

The runtime contract is:

1. `memory_search` is the main runtime recall entrypoint.
2. `kb_search` is the dedicated reference retrieval path.
3. `memory_get` reopens the exact MongoDB-backed locator you already found.
4. `memory_write` stores durable structured runtime knowledge.

The backend tries the best available path for the supported deployment:

1. hybrid fusion when lexical and vector are both available
2. vector-only search when vectors are available but lexical is not
3. lexical Search when `mongot` search is available

The runtime never silently switches back to SQLite or QMD.

## Automatic memory flush

When a session is close to auto-compaction, OpenClaw can trigger a silent turn
that reminds the model to store durable memory in MongoDB before compaction.

This is controlled by `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Use memory_write for any durable fact, decision, preference, todo, person, project, or architecture note worth keeping. Reply with NO_REPLY if nothing should be stored.",
        },
      },
    },
  },
}
```

Details:

- the flush runs once per compaction cycle
- it is skipped when the workspace is read-only
- it writes durable runtime memory through `memory_write`
- it treats `MEMORY.md` and `memory/*.md` as human-authored bridge notes, not
  as the durable runtime store

For the full compaction lifecycle, see
[Session management + compaction](/reference/session-management-compaction).

## Additional memory paths

If you want to index Markdown outside the default workspace layout, add explicit
paths under `agents.defaults.memorySearch.extraPaths`.

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"],
      },
    },
  },
}
```

Notes:

- paths can be absolute or workspace-relative
- directories are scanned recursively for `.md` files
- when `agents.defaults.memorySearch.multimodal.enabled = true`, supported
  image/audio files under `extraPaths` are also eligible for indexing
- symlinks are ignored
