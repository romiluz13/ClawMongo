# ClawMongo Upstream Harmony Plan (MongoDB First + Markdown Respect)

Date: 2026-02-27

## Objective

Ship a MongoDB-first OpenClaw fork that stays close to upstream while preserving
the critical role of Markdown files (`SOUL.md`, skills, policy docs).

## Non-negotiables

1. Upstream-first fork model: rebase frequently, keep deltas isolated.
2. No dual canonical stores for one entity type.
3. Markdown files remain first-class for identity, behavior, and instructions.
4. MongoDB is first-class for business knowledge, runtime memory, and retrieval.
5. Runtime behavior must be deterministic and documented.

## Canonical ownership matrix

| Data type                                                             | Canonical store                             | Why                                                                      | Access path                                  |
| --------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| Agent identity and rules (`SOUL.md`, `AGENTS.md`, `BOOT.md`)          | Markdown workspace files                    | Human-editable policy and persona must be explicit and versioned as text | Prompt assembly and file reads               |
| Skill instructions (`SKILL.md`)                                       | Markdown skill files                        | Skills are procedural instructions, not database records                 | Skills loader + system prompt skill snapshot |
| Business knowledge base (product docs, FAQ, marketing docs, runbooks) | MongoDB (`knowledge_base`, `kb_chunks`)     | Large scale, searchable, filterable, embeddable                          | `kb_search`, ingestion jobs                  |
| Structured durable facts (decisions, preferences, project facts)      | MongoDB (`structured_mem`)                  | Atomic upsert by key, easy retrieval and attribution                     | `memory_write`, `memory_search`              |
| Session transcript files used by core runtime                         | Filesystem (current upstream compatibility) | Core session lifecycle still file-coupled                                | Session manager + compact flow               |
| Session recall projection for search                                  | MongoDB chunks                              | Fast semantic and hybrid retrieval over conversation history             | `memory_search`                              |
| Pipeline/job state, ingestion metadata, observability                 | MongoDB                                     | Operational visibility and retries                                       | worker jobs + analytics commands             |

## Retrieval choreography

For every turn, retrieval should follow this fixed order:

1. Load identity and hard rules from Markdown (`SOUL.md`, `AGENTS.md`, active skills).
2. Load immediate session context from runtime session state.
3. Run MongoDB retrieval:
   - `kb_search` for reference docs.
   - `memory_search` for personal/project memory and session recall.
4. Rank results, attach source attribution, and inject into model context.
5. Persist retrieval trace for debugging and quality analysis.

This prevents conflicts:

- Markdown governs behavior and policy.
- MongoDB governs recall and knowledge at scale.

## Write choreography

Use deterministic routing for writes:

1. `memory_write` -> MongoDB structured memory only.
2. KB import/sync -> MongoDB KB collections only.
3. Explicit informal notes -> Markdown (`MEMORY.md` or daily `memory/YYYY-MM-DD.md`).
4. Session runtime logs -> existing filesystem path (plus optional MongoDB projection).

No write path should store the same logical record as canonical in both places.

## Skill strategy for MongoDB behavior

Create a dedicated skill pack that teaches routing and operational behavior:

1. `clawmongo-memory-routing`
   - Decides when to use `kb_search`, `memory_search`, `memory_write`, or file notes.
2. `clawmongo-kb-ingestion-ops`
   - Ingestion checklist, chunking rules, metadata rules, retry semantics.
3. `clawmongo-retrieval-debug`
   - How to inspect low-confidence retrieval and attribution failures.
4. `clawmongo-mongodb-ops`
   - Index checks, health checks, change stream status, backup checks.

Keep these as Markdown skills so behavior remains auditable and editable.

## Pipeline architecture

### Ingestion path

1. Receive source content.
2. Normalize metadata (`source`, `owner`, `tags`, `category`, `updatedAt`).
3. Chunk deterministically.
4. Persist chunks + metadata in MongoDB.
5. Trigger embeddings/enrichment.
6. Mark job status and emit metrics.

### Enrichment path

1. Automatic embeddings (server-managed where configured).
2. Retry failed chunks with bounded retries.
3. Record `embeddingStatus` and coverage metrics.

### Retrieval path

1. Apply filter preselection (`tags`, `category`, `source`, tenant/agent scope).
2. Hybrid retrieval (vector + lexical).
3. Deterministic rerank.
4. Return snippets with source and score.

### Reactive path

1. Change streams update caches/projections.
2. If change streams unavailable, fall back to periodic sync jobs.

## Consistency and conflict prevention

1. Idempotency key for inbound events: `channel + account + chat + providerMessageId`.
2. Unique constraints for structured memory keys (`agentId + type + key`).
3. Transaction usage only for multi-document invariants (KB replace/delete cycles).
4. Explicit status for degraded components; no silent backend switching.

## Upstream sync model

1. Maintain `UPSTREAM_DELTA_MAP.md` for every intentional fork difference.
2. Rebase cadence: at least weekly.
3. Conflict rule:
   - Default to upstream behavior.
   - Keep MongoDB-specific behavior in isolated modules and config seams.
4. Gate all new MongoDB behavior behind clear config and tests.

## Execution phases and gates

### Phase 0: Contract lock

- Finalize ownership matrix and routing rules in docs.
- Gate: no ambiguous entity ownership remains.

### Phase 1: Runtime and docs parity

- Ensure docs match actual backend behavior.
- Gate: memory behavior claims map to code paths and tests.

### Phase 2: CI hard gates

- Add mandatory MongoDB integration lane in CI.
- Gate: no RC release without Mongo integration passing.

### Phase 3: Onboarding reliability

- Docker and non-Docker onboarding paths both must pass smoke tests.
- Gate: fresh install works on macOS, Linux, WSL2.

### Phase 4: Retrieval quality and observability

- Add retrieval traces, confidence counters, and diagnostics.
- Gate: low-confidence queries are measurable and debuggable.

### Phase 5: Launch readiness

- Validate upgrade path, rollback path, backup/restore path.
- Gate: go/no-go checklist fully green.

## Scenario drills before release

1. MongoDB unavailable at startup.
2. MongoDB disconnect mid-conversation.
3. Duplicate webhook delivery for same message.
4. KB document updated repeatedly in short windows.
5. High-volume enterprise KB import.
6. Group chat with mention gating and per-channel memory scope.
7. Fresh install with Docker unavailable.
8. Fresh install with local replica set.

## Definition of done

1. Clear and enforced split: Markdown for identity and instructions, MongoDB for knowledge and runtime memory retrieval.
2. Deterministic read/write routing with no ambiguous ownership.
3. Upstream sync process active and repeatable.
4. CI and onboarding gates green across supported environments.
5. Launch docs consistent with runtime behavior.
