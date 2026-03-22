# Web Research: MongoDB Atlas Local (Preview) — mongod + mongot bundled Docker image

## Execution

- Preferred backend: websearch+webfetch
- Allowed fallbacks: websearch-only, webfetch-only
- Research round: 1 (understanding Atlas Local and why it supersedes separate mongod + mongot)

## Sources Used

- WebFetch on `raw.githubusercontent.com/mongodb/docs-atlas-cli/master/source/atlas-cli-deploy-docker.txt` — official Atlas CLI Docker deployment docs (verbatim RST source)
- WebFetch on `raw.githubusercontent.com/mongodb/docs-atlas-cli/master/source/atlas-cli-deploy-local.txt` — official Atlas CLI local deployment docs (verbatim RST source)
- WebFetch on `raw.githubusercontent.com/mongodb/docs-atlas-cli/master/source/atlas-cli-deploy-fts.txt` — Atlas CLI FTS + AVS docs
- Docker Hub API `hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/tags/` — confirmed all available tags including `preview`
- Live page fetch `mongodb.com/docs/atlas/atlas-vector-search/crud-embeddings/create-embeddings-automatic/` — auto-embedding feature docs with full content extraction
- Live page fetch `mongodb.com/docs/atlas/atlas-vector-search/deployment-options/` — deployment option recommendations

**Bright Data:** Not available; fell back to WebFetch + curl for raw sources.

## Research Quality

- Status: COMPLETE
- Quality level: high
- Backend mode: websearch+webfetch

---

## 1. What Is MongoDB Atlas Local?

MongoDB Atlas Local (`mongodb/mongodb-atlas-local`) is an official Docker image that packages a **single-node MongoDB replica set** alongside the **mongot search process** (the same Apache Lucene-based Atlas Search / Atlas Vector Search engine that runs in the cloud) into one container. It provides a self-contained local development environment that mirrors the Atlas cloud experience — including Atlas Search indexes ($search), Atlas Vector Search ($vectorSearch), and the preview auto-embedding feature — without requiring a cloud account or a separate mongot installation.

The image is maintained by MongoDB and published to Docker Hub at:

```
mongodb/mongodb-atlas-local
```

---

## 2. Docker Image Tags

Confirmed from the Docker Hub API (as of 2026-03-20, the latest rebuild date):

| Tag pattern                              | Purpose                                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latest`                                 | Current stable release (maps to latest MongoDB 8.x + mongot)                                                                                                                            |
| `8.2`, `8.2.6`, `8.2.6-20260320T081259Z` | Stable MongoDB 8.2.x + mongot                                                                                                                                                           |
| `8.0`, `8.0.20`, etc.                    | Stable MongoDB 8.0.x + mongot                                                                                                                                                           |
| `7.0`, `7.0.31`, etc.                    | Stable MongoDB 7.0.x + mongot                                                                                                                                                           |
| `preview`                                | **Pre-release channel** — currently tracks MongoDB 8.2 + mongot with auto-embedding (Voyage AI) enabled. Separate from `latest`; ~70 MB smaller per arch than `latest` as of 2026-03-20 |

The `preview` digest as of 2026-03-20: `sha256:4f4c43e8711ce31660b931bd96e76e679b311702a0cc49e03c926615aaf4c868`

The `latest` digest as of same date: `sha256:a3a49321a2be227f5de99015ac939be2c89d90725d8548c6f81147f175f70d8f` (different — they are distinct builds)

Both support `linux/amd64` and `linux/arm64`.

---

## 3. What the Image Bundles

- **mongod** — MongoDB Community Edition (the database engine, configured as a single-node replica set)
- **mongot** — MongoDB's internal search/vector search process (Apache Lucene-based), which handles:
  - `$search` queries (full-text, fuzzy, phrase, wildcard, boolean)
  - `$vectorSearch` queries (ANN, ENN)
  - Atlas Search index management
  - Automated embedding generation (in `preview` tag, requires Voyage AI API key)
- **Built-in health check** — the container reports `healthy` when both mongod and mongot are ready, so no custom health check is required in Docker Compose
- **Authentication support** — via `MONGODB_INITDB_ROOT_USERNAME` / `MONGODB_INITDB_ROOT_PASSWORD` environment variables
- **Data persistence** — via Docker volumes on `/data/db` and `/data/configdb`

---

## 4. Why This Supersedes Running mongod + mongot Separately

### Before Atlas Local

Running Atlas Search + Vector Search locally required:

1. Install MongoDB Community or Enterprise Edition (`mongod`)
2. Separately download, install, and configure `mongot` (the search process)
3. Configure `mongot` to bind to `mongod` via keyfile / keyfile path
4. Manage startup order (mongot must start before search indexes are built)
5. Manage both processes separately (logs, restarts, upgrades)
6. No official Docker image bundled them together — DIY setup was complex

### With Atlas Local

Single command replaces all of the above:

```sh
docker run -p 27017:27017 mongodb/mongodb-atlas-local
```

Or with Docker Compose:

```yaml
services:
  mongodb:
    image: mongodb/mongodb-atlas-local
    environment:
      - MONGODB_INITDB_ROOT_USERNAME=user
      - MONGODB_INITDB_ROOT_PASSWORD=pass
    ports:
      - 27017:27017
    volumes:
      - data:/data/db
      - config:/data/configdb
volumes:
  data:
  config:
```

Key advantages:

- **Single container, single pull** — one image contains everything
- **Correct startup sequencing** — the entrypoint ensures mongot starts in the right order relative to mongod; do not override the `command` in Docker Compose or it breaks this
- **Built-in health check** — poll `docker inspect .State.Health.Status` to know when to connect; no custom scripts needed
- **Parity with Atlas cloud** — the same mongot binary that runs in Atlas runs in this container, so `$search` / `$vectorSearch` index definitions, aggregation pipeline stages, and behavior match production exactly
- **CLI-managed** — the Atlas CLI (`atlas deployments setup`) uses this image under the hood; it handles the full lifecycle (create, pause, start, delete, logs)
- **Version-pinned deployments** — use `mongodb/mongodb-atlas-local:8.0` or `:7.0` to pin the MongoDB version across team environments
- **Preview channel** — `mongodb/mongodb-atlas-local:preview` gives access to in-development features (auto-embeddings) ahead of stable release

---

## 5. Auto-Embedding / Voyage AI Integration (Preview Feature)

### What It Is

"Automated Embedding" is a Preview feature available in MongoDB Community Edition **v8.2 and later**, delivered via the `preview` Docker tag.

Official statement from the docs:

> "Automated embedding is available as a Preview feature only for MongoDB Community Edition v8.2 and later. The feature and the corresponding documentation might change at any time during the Preview period."

### How It Works

When deploying `mongodb/mongodb-atlas-local:preview` (or MongoDB 8.2 with mongot started with Voyage AI API keys), you provide a Voyage AI API key at startup. mongot uses this key to:

1. **Index-time**: automatically call the Voyage AI embedding API for every text field you designate as `autoEmbed` type in the Vector Search index definition. Embeddings are generated for existing documents and kept in sync as documents are inserted/updated.
2. **Query-time**: automatically call the Voyage AI embedding API to embed the query text before running `$vectorSearch`. You pass a plain string via `query.text` instead of a pre-computed vector.

The generated embeddings are stored in a **separate system collection** on the same cluster (not in the user-facing document).

### Index Definition (autoEmbed type)

```json
{
  "fields": [
    {
      "type": "vectorSearch",
      "path": "summary",
      "autoEmbed": {
        "embeddingModel": "voyage-4"
      }
    }
  ]
}
```

### Query (natural language text, no pre-computed vector)

```js
db.collection.aggregate([
  {
    $vectorSearch: {
      index: "myVectorIndex",
      path: "summary",
      query: { text: "properties near amusement parks" },
      numCandidates: 100,
      limit: 10,
    },
  },
]);
```

### Supported Voyage AI Embedding Models

| Model                    | Use Case                                            |
| ------------------------ | --------------------------------------------------- |
| `voyage-4-lite`          | High-volume, cost-sensitive applications            |
| `voyage-4` (recommended) | General text search, balanced performance           |
| `voyage-4-large`         | Maximum accuracy for complex semantic relationships |
| `voyage-code-3`          | Code search and technical documentation             |

### API Key Recommendation

MongoDB recommends two separate Voyage AI API keys:

- One for **indexing operations** (higher throughput, tolerant of delays)
- One for **query operations** (low-latency, user-facing)

Keys can be generated via Atlas UI (which also provides monitoring + rate limiting UI) or directly from Voyage AI.

### Why This Matters for ClawMongo

ClawMongo v2 currently calls the Voyage AI API externally from application code (via the `mongodb-search.ts` / hybrid pipeline). With auto-embedding in the `preview` image:

- No application code needed to call Voyage AI at index time or query time
- mongot handles embedding generation and sync automatically
- `$vectorSearch` queries can use plain text (`query.text`) instead of pre-computed vectors
- This simplifies the architecture: ClawMongo could delegate all embedding lifecycle to mongot

---

## 6. Key Limitations (Preview Status)

From the official auto-embedding docs (as of 2026-03-22):

1. **Preview means unstable** — "The feature and the corresponding documentation might change at any time during the Preview period." API surface, behavior, or index definition syntax may break between preview releases.

2. **Deployment scope** — Auto-embedding is **not yet available** for:
   - Atlas clusters (cloud)
   - Local Atlas deployments via the Atlas CLI (`atlas deployments setup`)
   - MongoDB Enterprise Edition
   - It is **only** available for MongoDB Community Edition with mongot deployed via Docker, tarball, or package manager, or via the MongoDB Controllers for Kubernetes Operator with MongoDB 8.2+.

3. **Minimum version** — MongoDB Community Edition v8.2+ required (8.0 and 7.0 tags do not include auto-embedding support in mongot).

4. **Cost** — Every insert/update/query triggers Voyage AI API calls billed to your Voyage AI account. Pricing is per-token.

5. **Standard Atlas Local limitations** (not preview-specific):
   - No concurrent search queries
   - Max 1024 boolean clauses in a single search query
   - Single-node replica set only (no sharding)
   - For CLI-managed local deployments: only deployments created via `atlas deployments` CLI are manageable through it
   - Tested OS: macOS 13.2+, RHEL/CentOS 8/9, Ubuntu 22.04/24.04, Debian 11/12, Amazon Linux 2023, Windows 10/11; min 2 CPU cores, 2 GB RAM

6. **Do not override ENTRYPOINT** — The `mongodb/mongodb-atlas-local` image has a custom entrypoint that starts both mongod and mongot in the correct sequence. If you add a `command:` key in Docker Compose, it overrides the entrypoint and mongot will not start correctly. This is the #1 gotcha when migrating from `mongo:` image.

---

## 7. Comparison: mongod Standalone vs Atlas Local vs Preview

| Aspect                              | `mongo:8.0` (raw mongod) | `mongodb/mongodb-atlas-local` (stable) | `mongodb/mongodb-atlas-local:preview` |
| ----------------------------------- | ------------------------ | -------------------------------------- | ------------------------------------- |
| Atlas Search ($search)              | No                       | Yes                                    | Yes                                   |
| Atlas Vector Search ($vectorSearch) | No                       | Yes                                    | Yes                                   |
| Auto-embeddings (Voyage AI)         | No                       | No                                     | Yes (Preview)                         |
| Built-in health check               | No                       | Yes                                    | Yes                                   |
| Single container                    | Yes                      | Yes                                    | Yes                                   |
| Production-safe                     | Yes                      | Dev/test only                          | No (Preview)                          |
| Min MongoDB version                 | Any                      | 7.0+                                   | 8.2+                                  |

---

## What Changed the Recommendation

The single highest-signal finding: **auto-embedding in the `preview` tag requires MongoDB 8.2+ and is a Preview feature that is explicitly NOT available in the stable tags or via `atlas deployments setup`.** Users wanting auto-embeddings must use `mongodb/mongodb-atlas-local:preview` directly via Docker (not through the Atlas CLI `atlas deployments` command).

For ClawMongo users who want the simpler zero-embedding-code experience with Voyage AI, the `preview` tag is the only supported path today. For users who want a stable embedding pipeline, the stable `8.2` tag (without `preview`) with manually-managed Voyage AI calls in application code is the safer choice.

---

## Gotchas / Warnings

- **Never add `command:` to Docker Compose when using `mongodb-atlas-local`** — it overrides the entrypoint and mongot will not start. Remove any `command:` from existing Docker Compose files when migrating from `mongo:` image.
- **Preview tag is not stable** — documentation and behavior can change at any time; do not use `preview` in production.
- **`preview` and `latest` are different builds** — they have different digests and different sizes. Do not assume `preview` is ahead of `latest`; they track different feature channels.
- **MongoDB 8.2 is the minimum for auto-embeddings** — using `preview` tag with MongoDB 7.0 base image equivalent would not give auto-embedding; the `preview` tag ships with the 8.2 server.
- **Health check polling required** — wait for `docker inspect .State.Health.Status == healthy` before connecting; the container takes time for both mongod and mongot to initialize.
- **Connection string must include `directConnection=true`** — single-node replica set requires direct connection: `mongodb://localhost:27017/?directConnection=true`.
- **Voyage AI API key at startup** — for auto-embeddings, the API key must be passed to mongot at container startup time (via environment variable or config), not after the fact.
- **Token billing starts immediately** — as soon as auto-embedding is configured, every document insert/update/query incurs Voyage AI token charges.
- **Not for production workloads** — Atlas Local is a dev/test image; it is a single-node replica set with no HA, no backups, and no enterprise support.

---

## References

- https://hub.docker.com/r/mongodb/mongodb-atlas-local (Docker Hub — confirmed tag list via API)
- https://raw.githubusercontent.com/mongodb/docs-atlas-cli/master/source/atlas-cli-deploy-docker.txt (official Docker deployment tutorial source)
- https://raw.githubusercontent.com/mongodb/docs-atlas-cli/master/source/atlas-cli-deploy-local.txt (official local deployment tutorial source)
- https://raw.githubusercontent.com/mongodb/docs-atlas-cli/master/source/atlas-cli-deploy-pvt-registry.txt (private registry / tag info)
- https://www.mongodb.com/docs/atlas/atlas-vector-search/crud-embeddings/create-embeddings-automatic/ (auto-embedding feature documentation — key source)
- https://www.mongodb.com/docs/atlas/atlas-vector-search/deployment-options/ (deployment option recommendations)

---

Web research complete.
