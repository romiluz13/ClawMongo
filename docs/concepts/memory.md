---
title: "Memory"
summary: "How ClawMongo memory works with workspace files and MongoDB"
read_when:
  - You want the memory file layout and workflow
  - You want to tune the automatic pre-compaction memory flush
---

# Memory

ClawMongo keeps OpenClaw's workspace model and makes MongoDB the only runtime
memory backend.

The mental model is simple:

- Workspace Markdown remains the human-authored memory surface.
- MongoDB is the only live retrieval and durable system-memory backend.
- The agent uses four memory tools: `memory_search`, `memory_get`, `kb_search`,
  and `memory_write`.

## Workspace memory files

The standard workspace files keep their upstream roles:

- `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
  - Prompt/bootstrap context files.
  - These are not DB-native memory records.
- `MEMORY.md` or `memory.md`
  - Human-authored long-term notes.
  - Injected according to the normal OpenClaw bootstrap rules.
- `memory/YYYY-MM-DD.md`
  - Human-authored daily notes.
  - Not auto-injected; read on demand.

See [Agent workspace](/concepts/agent-workspace) for the full workspace map.

## Runtime ownership split

ClawMongo keeps one source of truth per kind of data:

- Markdown owns:
  - operator-authored notes
  - workspace identity/policy files
  - informal scratch notes and daily logs
- MongoDB owns:
  - synchronized Markdown chunks used for recall
  - synchronized session chunks
  - imported KB documents and KB chunks
  - structured memory records written by `memory_write`
  - retrieval diagnostics and relevance telemetry

Do not treat MongoDB exports back to Markdown as canonical records. They are
projections for readability only.

## Memory tools

ClawMongo exposes four memory tools:

- `memory_search`
  - Primary recall tool.
  - Searches across memory chunks, session chunks, KB chunks, and structured memory.
- `kb_search`
  - Scoped search for imported docs and reference material.
- `memory_get`
  - Exact read by locator.
  - Supports Markdown memory files, KB documents, and structured memory records.
- `memory_write`
  - Durable structured writes for facts, decisions, preferences, todos, people,
    projects, and architecture notes.

Routing guidance:

- broad recall: `memory_search`
- imported reference docs: `kb_search`
- exact item returned by search: `memory_get`
- durable structured fact/decision/preference: `memory_write`
- informal operator note: `MEMORY.md` or `memory/YYYY-MM-DD.md`

## MongoDB deployment model

ClawMongo is community-first.

### Official ClawMongo target

Use `community-mongot` with automatic embeddings:

```json5
{
  memory: {
    mongodb: {
      uri: "mongodb://localhost:27017/openclaw?replicaSet=rs0",
      deploymentProfile: "community-mongot",
      embeddingMode: "automated",
    },
  },
}
```

Or via environment:

```bash
export OPENCLAW_MONGODB_URI="mongodb://localhost:27017/openclaw?replicaSet=rs0"
```

ClawMongo supports one official deployment profile:

| Profile            | Role in ClawMongo        | Retrieval shape           |
| ------------------ | ------------------------ | ------------------------- |
| `community-mongot` | Official and only target | lexical + vector + hybrid |

### Embeddings

ClawMongo defaults to `embeddingMode: "automated"`.

That means MongoDB generates embeddings inside the supported Community +
`mongot` stack. ClawMongo does not require an external embedding provider for
its official path.

## Community-first caveat

MongoDB's own docs describe Community Search, Vector Search, and automatic
embeddings as preview features and require both `mongod` and `mongot` for the
self-managed Search path. ClawMongo supports this exact stack, but the launch
story should remain preview-aware and precise.

## Search behavior

ClawMongo searches only from MongoDB at runtime.

The backend tries the best available path for the supported deployment:

1. hybrid fusion when lexical and vector are both available
2. vector-only search when vectors are available but lexical is not
3. lexical Search when `mongot` search is available

The runtime never silently switches back to SQLite or QMD.

## Automatic memory flush

When a session is close to auto-compaction, OpenClaw can trigger a silent turn
that reminds the model to store durable memory before compaction.

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
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Details:

- the flush runs once per compaction cycle
- it is skipped when the workspace is read-only
- it is still about writing operator-facing notes, not bypassing `memory_write`
  for structured durable memory

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
- symlinks are ignored
