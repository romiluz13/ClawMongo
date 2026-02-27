---
name: clawmongo-memory-routing
description: Deterministic routing for Markdown vs MongoDB memory in ClawMongo.
---

# ClawMongo Memory Routing

Use this skill only when MongoDB memory is active (`memory.backend = "mongodb"`)
or when MongoDB memory tools (`kb_search`, `memory_write`) are available.

## Purpose

Prevent conflicts between Markdown memory files and MongoDB memory collections.
Respect both systems and route reads/writes to the correct source.

## Source of truth rules

1. Markdown files are canonical for agent identity and instructions:
   - `SOUL.md`
   - `AGENTS.md`
   - `BOOT.md`
   - `SKILL.md` files
2. MongoDB is canonical for scalable business knowledge and structured memory:
   - knowledge base docs/chunks
   - structured durable facts
   - retrieval/session recall projections
3. Never treat the same logical record as canonical in both stores.

## Read routing

1. Always honor identity and policy docs from Markdown first.
2. For reference and documentation lookups, use `kb_search`.
3. For user/project/session memory recall, use `memory_search`.
4. If a user asks for raw file content, use file tools (`memory_get`/read-file path)
   on the relevant Markdown source.

## Write routing

1. Use `memory_write` for durable structured observations:
   - decisions
   - preferences
   - facts
   - architecture notes
2. Use Markdown memory files only for informal notes and scratch context.
3. Never duplicate the same durable fact in both MongoDB structured memory and
   Markdown as canonical state.

## Conflict prevention checks

Before writing, ask:

1. Is this identity or policy instruction text?
   - Yes -> Markdown.
2. Is this durable, queryable business knowledge or structured memory?
   - Yes -> MongoDB.
3. Is this temporary note or personal scratch context?
   - Yes -> Markdown daily memory.

If unclear, choose one canonical target and state it explicitly in the response.
