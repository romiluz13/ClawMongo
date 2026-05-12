---
title: "ClawMongo preservation audit"
summary: "What the upstream sync preserves from the ClawMongo fork and what upstream supersedes"
read_when:
  - Reviewing the ClawMongo upstream sync
  - Checking whether custom ClawMongo memory, skills, or identity files survived
---

# ClawMongo preservation audit

This page records the intentional preservation decisions for the upstream sync
from the last pre-sync ClawMongo commit (`42125bdb39`) onto current OpenClaw.

## Preserved as ClawMongo contract

- MongoDB is the only runtime memory backend.
- `clawmongo` remains a CLI binary alias.
- ClawMongo docs remain present:
  - [Getting started](/start/clawmongo-getting-started)
  - [ClawMongo vs default memory](/reference/clawmongo-vs-default-memory)
  - [MongoDB capabilities](/reference/mongodb-capabilities)
- MongoDB runtime code remains under `src/memory/**`.
- MongoDB setup code remains under `docker/mongodb/**` and `src/docker/mongodb-*`.
- Agent memory tools remain MongoDB-backed:
  - `memory_search`
  - `memory_get`
  - `memory_write`
  - `memory_active_slate`
  - `memory_discovery_projection`
  - `memory_context_bundle`
  - `memory_reasoning_chain`
  - `memory_novelty_scan`
  - `kb_search`
- Workspace templates describe MongoDB as the sole runtime memory store.

## Preserved with upstream merge

- `AGENTS.md` keeps upstream architecture and verification rules, with
  ClawMongo-specific MongoDB product rules added near the top.
- `docs/reference/templates/AGENTS` keeps upstream startup-context guidance, with
  ClawMongo memory guidance updated for MongoDB-only runtime memory.
- `docs/reference/templates/SOUL` keeps the personality template while clarifying
  that MongoDB, not workspace files, is durable runtime memory.
- `skills/healthcheck/SKILL.md` stays available for operational hardening.
- `skills/bluebubbles/SKILL.md` is restored as a user-facing skill note even
  though upstream removed the bundled BlueBubbles plugin package.

## Superseded by upstream architecture

- Old canvas CLI/tool files are superseded by the upstream `extensions/canvas`
  plugin.
- Old private QA CLI files are superseded by upstream private QA CLI loader
  paths and QA plugins.
- Several old agent/provider test files were superseded by upstream provider,
  auth-profile, and transport refactors.
- `packages/memory-host-sdk` remains for upstream plugin compatibility; MongoDB
  runtime memory lives in `src/memory/**`.

## Packaging decision

The workspace root package name remains `openclaw` because many upstream
workspace packages depend on `openclaw@workspace:*`. ClawMongo identity is
preserved through:

- `bin.clawmongo`
- package description and repository metadata
- README/docs
- `scripts/clawmongo-publish-manifest.mjs`, which writes a generated
  `@romiluz/clawmongo` publish manifest under `.artifacts/`

Do not change the workspace root package name back to `@romiluz/clawmongo`
inside the monorepo unless the upstream workspace dependency graph is updated at
the same time.

## Still requires live proof

- Atlas Local Preview with `mongodb-atlas-local:preview`
- MongoDB Atlas cloud
- Real agent write, recall, structured memory, context bundle, provenance, and
  KB search

These need Docker or Atlas credentials and cannot be proven in an environment
without MongoDB runtime access.
