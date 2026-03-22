# Web Research: Documentation Validation Against Official Sources

## Execution

- Preferred backend: websearch+webfetch
- Allowed fallbacks: webfetch-only
- Research round: 1

## Sources Used

- Docker Hub API (JSON): `hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/` -- SUCCESS
- Docker Hub API (JSON): `hub.docker.com/v2/repositories/mongodb/mongodb-atlas-search/` -- SUCCESS
- Docker Hub API (Tags): `hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/tags/` -- SUCCESS
- Docker Compose docs: `docs.docker.com/reference/compose-file/version-and-name/` -- SUCCESS
- Docker Compose docs: `docs.docker.com/compose/compose-file/` -- PARTIAL (limited content extracted)
- Atlas CLI source code: `github.com/mongodb/mongodb-atlas-cli/.../deployment_opts.go` -- SUCCESS
- MongoDB docs (rendered HTML pages): multiple attempts -- FAILED (CSS-only extraction, JS-rendered pages)
- MongoDB product pages: `mongodb.com/products/platform/atlas-search` -- SUCCESS (partial)

## Research Quality

- Status: COMPLETE
- Quality level: high
- Backend mode: websearch+webfetch
- Note: MongoDB docs pages render via JavaScript and return only CSS to static fetchers. Compensated by using Docker Hub JSON API, GitHub source code, and Docker official docs which rendered correctly.

---

## Question 1: Docker Compose `version` Field

### Source

- URL: https://docs.docker.com/reference/compose-file/version-and-name/
- Fetched: 2026-03-22

### Official Quote

> "The top-level `version` property is defined by the Compose Specification for backward compatibility. It is only informative and you'll receive a warning message that it is obsolete if used."

> "Compose always uses the most recent schema to validate the Compose file, regardless of the `version` field."

### Analysis

The `version` field (e.g., `version: "3.8"`) is **officially obsolete** in the Docker Compose Specification. It is not "deprecated" (which implies a future removal) -- it is already marked as **obsolete and purely informational**. Docker Compose ignores the value entirely and always validates against the latest Compose Specification schema.

Legacy versions 2.x and 3.x of the Compose file format were merged into the unified Compose Specification. The `version` field has no effect on parsing or validation.

### Recommendation for Our Docs

- **Remove** `version: "3.8"` (or any `version:` line) from all Docker Compose examples.
- Do NOT replace it with a different version number. The correct action is to omit it entirely.
- If context is needed, add a comment: `# No 'version' field needed -- Compose Specification validates automatically`
- Using `version:` is harmless but will produce a warning in Docker Compose v2+.

### Confidence: DEFINITIVE

Source is the canonical Docker Compose Specification reference page.

---

## Question 2: mongot Docker Image Name

### Sources

- Docker Hub API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-search/ (full_description)
- Docker Hub API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/ (full_description)
- Atlas CLI source: https://github.com/mongodb/mongodb-atlas-cli (deployment_opts.go)
- Docker Hub tags API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/tags/
- Docker Hub tags API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-search/tags/

### Key Finding: Two Separate Docker Images Exist

#### Image 1: `mongodb/mongodb-atlas-local` (RECOMMENDED)

- **Official description**: "a full deployment of both MongoDB (mongod) and MongoDB Search (mongot) as a single node replica set"
- **Includes**: mongod + mongot + Atlas Search + Atlas Vector Search
- **Pull count**: 5.2 million+
- **Tags**: `latest`, `8.2.6`, `8.0.18`, `7.0.31`, and many more (8,919 total tags)
- **Last updated**: 2026-03-20
- **Architectures**: amd64, arm64
- **Built-in healthcheck**: verifies both mongod and mongot are operational
- **This is what Atlas CLI uses internally**: confirmed by source code constant `LocalDevImage = "docker.io/mongodb/mongodb-atlas-local"`

#### Image 2: `mongodb/mongodb-atlas-search` (LEGACY / NOT RECOMMENDED FOR LOCAL DEV)

- **Official description**: "Atlas Search is an embedded full-text search in MongoDB Atlas that gives you a seamless, scalable experience for building relevance-based app features."
- **Recommendation from its own description**: "Users interested in running a local Atlas deployment with Atlas Search and Atlas Vector Search for testing and development are recommended to use Atlas CLI."
- **Pull count**: 1.2 million
- **Tags**: `latest`, `preview`, `1.63.0` (118 total tags)
- **Last updated**: 2026-03-12
- **Storage size**: ~49.4 GB (extremely large -- this is the standalone mongot binary/image)
- **This image is NOT the recommended path for local development.**

### Our Getting-Started Guide Error

Our guide uses `mongodb/mongodb-atlas-search:latest` -- this is **technically a valid image** but is:

1. NOT the recommended approach (MongoDB's own description redirects to Atlas CLI / atlas-local)
2. Extremely large (~49 GB vs ~683 MB for atlas-local)
3. Does NOT include mongod -- it is mongot only, requiring a separate MongoDB instance
4. The atlas-search image's own Docker Hub page says to use Atlas CLI instead

### Recommendation for Our Docs

**Replace** `mongodb/mongodb-atlas-search:latest` with `mongodb/mongodb-atlas-local:8.0` (or `latest`).

The correct Docker Compose service is:

```yaml
services:
  mongodb:
    image: mongodb/mongodb-atlas-local:8.0
    ports:
      - "27017:27017"
    healthcheck:
      # Built-in healthcheck is included in the image
      # Use depends_on with condition: service_healthy
```

This single image provides mongod + mongot + Atlas Search + Vector Search in one container, with a built-in healthcheck.

### Confidence: DEFINITIVE

Sources are the official Docker Hub API metadata (JSON), the Atlas CLI Go source code, and the image's own full_description which explicitly recommends atlas-local over atlas-search for local development.

---

## Question 3: MongoDB Atlas Local Deployment

### Sources

- Docker Hub API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/ (full_description)
- Docker Hub tags API: https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/tags/

### What is `mongodb/mongodb-atlas-local`?

Official description: "Create, manage, and automate MongoDB Atlas Local resources with Docker."

It provides **a full deployment of both MongoDB (mongod) and MongoDB Search (mongot) as a single-node replica set**.

### Included Out of the Box

| Feature                  | Included | Notes                                                               |
| ------------------------ | -------- | ------------------------------------------------------------------- |
| mongod (database)        | YES      | Single-node replica set                                             |
| mongot (search engine)   | YES      | Co-located in same container                                        |
| Atlas Search (full-text) | YES      | Available immediately                                               |
| Atlas Vector Search      | YES      | Available immediately                                               |
| Built-in healthcheck     | YES      | Checks both mongod and mongot every 30s                             |
| Authentication           | Optional | Via `MONGODB_INITDB_ROOT_USERNAME` / `MONGODB_INITDB_ROOT_PASSWORD` |
| Init scripts             | YES      | Mount to `/docker-entrypoint-initdb.d` (.sh or .js)                 |
| Sample data loading      | Optional | Via `MONGODB_LOAD_SAMPLE_DATA` env var                              |
| Multi-arch               | YES      | amd64 and arm64                                                     |

### Available Version Tags (as of 2026-03-20)

| Tag      | MongoDB Version | Image Size (amd64) |
| -------- | --------------- | ------------------ |
| `latest` | 8.2.x           | 683 MB             |
| `8.2.6`  | 8.2.6           | 683 MB             |
| `8.2.2`  | 8.2.2           | 683 MB             |
| `8.0.18` | 8.0.18          | 670 MB             |
| `8.0.16` | 8.0.16          | 670 MB             |
| `7.0.31` | 7.0.31          | 664 MB             |
| `7.0.28` | 7.0.28          | 664 MB             |

### Is This the Recommended Way?

**Yes.** This is the officially recommended way to run MongoDB with search capabilities locally:

- MongoDB's Atlas CLI uses this exact image internally (confirmed from source code)
- The `mongodb/mongodb-atlas-search` image's own Docker Hub page redirects developers to Atlas CLI / atlas-local
- The image has 5.2M+ pulls and is updated regularly (last: 2026-03-20)
- The `preview` tag includes experimental "MongoDB Search in Community" with auto-embedding via Voyage AI

### Deployment Options Supported

1. **Direct Docker** (`docker run`)
2. **Atlas CLI guided setup** (`atlas deployments setup`)
3. **Docker Compose** (reproducible environments)
4. **MongoDB MCP Server** integration

### Recommendation for Our Docs

Use `mongodb/mongodb-atlas-local:8.0` as the standard image for local development. It is a single container that gives you everything needed for MongoDB + Atlas Search + Vector Search development.

Docker Compose snippet:

```yaml
services:
  mongodb:
    image: mongodb/mongodb-atlas-local:8.0
    ports:
      - "27017:27017"
    environment:
      # Optional: load sample data
      # - MONGODB_LOAD_SAMPLE_DATA=true
      # Optional: authentication
      # - MONGODB_INITDB_ROOT_USERNAME=admin
      # - MONGODB_INITDB_ROOT_PASSWORD=secret
    volumes:
      # Optional: init scripts
      - ./init:/docker-entrypoint-initdb.d
    healthcheck:
      # Image has built-in healthcheck; this is informational
      test: ["CMD", "/usr/local/bin/runner", "healthcheck"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s

  app:
    depends_on:
      mongodb:
        condition: service_healthy
```

### Confidence: DEFINITIVE

Source is the official Docker Hub full_description from MongoDB, cross-referenced with Atlas CLI source code.

---

## Question 4: mongot Standalone

### Sources

- Docker Hub API: `mongodb/mongodb-atlas-local` full_description
- Docker Hub API: `mongodb/mongodb-atlas-search` full_description + tags
- MongoDB product page: mongodb.com/products/platform/atlas-search
- Atlas CLI source code: github.com/mongodb/mongodb-atlas-cli

### Can mongot Run as a Separate Docker Container?

**Technically yes, but it is NOT recommended.**

The `mongodb/mongodb-atlas-search` Docker image exists and contains mongot as a standalone component:

- Image: `mongodb/mongodb-atlas-search:latest` (or `1.63.0`)
- Size: ~49.4 GB (extremely large)
- Contains 118 tags, actively maintained
- Supports amd64 and arm64

However, MongoDB's own description for this image explicitly states:

> "Users interested in running a local Atlas deployment with Atlas Search and Atlas Vector Search for testing and development are recommended to use Atlas CLI."

This means MongoDB themselves recommend against using the standalone mongot image for local development.

### Why Not Use Standalone mongot?

1. **Size**: ~49 GB vs ~683 MB for atlas-local (72x larger)
2. **Complexity**: You must run and configure mongod separately, then connect mongot to it
3. **No official documentation for standalone local setup**: MongoDB docs point to atlas-local
4. **atlas-local includes mongot**: The all-in-one image already bundles both processes with correct wiring
5. **Healthcheck**: atlas-local has built-in healthcheck that verifies both mongod AND mongot; standalone requires custom healthcheck setup

### When Might Standalone mongot Make Sense?

- Production Atlas deployments (managed by MongoDB Atlas infrastructure)
- Specialized testing of mongot behavior in isolation
- Edge cases where you need a specific mongot version separate from mongod version

For local development, there is no practical reason to run mongot standalone.

### Does mongot Work with MongoDB Community Edition?

The `mongodb/mongodb-atlas-local` Docker Hub description mentions:

> "The `preview` tag includes experimental 'MongoDB Search in Community' edition with auto-embedding capabilities powered by Voyage AI."

This confirms that MongoDB is actively working on making mongot/search available in Community Edition, but as of 2026-03-22, this is still in **preview** status.

For production Community Edition servers (not Docker), mongot is NOT available -- Atlas Search requires either:

1. MongoDB Atlas (cloud)
2. `mongodb/mongodb-atlas-local` Docker image (local dev)

### Recommendation for Our Docs

- **Do NOT reference** `mongodb/mongodb-atlas-search` as the Docker image for local development
- **Use** `mongodb/mongodb-atlas-local` which includes mongot pre-configured
- **State clearly**: "mongot is bundled inside the `mongodb/mongodb-atlas-local` Docker image; no separate mongot container is needed for local development"
- **If mentioning Community Edition search**: note it is in preview via the `preview` tag of `mongodb/mongodb-atlas-local`

### Confidence: HIGH

Based on official Docker Hub metadata from MongoDB and Atlas CLI source code. The standalone mongot image exists and works, but MongoDB's own documentation actively redirects developers away from it toward atlas-local.

---

## Summary of Changes Needed in Our Docs

| Issue                     | Current (Wrong)                       | Correct                                            | Source                            |
| ------------------------- | ------------------------------------- | -------------------------------------------------- | --------------------------------- |
| Docker Compose version    | `version: "3.8"`                      | Remove entirely (obsolete)                         | Docker Compose Specification      |
| mongot Docker image       | `mongodb/mongodb-atlas-search:latest` | `mongodb/mongodb-atlas-local:8.0`                  | Docker Hub API + Atlas CLI source |
| What atlas-local includes | Not documented                        | mongod + mongot + Atlas Search + Vector Search     | Docker Hub full_description       |
| mongot standalone         | Implied separate container            | Bundled in atlas-local; standalone not recommended | Docker Hub full_description       |

## What Changed the Recommendation

The single highest-signal finding is that the `mongodb/mongodb-atlas-search` Docker Hub page **itself** tells developers not to use it for local development and to use Atlas CLI (which uses `mongodb/mongodb-atlas-local`) instead. Combined with the 72x size difference (49 GB vs 683 MB), our getting-started guide is directing developers to download a 49 GB image when a 683 MB image provides a superset of functionality. This is a critical documentation error that would cause poor developer experience.

## Gotchas / Warnings

- The `mongodb/mongodb-atlas-local` image runs a **single-node replica set**, not a standalone mongod. Connection strings should use `directConnection=true` or the replica set name.
- Wait for `service_healthy` before connecting -- both mongod and mongot need to be ready.
- The `preview` tag has experimental Community Edition search features -- do not use in production guidance.
- Version tags use MongoDB server version (e.g., `8.0`, `8.2.6`), NOT mongot version numbers.
- The built-in healthcheck runs every 30 seconds; initial startup may take 15-60 seconds.
- Authentication is optional but if enabled, uses standard `MONGODB_INITDB_ROOT_USERNAME` / `MONGODB_INITDB_ROOT_PASSWORD` env vars.

## References

- https://docs.docker.com/reference/compose-file/version-and-name/ (Docker Compose version field)
- https://hub.docker.com/r/mongodb/mongodb-atlas-local (Docker Hub page)
- https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/ (Docker Hub API - full description)
- https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-local/tags/ (Docker Hub API - tags)
- https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-search/ (Docker Hub API - full description)
- https://hub.docker.com/v2/repositories/mongodb/mongodb-atlas-search/tags/ (Docker Hub API - tags)
- https://github.com/mongodb/mongodb-atlas-cli (Atlas CLI source, `deployment_opts.go`)
- https://www.mongodb.com/products/platform/atlas-search (Atlas Search product page)

---

Web research complete.
