---
title: "Heart Brain Boundary"
summary: "Ownership contract between workspace markdown files and MongoDB memory in ClawMongo"
read_when:
  - You are auditing ClawMongo memory architecture
  - You need to decide whether a file or feature belongs to the workspace heart or MongoDB brain
  - You are merging upstream OpenClaw changes into ClawMongo
---

# Heart brain boundary

ClawMongo preserves OpenClaw's workspace bootstrap model and replaces only the
runtime memory backend.

The contract is:

- Workspace markdown defines who the agent is.
- MongoDB defines what the agent can remember and retrieve.
- `MEMORY.md` and `memory/*.md` are the bridge between the two.

This boundary is not optional. If the boundary drifts, ClawMongo stops being
OpenClaw with a MongoDB-first memory system and becomes a competing agent model.

## Ownership map

| Layer  | Authority                               | Allowed data                                                   | Must not own                                    |
| ------ | --------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Heart  | Workspace bootstrap markdown            | identity, persona, rules, operator guidance, startup cadence   | structured facts, KB docs, retrieval indexes    |
| Bridge | `MEMORY.md`, `memory.md`, `memory/*.md` | operator-authored notes, informal observations, daily logs     | identity canon, DB-native structured records    |
| Brain  | MongoDB                                 | recall, sessions, KB, structured memory, retrieval diagnostics | persona, bootstrap policy, agent identity canon |

## Heart files

These files remain file-authoritative and must preserve OpenClaw semantics:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`

Rules:

- These files are prompt/bootstrap inputs first.
- They must not be redefined as MongoDB-native records.
- MongoDB retrieval must not override their meaning.
- If ClawMongo adds prompt guidance after these files, that guidance may route
  memory behavior but must not replace persona, identity, or policy defined by
  the files themselves.

## Bridge files

These files remain human-authored markdown and may be synchronized into MongoDB:

- `MEMORY.md`
- `memory.md`
- `memory/*.md`

Rules:

- These files are still editable by humans as normal workspace notes.
- MongoDB may index and chunk them for retrieval.
- They are not the place for DB-native structured facts when `memory_write`
  exists.
- They may store informal notes and scratch thinking, but they should not become
  the canonical source for persona or bootstrap policy.

## Brain data

MongoDB is authoritative for runtime retrieval and durable memory services:

- synchronized memory chunks from bridge files
- synchronized session chunks
- knowledge base documents and KB chunks
- structured memory written by tools
- retrieval diagnostics and relevance telemetry

Rules:

- MongoDB may optimize retrieval and persistence.
- MongoDB may add structured memory types, KB indexes, and session recall.
- MongoDB must not silently redefine the workspace bootstrap contract.

## Required invariants

These invariants should hold for every ClawMongo release:

1. `src/agents/workspace.ts` stays aligned with upstream OpenClaw for the
   canonical bootstrap file set unless a change is explicitly justified.
2. `src/memory/internal.ts` must continue to treat only `MEMORY.md`, `memory.md`,
   and `memory/` as default memory corpus paths.
3. `src/agents/system-prompt.ts` may add a MongoDB routing bridge, but that
   bridge must not replace the heart-file roles defined above.
4. `memory_search` may search across bridge files, sessions, KB, and structured
   memory, but heart files are not promoted into DB-native memory ownership.
5. `memory_write` stores durable structured facts. It does not replace
   `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, or `TOOLS.md`.
6. Upstream OpenClaw workspace semantics take precedence unless they directly
   conflict with the MongoDB-first memory backend.

## Audit targets

Every heart-versus-brain audit should inspect at minimum:

- `src/agents/workspace.ts`
- `src/agents/system-prompt.ts`
- `src/agents/tools/memory-tool.ts`
- `src/memory/internal.ts`
- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-sync.ts`
- `src/memory/mongodb-kb.ts`
- `src/memory/mongodb-structured-memory.ts`
- `openclaw-source-ref-only/src/agents/workspace.ts`
- `openclaw-source-ref-only/src/agents/system-prompt.ts`

## Examples of acceptable divergence

- MongoDB-specific routing guidance added after bootstrap context
- MongoDB-native structured memory and KB collections
- MongoDB search, sync, indexing, and diagnostics
- Universal `memory_get` support for DB-native locators

## Examples of violations

- indexing `SOUL.md` or `IDENTITY.md` as normal memory corpus
- teaching the agent to write durable identity or policy into MongoDB
- making MongoDB structured memory the canonical source for persona
- changing the bootstrap file set or role semantics without an explicit,
  documented fork decision

## Release gate

ClawMongo is healthy when:

- the heart remains OpenClaw-shaped
- the bridge remains markdown-shaped
- the brain remains MongoDB-shaped

If any of those collapse into each other, the architecture is drifting.
