---
name: clawmongo-heart-brain-audit
description: Audit ClawMongo's boundary between OpenClaw heart files, Markdown bridge memory, and MongoDB runtime memory.
---

# ClawMongo Heart Brain Audit

Use this skill when reviewing architecture changes, upstream merges, memory behavior,
or any change that could blur the boundary between:

- OpenClaw heart files
- Markdown bridge memory
- MongoDB runtime memory

## Objective

Protect the OpenClaw workspace model while keeping ClawMongo MongoDB-first.

Treat the system as three ownership zones:

1. Heart: file-authoritative identity, policy, and bootstrap context
2. Bridge: human-authored Markdown memory that may sync into MongoDB
3. Brain: MongoDB-backed retrieval, KB, sessions, and structured memory

## Canonical ownership

### Heart

These remain file-authoritative and must not become Mongo-native canonical state:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`

### Bridge

These are human-authored memory inputs and may be mirrored into MongoDB for retrieval:

- `MEMORY.md`
- `memory.md`
- `memory/*.md`

### Brain

These are MongoDB-native runtime memory systems:

- synchronized memory chunks
- synchronized session chunks
- knowledge base docs and chunks
- structured memory records
- retrieval diagnostics and relevance telemetry

## Required audit workflow

1. Read `docs/reference/heart-brain-boundary.md` first.
2. Compare current ClawMongo behavior to upstream reference behavior.
3. Verify that workspace/bootstrap semantics still match OpenClaw.
4. Verify that MongoDB changes affect retrieval and durable memory, not identity canon.
5. Report any ownership violations explicitly.

## Files to inspect

Always inspect these files when relevant:

- `src/agents/workspace.ts`
- `openclaw-source-ref-only/src/agents/workspace.ts`
- `src/agents/system-prompt.ts`
- `openclaw-source-ref-only/src/agents/system-prompt.ts`
- `src/memory/internal.ts`
- `src/agents/tools/memory-tool.ts`
- `src/memory/mongodb-manager.ts`
- `src/memory/mongodb-sync.ts`
- `src/memory/mongodb-kb.ts`
- `src/memory/mongodb-structured-memory.ts`

Inspect these too when config or startup behavior changed:

- `src/memory/backend-config.ts`
- `src/memory/search-manager.ts`
- `src/gateway/server-startup-memory.ts`
- `src/wizard/onboarding-memory.ts`
- `src/commands/configure-memory.ts`

## What counts as a violation

Flag these as violations:

1. Heart files are added to MongoDB sync/index/watch paths.
2. MongoDB structured memory or KB is used as canonical identity, persona, or policy.
3. The system prompt changes heart-file roles instead of only changing memory routing.
4. `MEMORY.md` or `memory/*.md` is treated as equivalent to DB-native structured memory.
5. Upstream workspace/bootstrap semantics drift without a MongoDB-specific reason.

## Safe divergences

These are usually acceptable:

1. MongoDB-specific retrieval routing in `src/agents/system-prompt.ts`
2. MongoDB-only memory tools and exact-read locators
3. Sync of `MEMORY.md` and `memory/*.md` into MongoDB for retrieval
4. MongoDB-native KB and structured memory collections
5. Fail-fast removal of non-Mongo backends if heart-file semantics stay intact

## Output format

Use this exact structure:

- `Boundary Status`
- `Findings`
- `Upstream Alignment`
- `Ownership Map`
- `Required Fixes`
- `Safe Divergences`

Use `references/report-template.md` as the response skeleton when helpful.

## Guardrails

- Do not propose moving heart files into MongoDB.
- Do not weaken upstream compatibility without naming the exact benefit.
- Do not call the boundary sound unless both ownership and upstream parity are checked.
- Prefer narrow MongoDB overlays over broad OpenClaw rewrites.
