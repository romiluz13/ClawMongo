# Web Research: MongoDB Docker Image Verification for Auto-Embeddings

## Execution
- Preferred backend: websearch+webfetch
- Allowed fallbacks: websearch-only
- Research round: 1

## Sources Used
- Docker Hub API v2 (mongodb/mongodb-atlas-local repository info + tags) -- SUCCESS, primary source
- Docker Hub API v2 (mongodb/mongodb-community-server repository info) -- SUCCESS
- Docker Hub API v2 (mongodb/mongodb-community-search repository info + tags) -- SUCCESS
- GitHub raw README (mongodb-js/mongodb-mcp-server) -- SUCCESS
- GitHub mongot README -- SUCCESS, partial
- MongoDB docs pages (atlas-vector-search/create-embeddings) -- FAILED (CSS-only rendering)
- MongoDB blog posts -- FAILED (404 / CSS-only rendering)

## Research Quality
- Status: COMPLETE
- Quality level: high
- Backend mode: websearch+webfetch
- Note: Docker Hub API returned full structured data including complete README. MongoDB docs pages failed to render content but Docker Hub README contained the authoritative documentation text.

---

## CRITICAL ANSWER: Which Docker Image Supports Auto-Embeddings?

### Answer: `mongodb/mongodb-atlas-local:preview` -- and ONLY the `preview` tag.

Auto-embedding with Voyage AI is an **experimental feature** available exclusively on the `preview` tag. The `8.0`, `8.2`, `7.0`, and `latest` tags do NOT support auto-embedding.

This is confirmed by the official Docker Hub README (retrieved via API):

> **Preview builds**
> The `preview` tag makes new experimental features available in Atlas Local.
> Note: The `preview` tag only supports the latest version of MongoDB.
>
> **Current experimental features:**
> - Use of MongoDB Search in Community image
>   - This edition of MongoDB Search (mongot) enables use of auto-embedding, utilizing AI to automatically embed your vector indexes.
>   - Provide your Voyage API key through the environment variable `VOYAGE_API_KEY`.

---

## Q1: What Docker image supports auto-embeddings (Voyage AI)?

**Image:** `mongodb/mongodb-atlas-local`
**Required tag:** `preview`
**NOT supported on:** `latest` (= 8.2.6), `8.0`, `8.2`, `7.0`, or any version-pinned tag

### Tag breakdown (as of 2026-03-20):

| Tag | MongoDB Version | Digest (prefix) | Auto-Embed? | Notes |
|-----|----------------|-----------------|-------------|-------|
| `preview` | Latest (experimental) | `sha256:4f4c43e8...` | YES | Unique image, 584 MB |
| `latest` | 8.2.6 | `sha256:a3a49321...` | NO | Same as `8.2`, `8.2.6`, `8` |
| `8.2` | 8.2.6 | `sha256:a3a49321...` | NO | Same as `latest` |
| `8.0` | 8.0.20 | `sha256:1040c810...` | NO | |
| `7.0` | 7.0.31 | `sha256:fe2165cf...` | NO | |

Key observations:
- `preview` has a **completely different digest** from all other tags -- it is a separate, distinct image
- `preview` is **smaller** (584 MB) vs `latest` (651 MB), suggesting different internal components (uses `mongodb-community-search` mongot instead of standard mongot)
- `latest` = `8.2` = `8.2.6` = `8` (identical digest `sha256:a3a49321...`)

## Q2: mongodb-atlas-local vs mongodb-community-server

### mongodb/mongodb-atlas-local
- Includes **both** `mongod` AND `mongot` (MongoDB Search) as a single-node replica set
- Supports Atlas Search and Atlas Vector Search out of the box
- The `preview` tag additionally includes experimental auto-embedding via Voyage AI
- Description: "Create, manage, and automate MongoDB Atlas Local resources from docker"
- Pull count: ~5.3M
- Last updated: 2026-03-20

### mongodb/mongodb-community-server
- **mongod only** -- no mongot, no Atlas Search, no Vector Search, no auto-embeddings
- Description: "The Official MongoDB Community Server"
- Just the database server, no search functionality bundled
- Pull count: ~21.1M
- Last updated: 2026-03-22

### mongodb/mongodb-community-search (mongot standalone)
- The search service (mongot) as a standalone image
- Open source under SSPL v1
- Latest version: 0.60.1 (2026-01-15)
- This is what the `preview` tag of atlas-local bundles instead of the standard proprietary mongot
- Supports Full Text Search and Vector Search
- The community edition is what enables auto-embedding

**Bottom line:** You NEED `mongodb-atlas-local` for search features. `mongodb-community-server` does NOT include mongot/search/vector-search/auto-embeddings.

## Q3: Auto-embedding public preview status

### Status: EXPERIMENTAL / PREVIEW

Auto-embedding is:
- Part of the "MongoDB Search in Community" initiative
- Available only through the `preview` tag of `mongodb-atlas-local`
- NOT generally available (GA)
- Subject to change at any time during the preview period

### Known limitations (from official Docker Hub README):
1. **MongoDB Search in Community image is in preview and may change at any time**
2. **`$listSearchIndexes` aggregation stage is not complete** in the preview image
3. **Only supported embedding provider endpoint is `ai.mongodb.com`** -- you cannot point to Voyage AI directly; you must go through MongoDB's AI gateway
4. **Voyage API key must be provisioned via the Atlas UI** -- see Model API Keys docs
5. **Rate limiting (429) on lower AI Model tiers** -- see Manage Rate Limits docs

### Configuration:
- Pass Voyage API key via environment variable: `VOYAGE_API_KEY`
- Example: `docker run -e VOYAGE_API_KEY=your-key -p 27017:27017 mongodb/mongodb-atlas-local:preview`

## Q4: The `preview` tag specifically -- VERIFIED

### CONFIRMED: `preview` supports auto-embeddings; `8.0` / `8.2` / `latest` do NOT.

Evidence:
1. The Docker Hub README explicitly lists auto-embedding under "Current experimental features" of the `preview` tag section only
2. `preview` has a unique digest (`sha256:4f4c43e8...`) different from all version tags
3. `preview` is smaller (584 MB vs 639-651 MB) because it uses the community search (mongot) edition instead of the standard proprietary mongot
4. The four "fundamental supported tags" are explicitly documented as:
   - `latest` -- latest stable release
   - `preview` -- latest stable release **with new experimental features**
   - `8.0` -- latest 8.0
   - `7.0` -- latest 7.0

The `preview` tag bundles `mongodb-community-search` (the open-source mongot) which is what provides auto-embedding. The standard tags bundle the proprietary mongot which does NOT have auto-embedding.

## Q5: What does the MongoDB MCP Server say?

### CONFIRMED: MCP Server defaults to `preview` tag

From the MongoDB MCP Server README:
- `atlas-local-create-deployment` tool: **"Default image is preview"**
- When no image tag is specified, preview is used by default
- The MCP Server accepts `MDB_MCP_VOYAGE_API_KEY` configuration: "API key for Voyage AI embeddings service (required for creating Atlas Local deployments with auto-embed vector search capabilities)"

This means the MongoDB team themselves chose `preview` as the default for their MCP tooling, explicitly to enable auto-embedding capabilities.

---

## What Changed the Recommendation

The single highest-signal finding: **Auto-embedding ONLY works on the `preview` tag because it uses a fundamentally different search component (mongodb-community-search/mongot-community) instead of the standard proprietary mongot.** This is not a configuration difference -- it is a different binary. The `preview` image has a completely different digest and is actually smaller (584 MB vs 651 MB for `latest`), confirming it ships different components. If ClawMongo documentation tells users to use `:latest` or `:8.0`, auto-embedding will silently not work.

## Gotchas / Warnings

1. **CRITICAL: `latest` != auto-embedding support.** `latest` tracks stable 8.2.x. `preview` is a separate image with different internals.
2. **`$listSearchIndexes` is incomplete on `preview`.** This may affect index management tooling.
3. **Voyage API keys must be provisioned through Atlas UI**, not through Voyage AI directly. The only supported endpoint is `ai.mongodb.com`.
4. **Rate limiting on lower tiers.** Users on free/lower Atlas tiers will hit 429 errors with heavy embedding workloads.
5. **Preview tag tracks "latest version of MongoDB"** but with experimental features. The underlying MongoDB version is not pinned -- it will change.
6. **The preview feature may change at any time.** Production systems should be aware this is not GA.
7. **Community search (mongot) is SSPL licensed** -- different license than the standard proprietary mongot in other tags.
8. **mongodb-community-server does NOT include mongot at all.** Users who accidentally use the wrong image get no search capabilities.

## Image Selection Decision Matrix

| Use Case | Recommended Image | Tag |
|----------|------------------|-----|
| Production with vector search (no auto-embed) | `mongodb/mongodb-atlas-local` | `8.0` or `latest` |
| Development with auto-embedding | `mongodb/mongodb-atlas-local` | `preview` |
| Auto-embedding required | `mongodb/mongodb-atlas-local` | `preview` (ONLY option) |
| Basic MongoDB, no search | `mongodb/mongodb-community-server` | `8.0` or `latest` |
| Standalone mongot for custom setup | `mongodb/mongodb-community-search` | `latest` (0.60.1) |

## References

- Docker Hub API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/ (full README retrieved)
- Docker Hub tags API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/tags/
- Docker Hub: https://hub.docker.com/r/mongodb/mongodb-community-server
- Docker Hub: https://hub.docker.com/r/mongodb/mongodb-community-search
- GitHub mongot: https://github.com/mongodb/mongot
- MongoDB MCP Server README: https://github.com/mongodb-js/mongodb-mcp-server
- MongoDB auto-embed docs (referenced in README): https://www.mongodb.com/docs/atlas/atlas-vector-search/crud-embeddings/create-embeddings-automatic/
- Voyage AI Model API Keys: https://www.mongodb.com/docs/voyageai/management/api-keys/
- Voyage AI Rate Limits: https://www.mongodb.com/docs/voyageai/management/rate-limits/

---
Web research complete.
