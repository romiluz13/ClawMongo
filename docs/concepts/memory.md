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
- Procedures are explicit, versioned derived artifacts when ClawMongo learns a repeatable workflow.
- The agent uses four memory tools: `memory_search`, `memory_get`, `kb_search`,
  and `memory_write`.

## Workspace memory files

The standard workspace files keep their upstream roles:

- `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
  - Prompt/bootstrap context files.
  - These are not DB-native memory records.
- `memory/YYYY-MM-DD.md`
  - Human-authored daily bridge log.
  - Read today + yesterday at session start.
  - Not the durable runtime memory target for agent-written facts.
- `memory/*.md`
  - Human-authored bridge notes in the `memory/` subdirectory.
  - MongoDB is the sole runtime memory store; workspace files are supplementary guidance only.

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
  - derived graph entities, relations, episodes, procedures, and future summary references
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
  - Supports MongoDB-backed locators returned by recall tools, including event,
    episode, relation, procedure, KB, and structured-memory locators.
- `memory_write`
  - Durable structured writes for facts, decisions, preferences, todos, people,
    projects, and architecture notes.
  - The durable record may later gain salience, temporal validity, provenance,
    and supersession metadata through MongoDB-native lifecycle handling.

Routing guidance:

- broad recall: `memory_search`
- imported reference docs: `kb_search`
- exact item returned by search: `memory_get`
- durable structured fact/decision/preference: `memory_write`
- informal operator note: `memory/YYYY-MM-DD.md`
  - keep these human-authored; do not use them as the canonical durable runtime store

## MongoDB deployment model

ClawMongo targets `mongodb-atlas-local:preview` -- a single Docker image that bundles
mongod, mongot (community search engine), Atlas Search, Atlas Vector Search, and
Voyage AI auto-embeddings in one container.

### Official ClawMongo target

Use the `community-mongot` deployment profile with automatic embeddings:

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

In this mode, the bundled mongot inside the `mongodb-atlas-local:preview` container
delegates embedding generation to the Voyage AI API. Set `VOYAGE_API_KEY` as an
environment variable when starting the container. ClawMongo does not require
application-side embedding code -- mongot handles embedding at index time and
query time automatically.

## Search behavior

ClawMongo searches only from MongoDB at runtime.

The runtime contract is:

1. `memory_search` is the main runtime recall entrypoint.
2. `kb_search` is the dedicated reference retrieval path.
3. `memory_get` reopens the exact MongoDB-backed locator you already found.
4. `memory_write` stores durable structured runtime knowledge.

The intuition contract is:

1. heart/bootstrap Markdown teaches the agent how to use memory well
2. MongoDB runtime memory tells the agent what is currently true
3. questions about current situation, active constraints, major ongoing context, crises, or "what matters now" should prioritize active runtime memory before generic background recall
4. `memory/*.md` files may inform recall, but they do not override MongoDB-backed current truth

The backend tries the best available path for the supported deployment:

1. hybrid fusion when lexical and vector are both available
2. vector-only search when vectors are available but lexical is not
3. lexical Search when `mongot` search is available

Planner-directed recall can route through these MongoDB-backed lanes before the
final backstop:

1. `active-critical` for current crises, blockers, and “what matters now”
2. `procedural` for workflows and learned runbooks
3. `structured` for durable facts, preferences, and current truth
4. `raw-window` for recent canonical events
5. `graph` for entity-connected recall
6. `episodic` for summaries and consolidated event windows
7. `kb` for explicit reference retrieval
8. `hybrid` as the broad lexical/vector backstop

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
- it treats `memory/*.md` files as human-authored bridge notes, not
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
