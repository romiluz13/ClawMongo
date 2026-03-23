# ClawMongo vs OpenClaw Default Memory

## Overview

OpenClaw ships with QMD (SQLite + Markdown files) as its default memory backend. ClawMongo replaces this with MongoDB Community + mongot + Voyage AI. This page compares the two approaches feature by feature to help you decide which is right for your workload.

Both are valid choices. The default memory is simpler to set up. ClawMongo is more capable at scale. This is not a judgment -- it is a tradeoff.

---

## Feature Comparison

| Capability                 | OpenClaw Default (QMD/SQLite)                              | ClawMongo (MongoDB)                                                                  |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Storage backend**        | SQLite file + Markdown files                               | MongoDB Community (replica set)                                                      |
| **Vector search**          | sqlite-vec extension or LanceDB                            | mongot + Voyage AI autoEmbed (`voyage-4-large`)                                      |
| **Embedding management**   | Application-side (OpenAI, Gemini, Voyage, Mistral, Ollama) | Automated via mongot (zero application-side code)                                    |
| **Full-text search**       | SQLite FTS5 / BM25                                         | mongot text indexes (Lucene standard analyzer)                                       |
| **Hybrid search**          | BM25 + vector with MMR diversity                           | `$rankFusion` / `$scoreFusion` + manual RRF fallback                                 |
| **Knowledge graph**        | None                                                       | `$graphLookup` with entities, relations, bi-directional expansion                    |
| **Episodes**               | None                                                       | Auto-materialized from event windows (daily, weekly, thread, topic, decision)        |
| **Event sourcing**         | None (append-only Markdown)                                | Canonical events collection with derived projections                                 |
| **Structured memory**      | Basic key-value facts                                      | Salience, temporal validity, state, provenance, revision tracking                    |
| **Procedures**             | None                                                       | Versioned workflow artifacts with intent tags and ordered steps                      |
| **Retrieval paths**        | 1 (search)                                                 | 8 (active-critical, procedural, structured, raw-window, graph, episodic, kb, hybrid) |
| **Retrieval planning**     | Simple search dispatch                                     | Pure-function planner scoring paths based on query analysis                          |
| **Reranking**              | MMR (Maximal Marginal Relevance)                           | Source diversity penalty + episode boost + deduplication                             |
| **Schema validation**      | None                                                       | JSON Schema (`$jsonSchema`) on 19 collections                                        |
| **Multi-tenant isolation** | Filesystem separation                                      | Compound indexes with `agentId` prefix                                               |
| **Cross-instance sync**    | File sync (rsync, git)                                     | MongoDB replica set + change streams                                                 |
| **Operational visibility** | Limited                                                    | Ingest runs, projection runs, relevance telemetry (3 collections)                    |
| **Data model**             | Flat files + SQLite rows                                   | 23 collections, 66 standard indexes, up to 9 search indexes                          |
| **Entity extraction**      | None                                                       | Rule-based from conversations (@mentions, #tags, URLs, paths, quoted names)          |
| **Graph traversal**        | None                                                       | `$graphLookup` with `restrictSearchWithMatch` for tenant isolation                   |
| **Memory lifecycle**       | Manual                                                     | TTL indexes for caches/telemetry, consolidation lifecycle for events                 |
| **Write idempotency**      | File overwrites                                            | `$setOnInsert` + `$set` on unique compound keys                                      |
| **Diagnostic tools**       | Limited                                                    | `memory relevance *` CLI with explain-driven telemetry                               |

---

## When to Use OpenClaw Default Memory

The default memory backend is the right choice when:

- **Single user, small corpus**: You are one person with a modest amount of conversation history and notes. SQLite handles this well.
- **Local-only deployment**: You run OpenClaw on one machine with no need for multi-instance sync. File-based storage is simpler.
- **No operational requirements**: You do not need retrieval diagnostics, schema validation, or audit trails on your agent's memory.
- **Minimal setup time**: You want to start using OpenClaw in 2 minutes without setting up MongoDB.
- **No knowledge graph needs**: Your use case does not require entity relationships or graph traversal.

The default memory works well for personal note-taking assistants, simple Q&A bots, and single-machine setups where retrieval quality is not a primary concern.

---

## When to Use ClawMongo

ClawMongo is the right choice when:

- **Team-scale knowledge**: Your agent processes enough data that flat-file search quality degrades. MongoDB indexes maintain performance as the corpus grows.
- **Retrieval quality SLOs**: You need to measure and maintain retrieval quality over time. Relevance telemetry gives you the data to do this.
- **Production deployment**: You need schema validation, idempotent writes, and operational visibility. Production systems need these guarantees.
- **Multi-instance sync**: You run multiple gateway instances that need to share memory state. MongoDB replica sets handle this natively.
- **Knowledge graph**: Your agent needs to understand relationships between entities (people, projects, topics) and traverse them during retrieval.
- **Episode materialization**: You want conversation threads automatically summarized into searchable episodes.
- **Auditable memory**: You need to know what was written, when, and why. Event-sourcing provides a complete audit trail.
- **MongoDB expertise**: Your team already operates MongoDB and wants to use familiar tooling, monitoring, and backup infrastructure.

---

## What You Keep Either Way

Both configurations give you the full OpenClaw platform:

- 22 messaging channels (WhatsApp, Telegram, Slack, Discord, and 18 more)
- 78 extensions (25+ LLM providers, tools, media, infra)
- Companion apps (macOS, iOS, Android)
- Voice Wake + Talk Mode
- Live Canvas + A2UI
- Browser control
- Skills platform
- Gateway control plane

The memory backend is a pluggable layer. Switching from default to ClawMongo changes how your agent stores and retrieves memory. It does not change how the agent communicates, reasons, or uses tools.

---

## Migration Path

ClawMongo includes a built-in migration function (`backfillEventsFromChunks`) that reads existing chunk data and creates canonical events from it. This allows existing OpenClaw users to migrate their conversation history into ClawMongo's event-sourced model.

Steps:

1. Install ClawMongo: `npm install -g @romiluz/clawmongo@latest`
2. Configure MongoDB connection: `clawmongo config set memory.mongodb.uri "mongodb://..."`
3. Run onboarding: `clawmongo onboard --install-daemon`
4. The migration runs automatically on first startup when it detects existing chunk data without corresponding events.

After migration, ClawMongo uses MongoDB as the sole memory backend. The original Markdown/SQLite files remain untouched as a backup but are no longer read by the runtime.

---

## Numbers at a Glance

| Metric                       | OpenClaw Default   | ClawMongo                    |
| ---------------------------- | ------------------ | ---------------------------- |
| Collections                  | ~2 (SQLite tables) | 20                           |
| Indexes                      | Few                | 53 standard + up to 8 search |
| Retrieval paths              | 1                  | 8                            |
| Schema-validated collections | 0                  | 17                           |
| Unit tests (memory module)   | Varies             | 573                          |
| v2 memory unit tests         | N/A                | 205                          |
| Live e2e tests               | N/A                | 53 (MongoDB 8.2 + Voyage AI) |
