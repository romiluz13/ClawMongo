# Docker + Doctor + Onboarding Implementation Plan (v2 -- atlas-local Migration)

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Research:** See `docs/research/2026-03-22-doc-validation-web.md` and `docs/research/2026-03-22-mongodb-image-verification.md` for verified Docker image details.

**Goal:** Make ClawMongo tryable in 5 minutes (Docker), self-diagnosing (Doctor), and guided-first-run (Onboarding). ALSO: completely deprecate all references to separate mongod + mongot services in favor of the unified `mongodb/mongodb-atlas-local:preview` Docker image everywhere.

**Architecture:** Five phases that build on each other: (1) a simplified Docker Compose setup using `mongodb/mongodb-atlas-local:preview` as a single container, (1.5) a full legacy migration pass across 11 files to make atlas-local the primary recommended path, (2) new Doctor checks with atlas-local-aware upgrade guidance, (3) an onboarding wizard with fixed Atlas URI messaging and atlas-local language, (4) full validation.

**Tech Stack:** Docker Compose, TypeScript ESM, Vitest, @clack/prompts (existing wizard framework)

**Prerequisites:** Existing Docker setup at `docker/mongodb/`, existing Doctor at `src/commands/doctor-memory-search.ts`, existing onboarding at `src/wizard/`

**Key decision (from reviewer audit):** `MemoryMongoDBDeploymentProfile = "community-mongot"` stays AS IS -- it describes the capability tier, not the deployment topology. The existing multi-container Docker setup is PRESERVED as an "Advanced" fallback, NOT deleted. No config/test renaming needed.

---

## Relevant Codebase Files

### Patterns to Follow

- `src/commands/doctor-memory-search.ts` -- Doctor diagnostic pattern (note() calls, backend health check, structured Fix hints)
- `src/commands/doctor-memory-search.test.ts` -- Doctor test pattern (vi.mock, note mock, beforeEach reset)
- `src/wizard/onboarding-memory.ts` -- Onboarding memory setup pattern (prompter, topology detection, config merge)
- `src/wizard/mongodb-auto-setup.ts` -- Auto-setup pattern (Docker detection, tier fallback, progress spinner)
- `src/docker/mongodb-docker.ts` -- Docker utility pattern (execDocker, port check, container state)
- `src/memory/mongodb-topology.ts` -- Topology detection pattern (detectTopology, topologyToTier, tierFeatures)
- `docker/mongodb/docker-compose.mongodb.yml` -- Existing 3-container Docker Compose setup
- `docker/mongodb/start.sh` -- Existing shell startup script
- `src/memory/backend-config.ts` -- ResolvedMongoDBConfig type (lines 26-79)
- `src/config/types.memory.ts` -- MemoryMongoDBConfig type (lines 14-80)

### Configuration Files

- `docker/mongodb/.runtime/` -- Generated runtime configs (gitignored)
- `docker/mongodb/mongot.conf` -- mongot config template
- `docker/mongodb/mongod.conf` -- mongod config

---

## Phase 1: Docker Compose Full-Stack (Single Container)

> **Exit Criteria:** `docker compose -f docker/mongodb/docker-compose.preview.yml up -d` starts a working MongoDB with mongot + auto-embeddings in one container. Existing multi-container setup preserved as `docker-compose.mongodb.yml`. Container detection includes `clawmongo-preview`.

### Task 1.1: Create the Preview Docker Compose File

**Files:**

- Create: `docker/mongodb/docker-compose.preview.yml`

**Step 1: Write the Docker Compose file**

The preview compose file uses `mongodb/mongodb-atlas-local:preview` which bundles mongod + community mongot + Atlas Search + Vector Search in a single container (~584 MB). Key facts from research:

- This is the ONLY tag with auto-embeddings (Voyage AI)
- Starts as a single-node replica set automatically (no rs.initiate() needed)
- Built-in healthcheck verifies both mongod and mongot
- `VOYAGE_API_KEY` env var enables auto-embeddings
- The MongoDB MCP Server itself defaults to `preview` tag

```yaml
# docker-compose.preview.yml - ClawMongo one-command setup
# Uses mongodb/mongodb-atlas-local:preview (the ONLY tag with auto-embeddings)
#
# Usage:
#   docker compose -f docker/mongodb/docker-compose.preview.yml up -d
#   VOYAGE_API_KEY=your-key docker compose -f docker/mongodb/docker-compose.preview.yml up -d
#
# What's included (single container):
#   - mongod (MongoDB 8.x, single-node replica set)
#   - mongot (community search engine)
#   - Atlas Search + Atlas Vector Search
#   - Auto-embeddings via Voyage AI (when VOYAGE_API_KEY is set)

services:
  mongodb:
    image: mongodb/mongodb-atlas-local:preview
    container_name: clawmongo-preview
    ports:
      - "${MONGODB_PORT:-27017}:27017"
    environment:
      - VOYAGE_API_KEY=${VOYAGE_API_KEY:-}
    volumes:
      - clawmongo_preview_data:/data/db
    # Built-in healthcheck verifies both mongod and mongot are operational
    healthcheck:
      test: ["CMD", "/usr/local/bin/runner", "healthcheck"]
      interval: 10s
      timeout: 10s
      retries: 10
      start_period: 30s

volumes:
  clawmongo_preview_data:
```

No `version:` field (obsolete per Docker Compose Specification -- confirmed in research).
No auth configuration needed -- preview image handles it internally.
No network configuration needed -- single container.
No setup-generator needed -- preview image is self-contained.

**Step 2: Verify the compose file is valid YAML**

Run: `docker compose -f docker/mongodb/docker-compose.preview.yml config --quiet`
Expected: exit 0, no errors

### Task 1.2: Create Preview Start Script

**Files:**

- Create: `docker/mongodb/start-preview.sh`

**Step 1: Write the start script**

```bash
#!/bin/bash
# ClawMongo Preview Quick Start
# One command to start MongoDB with mongot + auto-embeddings
#
# Usage:
#   ./docker/mongodb/start-preview.sh              # Start (no auto-embed)
#   VOYAGE_API_KEY=key ./docker/mongodb/start-preview.sh  # Start with auto-embed
#   ./docker/mongodb/start-preview.sh stop          # Stop
#   ./docker/mongodb/start-preview.sh clean         # Stop + delete data

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.preview.yml"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

case "${1:-start}" in
  start|up)
    echo -e "${GREEN}Starting ClawMongo (mongodb-atlas-local:preview)...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d

    echo ""
    echo "Waiting for healthcheck..."
    # Wait for container to be healthy (up to 90s)
    TIMEOUT=90
    ELAPSED=0
    while [ $ELAPSED -lt $TIMEOUT ]; do
      STATUS=$(docker inspect --format='{{.State.Health.Status}}' clawmongo-preview 2>/dev/null || echo "missing")
      if [ "$STATUS" = "healthy" ]; then
        break
      fi
      sleep 3
      ELAPSED=$((ELAPSED + 3))
      echo "  Status: $STATUS ($ELAPSED/${TIMEOUT}s)"
    done

    if [ "$STATUS" = "healthy" ]; then
      echo ""
      echo -e "${GREEN}ClawMongo MongoDB is ready.${NC}"
      echo ""
      echo "Connection string: mongodb://localhost:${MONGODB_PORT:-27017}/?directConnection=true"
      echo ""
      echo "Features:"
      echo "  + mongod + mongot (single container)"
      echo "  + Atlas Search + Vector Search"
      echo "  + ACID transactions (replica set)"
      echo "  + Change streams"
      if [ -n "${VOYAGE_API_KEY:-}" ]; then
        echo -e "  + ${GREEN}Auto-embeddings enabled (Voyage AI)${NC}"
      else
        echo -e "  - ${YELLOW}Auto-embeddings disabled (set VOYAGE_API_KEY to enable)${NC}"
      fi
      echo ""
      echo "Next: clawmongo setup"
    else
      echo -e "${RED}Container did not become healthy within ${TIMEOUT}s.${NC}"
      echo "Check: docker logs clawmongo-preview"
      exit 1
    fi
    ;;

  stop|down)
    echo "Stopping ClawMongo..."
    docker compose -f "$COMPOSE_FILE" down
    echo -e "${GREEN}Stopped.${NC}"
    ;;

  clean)
    echo -e "${RED}Stopping and removing ALL data...${NC}"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      docker compose -f "$COMPOSE_FILE" down -v
      echo -e "${GREEN}All data removed.${NC}"
    else
      echo "Aborted."
    fi
    ;;

  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;

  logs)
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;

  *)
    echo "Usage: $0 {start|stop|clean|status|logs}"
    exit 1
    ;;
esac
```

**Step 2: Make executable**

Run: `chmod +x docker/mongodb/start-preview.sh`

### Task 1.3: Add Preview Container Detection to `mongodb-docker.ts`

**Files:**

- Modify: `src/docker/mongodb-docker.ts`

**Context:** The `detectExistingMongoDB` function (line 103) checks for `clawmongo-mongod` and `clawmongo-mongod-standalone` containers. The `TIER_CONTAINERS` map (line 290) lists containers per tier. The `getRunningClawMongoContainers` function (line 384) detects running containers. None of these know about `clawmongo-preview`.

**Changes required:**

1. **Add `getPreviewComposeFilePath()` function** -- resolves `docker/mongodb/docker-compose.preview.yml` using the same `resolveOpenClawPackageRootSync` pattern as `getComposeFilePath()`. Do NOT change `getComposeFilePath()` itself (that would cascade into all existing callers).

   ```typescript
   export function getPreviewComposeFilePath(): string {
     const packageRoot = resolveOpenClawPackageRootSync({
       moduleUrl: import.meta.url,
       argv1: process.argv[1],
       cwd: process.cwd(),
     });
     if (packageRoot) {
       return path.join(packageRoot, "docker", "mongodb", "docker-compose.preview.yml");
     }
     return path.resolve(__dirname, "..", "..", "docker", "mongodb", "docker-compose.preview.yml");
   }
   ```

2. **Add `clawmongo-preview` to `detectExistingMongoDB`** -- after checking `clawmongo-mongod-standalone`, also check for `clawmongo-preview` container:

   ```typescript
   // After the existing clawmongo-mongod-standalone check (line ~123-130):
   if (!isDocker) {
     try {
       const state = await dockerContainerState("clawmongo-preview");
       isDocker = state.running;
     } catch {
       // Not a Docker container
     }
   }
   ```

3. **Add preview URI to candidate list** -- in `existingMongoCandidateUris` (line 87), add a no-auth `directConnection=true` URI for the preview container BEFORE the auth URIs:

   ```typescript
   function existingMongoCandidateUris(port: number): string[] {
     return [
       // Preview image (mongodb-atlas-local:preview) -- no auth, directConnection
       `mongodb://localhost:${port}/openclaw?directConnection=true`,
       // Standalone/default local install (no auth).
       `mongodb://localhost:${port}/openclaw`,
       // ClawMongo Docker replica set/fullstack defaults.
       `mongodb://admin:admin@localhost:${port}/openclaw?authSource=admin&replicaSet=rs0&directConnection=true`,
       // Fallback for auth-enabled deployments without replicaSet in URI.
       `mongodb://admin:admin@localhost:${port}/?authSource=admin&directConnection=true`,
     ];
   }
   ```

4. **Add `"preview"` to `ComposeTier` union** and update `TIER_CONTAINERS`/`TIER_URIS`:

   ```typescript
   export type ComposeTier = "preview" | "standalone" | "replicaset" | "fullstack";

   const TIER_CONTAINERS: Record<ComposeTier, string[]> = {
     preview: ["clawmongo-preview"],
     fullstack: ["clawmongo-mongod", "clawmongo-mongot"],
     replicaset: ["clawmongo-mongod"],
     standalone: ["clawmongo-mongod-standalone"],
   };

   const TIER_URIS: Record<ComposeTier, string> = {
     preview: "mongodb://localhost:27017/openclaw?directConnection=true",
     fullstack:
       "mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true",
     replicaset:
       "mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true",
     standalone: "mongodb://localhost:27017/openclaw",
   };
   ```

5. **Add preview to `getRunningClawMongoContainers`** -- check for `clawmongo-preview` FIRST (before fullstack), since preview is the recommended path:

   ```typescript
   // At the top of getRunningClawMongoContainers, BEFORE the fullstack check:
   try {
     const previewState = await dockerContainerState("clawmongo-preview");
     if (previewState.running) {
       return {
         running: true,
         tier: "preview" as ComposeTier,
         containers: ["clawmongo-preview"],
       };
     }
   } catch {
     // Docker not available or container not found
   }
   ```

6. **Update `autoStartMongoDB`** to try preview first -- add `"preview"` to the beginning of `FALLBACK_ORDER`, and handle preview tier specially (uses `getPreviewComposeFilePath()` instead of the passed `composeFile`, no setup-generator needed):

   Note: `autoStartMongoDB` currently takes a `composeFile` parameter and calls `startMongoDBCompose`. For preview, we need to use the preview compose file. The cleanest approach is to add an optional `previewComposeFile` parameter, or handle the preview case inline before the fallback loop. Implementation details left to the builder, but the key behavior is:
   - Try preview first (use `getPreviewComposeFilePath()`, `docker compose up -d`, wait for `clawmongo-preview` healthy)
   - If preview fails (file missing, Docker pull fails, unhealthy), fall through to existing `FALLBACK_ORDER`

### Task 1.4: Write Tests for Preview Docker Integration

**Files:**

- Modify: `src/docker/mongodb-docker.test.ts`

Add tests:

- `getPreviewComposeFilePath()` returns a path ending with `docker-compose.preview.yml`
- `detectExistingMongoDB` checks `clawmongo-preview` container state
- `getRunningClawMongoContainers` detects preview container and returns `tier: "preview"`
- `TIER_CONTAINERS` includes `preview` key with `["clawmongo-preview"]`
- Preview URI in `TIER_URIS` uses `directConnection=true` without auth

Follow existing test patterns in `mongodb-docker.test.ts` (vi.mock of exec functions).

**Step: Run tests**

Run: `pnpm test -- src/docker/mongodb-docker.test.ts`
Expected: all tests pass

### Task 1.5: Commit Phase 1

```bash
scripts/committer "Docker: add preview one-command setup with mongodb-atlas-local:preview" \
  docker/mongodb/docker-compose.preview.yml \
  docker/mongodb/start-preview.sh \
  src/docker/mongodb-docker.ts \
  src/docker/mongodb-docker.test.ts
```

---

## Phase 1.5: Legacy atlas-local Migration (11 Files)

> **Exit Criteria:** All 11 files present `mongodb-atlas-local:preview` as the primary recommended path. Separate mongod + mongot references are either removed or moved to "Advanced" sections. No config/type renames.

This phase updates documentation (6 files) and source code (5 files) to completely deprecate the separate mongod + mongot model in favor of the unified `mongodb-atlas-local:preview` Docker image.

### Task 1.5.1: Update `docs/start/clawmongo-getting-started.md`

**Files:**

- Modify: `docs/start/clawmongo-getting-started.md`

**Current state:** Option A (Docker) already describes `mongodb-atlas-local:preview` correctly. Option B (Local Install) at line 52 says "Install and configure mongot separately" and links to separate MongoDB Community + mongot instructions. Option C describes Atlas cloud.

**Changes:**

1. **Remove Option B (Local Install with separate mongot)** -- replace with:

   ````markdown
   #### Option B: Atlas CLI Local Deployment

   Use the MongoDB Atlas CLI to create a local deployment (bundles mongod + mongot):

   ```bash
   # Install Atlas CLI
   brew install mongodb-atlas-cli  # macOS
   # or see https://www.mongodb.com/docs/atlas/cli/stable/install-atlas-cli/

   # Create a local deployment with search support
   atlas deployments setup clawmongo --type local --port 27017
   ```
   ````

   This creates a local deployment with mongod + mongot bundled together -- no separate mongot install needed.

   ```

   ```

2. **Remove Option C (MongoDB Atlas)** entirely -- ClawMongo targets `mongodb-atlas-local` Docker, not Atlas SaaS. The onboarding wizard rejects `.mongodb.net` URIs. Keeping this option creates confusion.

3. **Update Prerequisites section** (line 12) -- change "MongoDB 7.0+ with mongot (MongoDB Community Search)" to:

   ```
   - **MongoDB** via `mongodb-atlas-local:preview` Docker image (recommended) or Atlas CLI local deployment
   ```

4. **Update Troubleshooting "mongot not available" section** (line 257) -- change instructions to reference `start-preview.sh`:

   ````
   ### mongot not available

   If search index creation fails, ensure you are running the `mongodb-atlas-local:preview` Docker image
   which bundles mongot. Run:

   ```bash
   ./docker/mongodb/start-preview.sh
   ````

   ```

   ```

### Task 1.5.2: Update `docs/concepts/memory.md`

**Files:**

- Modify: `docs/concepts/memory.md`

**Current state:** The "MongoDB deployment model" section (line 99) says "ClawMongo is community-first" and describes `community-mongot` with separate mongot references.

**Changes:**

1. **Update "MongoDB deployment model" section** (line 99-139) -- rewrite the intro paragraph and setup reference:

   Before:

   ```
   ClawMongo is community-first.

   ### Official ClawMongo target

   Use `community-mongot` with automatic embeddings:
   ```

   After:

   ```
   ClawMongo targets `mongodb-atlas-local:preview` -- a single Docker image that bundles
   mongod, mongot (community search engine), Atlas Search, Atlas Vector Search, and
   Voyage AI auto-embeddings in one container.

   ### Official ClawMongo target

   Use the `community-mongot` deployment profile with automatic embeddings:
   ```

2. **Update the "Embeddings" subsection** (line 131-139) -- change "mongot delegates" language to reference the atlas-local container:

   Before:

   ```
   In this mode, `mongot` delegates embedding generation to the Voyage AI API
   using the API keys you configure during `mongot` initialization. ClawMongo
   does not require application-side embedding code -- `mongot` handles embedding
   at index time and query time -- but you do need Voyage AI API keys configured
   in your `mongot` deployment.
   ```

   After:

   ```
   In this mode, the bundled mongot inside the `mongodb-atlas-local:preview` container
   delegates embedding generation to the Voyage AI API. Set `VOYAGE_API_KEY` as an
   environment variable when starting the container. ClawMongo does not require
   application-side embedding code -- mongot handles embedding at index time and
   query time automatically.
   ```

### Task 1.5.3: Update `docs/reference/memory-config.md`

**Files:**

- Modify: `docs/reference/memory-config.md`

**Current state:** Prerequisites section (line 52-56) says "For vector search: mongot (Atlas Search) running alongside mongod."

**Changes:**

1. **Update Prerequisites** (lines 52-56):

   Before:

   ```
   - A MongoDB 7+ instance (Community or Atlas). Replica set required for transactions and change streams.
   - For vector search: mongot (Atlas Search) running alongside mongod.
   - For automated embeddings: Voyage AI API key (`VOYAGE_API_KEY`).
   - See `docker/mongodb/` for the Docker Compose setup with all three tiers (standalone, replicaset, fullstack).
   ```

   After:

   ```
   - **Recommended:** The `mongodb-atlas-local:preview` Docker image (bundles mongod + mongot + Atlas Search + Vector Search in one container). Start with `./docker/mongodb/start-preview.sh`.
   - For automated embeddings: Voyage AI API key (`VOYAGE_API_KEY`) passed as a container environment variable.
   - Alternative: A standalone MongoDB 7+ instance, but vector search and auto-embeddings require mongot which is bundled in the atlas-local image.
   - See `docker/mongodb/` for Docker setup options (preview recommended, multi-container for advanced use).
   ```

### Task 1.5.4: Update `README.md` Quick Start

**Files:**

- Modify: `README.md`

**Current state:** Line 150 says "MongoDB 7.0+ with mongot" in the Quick Start prerequisites.

**Changes:**

1. **Update Quick Start prerequisites** (line 150):

   Before:

   ```
   **Prerequisites:** Node.js 22+ (24 recommended), MongoDB 7.0+ with mongot, Voyage AI API key, an LLM API key (Anthropic Claude recommended).
   ```

   After:

   ```
   **Prerequisites:** Node.js 22+ (24 recommended), Docker (for `mongodb-atlas-local:preview`), Voyage AI API key, an LLM API key (Anthropic Claude recommended).
   ```

2. **Add one-line Docker start before `clawmongo onboard`** (after line 153):

   ```bash
   # Start MongoDB (atlas-local:preview -- bundles mongod + mongot + search)
   ./docker/mongodb/start-preview.sh

   npm install -g @romiluz/clawmongo@latest
   clawmongo onboard --install-daemon
   ```

### Task 1.5.5: Update `docker/mongodb/README.md`

**Files:**

- Modify: `docker/mongodb/README.md`

**Current state:** The entire document describes the 3-container setup (standalone, replicaset, fullstack) with no mention of the preview single-container approach.

**Changes:**

1. **Add "Recommended: Preview (Single Container)" section** at the top, BEFORE the existing "Three Deployment Tiers" section. Content:

   ````markdown
   ## Recommended: Preview (Single Container)

   The fastest way to run ClawMongo's full MongoDB stack:

   ```bash
   # Start (bundles mongod + mongot + Atlas Search + Vector Search)
   ./docker/mongodb/start-preview.sh

   # With auto-embeddings
   VOYAGE_API_KEY=your-key ./docker/mongodb/start-preview.sh

   # Stop
   ./docker/mongodb/start-preview.sh stop
   ```
   ````

   This uses `mongodb/mongodb-atlas-local:preview` (~584 MB) -- a single container with everything ClawMongo needs:
   - mongod (MongoDB 8.x, single-node replica set)
   - mongot (community search engine)
   - Atlas Search + Atlas Vector Search
   - Auto-embeddings via Voyage AI (when `VOYAGE_API_KEY` is set)

   **Connection string:** `mongodb://localhost:27017/?directConnection=true` (no auth needed)

   **Docker Compose file:** `docker/mongodb/docker-compose.preview.yml`

   For most users, this is all you need. The multi-container setup below is for advanced use cases only.

   ***

   ```

   ```

2. **Rename the existing "Three Deployment Tiers" heading** to "Advanced: Multi-Container Setup" and add a note:

   ```markdown
   ## Advanced: Multi-Container Setup

   > **Note:** Most users should use the [Preview single container](#recommended-preview-single-container) above.
   > The multi-container setup is for users who need separate mongod/mongot control, custom auth, or specific MongoDB versions.
   ```

   Rest of the multi-container content stays as-is.

### Task 1.5.6: Update `docs/design/clawmongo-onboarding-flow.md`

**Files:**

- Modify: `docs/design/clawmongo-onboarding-flow.md`

**Current state:** References separate "mongot verification" as a distinct step. Describes mongot as a separate service.

**Changes:**

1. **Update Step 2 heading** from "mongot Verification" to "Search Engine Verification":
   - Change "Verify that MongoDB Search (mongot) is available" to "Verify that the atlas-local container's bundled mongot is operational"
   - Change "mongot not running: provide platform-specific startup instructions" to "mongot not available: suggest starting with `./docker/mongodb/start-preview.sh` (atlas-local:preview bundles mongot)"

2. **Update Step 3** -- change "configure in the mongot config" references to "set `VOYAGE_API_KEY` when starting the atlas-local container"

3. **Update Implementation Notes** -- change any references to "Install and configure mongot separately" to atlas-local container approach

### Task 1.5.7: Update `src/docker/mongodb-docker.ts` (already covered in Phase 1)

Already fully covered in Phase 1, Task 1.3. No additional changes needed here.

### Task 1.5.8: Update `src/wizard/onboarding-memory.ts`

**Files:**

- Modify: `src/wizard/onboarding-memory.ts`

**Current state:**

- Line 88-89: Atlas URI validation says `"ClawMongo supports MongoDB Community + mongot only. Atlas URIs are not supported."` -- this is misleading because we recommend `mongodb-atlas-local` Docker image (which has "atlas" in the name)
- Line 153: Missing features upgrade hint says `"Upgrade: ./docker/mongodb/start.sh fullstack"` -- should reference `start-preview.sh`
- Line 155: Missing features text says `"Community + mongot full stack"` -- should reference atlas-local

**Changes:**

1. **Fix Atlas URI validation message** (line 88-89) -- change:

   Before:

   ```typescript
   if (trimmed.includes(".mongodb.net")) {
     return "ClawMongo supports MongoDB Community + mongot only. Atlas URIs are not supported.";
   }
   ```

   After:

   ```typescript
   if (trimmed.includes(".mongodb.net")) {
     return "ClawMongo targets local MongoDB (mongodb-atlas-local:preview Docker image). Atlas SaaS URIs (.mongodb.net) are not supported. Use a local connection string instead.";
   }
   ```

2. **Update upgrade guidance in `continueMongoDBSetup`** (line 155) -- change:

   Before: `"Upgrade: ./docker/mongodb/start.sh fullstack"`
   After: `"Upgrade: ./docker/mongodb/start-preview.sh"`

3. **Update missing features text** (line 152-154) -- change:

   Before:

   ```typescript
   if (detectedTier !== "fullstack") {
     lines.push("  - Community + mongot full stack");
   }
   ```

   After:

   ```typescript
   if (detectedTier !== "fullstack") {
     lines.push("  - Full search stack (use mongodb-atlas-local:preview Docker image)");
   }
   ```

### Task 1.5.9: Update `src/commands/doctor-memory-search.ts`

**Files:**

- Modify: `src/commands/doctor-memory-search.ts`

**Current state:** Line 91 says `"Upgrade: ./docker/mongodb/start.sh fullstack"` when features are missing.

**Changes:**

1. **Update upgrade guidance** (line 91) -- change:

   Before: `"Upgrade: ./docker/mongodb/start.sh fullstack"`
   After: `"Upgrade: ./docker/mongodb/start-preview.sh (mongodb-atlas-local:preview)"`

### Task 1.5.10: Update `src/commands/configure-memory.ts`

**Files:**

- Modify: `src/commands/configure-memory.ts`

**Current state:**

- Line 99-100: Same Atlas URI rejection message as `onboarding-memory.ts`
- Line 166: Same upgrade guidance `"Upgrade: ./docker/mongodb/start.sh fullstack"`
- Line 163-164: Same "Community + mongot full stack" text

**Changes:**

1. **Fix Atlas URI validation message** (line 99-100) -- same fix as onboarding-memory.ts:

   Before: `"ClawMongo supports MongoDB Community + mongot only. Atlas URIs are not supported."`
   After: `"ClawMongo targets local MongoDB (mongodb-atlas-local:preview Docker image). Atlas SaaS URIs (.mongodb.net) are not supported. Use a local connection string instead."`

2. **Update upgrade guidance** (line 166):

   Before: `"Upgrade: ./docker/mongodb/start.sh fullstack"`
   After: `"Upgrade: ./docker/mongodb/start-preview.sh (mongodb-atlas-local:preview)"`

3. **Update missing features text** (lines 163-164):

   Before: `"  - Community + mongot full stack"`
   After: `"  - Full search stack (use mongodb-atlas-local:preview Docker image)"`

### Task 1.5.11: Update `src/wizard/mongodb-auto-setup.ts`

**Files:**

- Modify: `src/wizard/mongodb-auto-setup.ts`

**Current state:**

- `TIER_LABELS` (line 35) describes tiers but has no `preview` entry
- `attemptAutoSetup` (line 57) calls `getComposeFilePath()` which returns the multi-container compose file -- does NOT try preview first

**Changes:**

1. **Add `preview` to `TIER_LABELS`** (line 35):

   ```typescript
   const TIER_LABELS: Record<ComposeTier, string> = {
     preview: "Preview: atlas-local single container (mongod + mongot + search + auto-embeddings)",
     fullstack: "Full stack: replica set + mongot (ACID transactions, vector search, analytics)",
     replicaset: "Replica set (ACID transactions, change streams, no vector search)",
     standalone: "Standalone with basic features (no transactions, no vector search)",
   };
   ```

2. **Update `attemptAutoSetup` to try preview first** -- after existing MongoDB detection (step 1) and Docker environment check (step 2), but BEFORE checking for running ClawMongo containers (step 3), add preview container detection:

   After step 2 (Docker environment checks pass), before step 3:

   ```typescript
   // 2.5. Check for running preview container
   try {
     const previewState = await dockerContainerState("clawmongo-preview");
     if (previewState.running) {
       await prompter.note("Found running ClawMongo preview container", "MongoDB Detected");
       const reconnect = await detectExistingMongoDB();
       if (reconnect.connected && reconnect.uri) {
         return {
           success: true,
           uri: reconnect.uri,
           tier: "preview" as ComposeTier,
           source: "docker-existing",
         };
       }
     }
   } catch {
     // Preview container not found, continue
   }
   ```

3. **Update step 5 (Auto-start)** -- try preview compose file first, fall back to multi-container:

   Replace the current step 5 block (lines 128-153) with logic that:
   - First tries `getPreviewComposeFilePath()` with `docker compose up -d`
   - If preview succeeds (container healthy), return preview URI
   - If preview fails, fall through to existing `autoStartMongoDB` with multi-container compose file

   The builder should import `getPreviewComposeFilePath` from `mongodb-docker.ts` and add it to the existing imports (line 8).

### Task 1.5.12: Write Tests for Migration Changes

**Files:**

- Create or modify test files as needed for the changed source files

For the 5 source code files changed:

1. **`src/wizard/onboarding-memory.test.ts`** -- add:
   - `it("rejects Atlas SaaS URIs with atlas-local-aware message")` -- verify the new error message mentions `mongodb-atlas-local:preview`
   - `it("shows start-preview.sh in upgrade guidance when not fullstack")` -- verify the new upgrade path

2. **`src/commands/doctor-memory-search.test.ts`** -- add:
   - `it("shows start-preview.sh in upgrade guidance")` -- verify note contains `start-preview.sh`

3. **`src/commands/configure-memory.test.ts`** (if exists, otherwise note for builder) -- add:
   - `it("rejects Atlas SaaS URIs with atlas-local-aware message")` -- same as onboarding

4. **`src/wizard/mongodb-auto-setup.test.ts`** (if exists) -- add:
   - `it("TIER_LABELS includes preview entry")` -- verify TIER_LABELS.preview exists
   - `it("attemptAutoSetup detects preview container before multi-container")` -- mock preview container state

**Step: Run tests**

Run: `pnpm test -- src/wizard/ src/commands/doctor-memory-search.test.ts src/commands/configure-memory`
Expected: all tests pass

### Task 1.5.13: Commit Phase 1.5

```bash
scripts/committer "Migration: deprecate separate mongod+mongot in favor of atlas-local:preview everywhere" \
  docs/start/clawmongo-getting-started.md \
  docs/concepts/memory.md \
  docs/reference/memory-config.md \
  README.md \
  docker/mongodb/README.md \
  docs/design/clawmongo-onboarding-flow.md \
  src/wizard/onboarding-memory.ts \
  src/commands/doctor-memory-search.ts \
  src/commands/configure-memory.ts \
  src/wizard/mongodb-auto-setup.ts \
  src/wizard/onboarding-memory.test.ts \
  src/commands/doctor-memory-search.test.ts
```

---

## Phase 2: Doctor MongoDB Checks

> **Exit Criteria:** `openclaw doctor` detects and reports: (a) mongot reachability, (b) auto-embed capability, (c) correct Docker image tag, (d) vector search index health. All new checks are additive -- existing checks unchanged. Upgrade guidance uses `start-preview.sh`.

### Task 2.1: Add mongot Health Check to Doctor

**Files:**

- Modify: `src/commands/doctor-memory-search.ts`
- Modify: `src/commands/doctor-memory-search.test.ts`

**Context:** The existing `noteMongoDBBackendHealth` function (line 17) already connects to MongoDB, detects topology via `detectTopology()`, and shows tier + features. The topology detector (in `mongodb-topology.ts`) already probes for mongot via `listSearchIndexes`. What's missing: explicit mongot health reporting in Doctor output, and checking whether auto-embed is working.

**New function: `noteMongotHealth(db: Db, prefix: string): Promise<void>`**

This function runs INSIDE the existing connection block of `noteMongoDBBackendHealth` (after topology detection succeeds, lines ~74-98). It:

1. **Checks mongot reachability** -- Already detected by `topology.hasMongot`. If false, emit a note with Fix hint pointing to `./docker/mongodb/start-preview.sh` (NOT the old `start.sh fullstack`).

2. **Checks auto-embed capability** -- Query a known collection for a document with an embedding field, or check if the `VOYAGE_API_KEY` environment variable is set. If mongot is present but VOYAGE_API_KEY is not set, emit a warning note.

3. **Checks vector search index existence** -- Use `db.collection(prefix + "chunks").listSearchIndexes().toArray()` to verify at least one vector search index exists. If mongot is present but no vector search indexes exist, emit a note suggesting `clawmongo memory init` or `ensureSearchIndexes`.

**Tests to add (in doctor-memory-search.test.ts):**

Following the existing mock pattern (vi.mock for mongodb, mongodb-topology, mongodb-analytics):

- `it("reports mongot not reachable when topology.hasMongot is false")` -- mock detectTopology to return `hasMongot: false`, verify note contains "mongot is not reachable" and Fix hint with `start-preview.sh`
- `it("reports auto-embed not configured when VOYAGE_API_KEY missing")` -- mock topology with `hasMongot: true`, verify note about VOYAGE_API_KEY
- `it("reports healthy when mongot + auto-embed are configured")` -- mock topology with `hasMongot: true`, mock process.env.VOYAGE_API_KEY, verify no warning notes beyond the standard backend health + recall diagnostic
- `it("reports missing vector search indexes")` -- mock listSearchIndexes to return empty array, verify note about indexes

**Step: Run tests**

Run: `pnpm test -- src/commands/doctor-memory-search.test.ts`
Expected: all tests pass (including new ones)

### Task 2.2: Add Docker Image Tag Check

**Files:**

- Modify: `src/commands/doctor-memory-search.ts`
- Modify: `src/commands/doctor-memory-search.test.ts`

**New function: `noteDockerImageHealth(): Promise<void>`**

This runs as an optional check in `noteMongoDBBackendHealth` (or as a separate doctor step). It:

1. Checks if Docker is available (reuse `isDockerInstalled()` from `src/docker/mongodb-docker.ts`)
2. If Docker is available, checks running containers for the MongoDB image:
   - `docker inspect --format='{{.Config.Image}}' clawmongo-preview` (or by label)
   - If the image is NOT `mongodb/mongodb-atlas-local:preview`, emit a warning:

     ```
     Docker image: mongodb/mongodb-atlas-local:latest
     Warning: Only the :preview tag supports auto-embeddings.

     Fix: docker compose -f docker/mongodb/docker-compose.preview.yml up -d
     ```

   - If the image IS `mongodb/mongodb-atlas-local:preview`, emit a success note

3. If Docker is not available or no container found, skip silently (the user may be running MongoDB natively)

**Also check for legacy multi-container setup:** If `clawmongo-mongod` and `clawmongo-mongot` are detected (legacy fullstack), emit an informational note suggesting migration to preview:

```
Detected legacy multi-container setup (clawmongo-mongod + clawmongo-mongot).
Consider migrating to the single-container preview image for simpler management:
  ./docker/mongodb/start-preview.sh
```

**Tests:**

- `it("warns when Docker image is not preview tag")` -- mock execDocker to return `:latest` image
- `it("passes when Docker image is preview tag")` -- mock execDocker to return `:preview` image
- `it("skips Docker image check when Docker not available")` -- mock isDockerInstalled to return false
- `it("suggests preview migration when legacy multi-container detected")` -- mock both clawmongo-mongod and clawmongo-mongot running

**Step: Run tests**

Run: `pnpm test -- src/commands/doctor-memory-search.test.ts`
Expected: all tests pass

### Task 2.3: Add Vector Search Index Health Check

**Files:**

- Modify: `src/commands/doctor-memory-search.ts`
- Modify: `src/commands/doctor-memory-search.test.ts`

**New function: `noteVectorSearchIndexHealth(db: Db, prefix: string): Promise<void>`**

Runs inside the existing connection block. It:

1. Lists search indexes on `prefix + "chunks"` collection
2. Checks for at least one vector search index (type: `vectorSearch`)
3. If no vector search indexes exist but mongot is available:

   ```
   Vector search indexes: none found on openclaw_chunks

   Fix: Indexes are created automatically on first gateway start.
   Manual: clawmongo memory init --indexes
   ```

4. If vector search indexes exist, report count and names

This check is distinct from the existing `noteEmbeddingCoverage` (which checks chunk embedding status, not index existence).

**Tests:**

- `it("reports no vector indexes when collection has none")` -- mock listSearchIndexes returning empty
- `it("reports vector index count when indexes exist")` -- mock listSearchIndexes returning 2 indexes
- `it("skips vector index check when mongot not detected")` -- verify no listSearchIndexes call

**Step: Run tests**

Run: `pnpm test -- src/commands/doctor-memory-search.test.ts`
Expected: all tests pass

### Task 2.4: Commit Phase 2

```bash
scripts/committer "Doctor: add mongot, auto-embed, image tag, and vector index checks" \
  src/commands/doctor-memory-search.ts \
  src/commands/doctor-memory-search.test.ts
```

---

## Phase 3: ClawMongo Onboarding Wizard

> **Exit Criteria:** `clawmongo setup` runs a MongoDB-first onboarding flow: connection (with Docker auto-start preferring preview) -> mongot verification -> Voyage AI key -> LLM provider -> channels. Atlas URI rejection message explains atlas-local. Existing OpenClaw onboarding flow preserved.

### Task 3.1: Add Voyage AI Key Setup Step

**Files:**

- Modify: `src/wizard/onboarding-memory.ts`

**Context:** The existing `continueMongoDBSetup` function (line 102) handles topology detection and config merge. After topology detection and before KB import, add a Voyage AI key setup step.

**New function: `setupVoyageApiKey(prompter: WizardPrompter, topology?: MongoTopology): Promise<string | undefined>`**

This function:

1. Checks if `VOYAGE_API_KEY` is already set in the environment
2. If set, shows a note confirming it was found and skips the prompt
3. If not set and topology shows `hasMongot: true`:

   ```
   Voyage AI provides auto-embeddings for vector search.
   Without it, you can still use keyword search ($text).

   Get a free key: https://voyageai.com
   ```

   Prompts for the key (optional -- can skip)

4. If key provided, stores it in environment guidance (suggest adding to `.env` or shell profile)
5. Returns the key (or undefined if skipped)

Insert this call in `continueMongoDBSetup` between topology detection (line ~158) and the KB import offer (line ~207).

**Also modify `continueMongoDBSetup`:**

- After getting Voyage key, if Docker auto-setup was used AND VOYAGE_API_KEY was just provided, suggest restarting the container with the key:
  ```
  To enable auto-embeddings, restart with:
  VOYAGE_API_KEY=your-key ./docker/mongodb/start-preview.sh
  ```

### Task 3.2: Add mongot Verification Step to Onboarding

**Files:**

- Modify: `src/wizard/onboarding-memory.ts`

**Context:** After topology detection in `continueMongoDBSetup`, the wizard shows available/missing features but does not specifically guide the user on how to get mongot if it's missing.

**Enhancement:** When `detectedTier !== "fullstack"` (mongot not present), add an interactive prompt:

```
MongoDB is connected but mongot (search engine) is not detected.
Without mongot, vector search and auto-embeddings are not available.

Options:
  1. Start with Docker (recommended)
     Run: ./docker/mongodb/start-preview.sh
  2. Continue without mongot
     Keyword search ($text) will be used instead
  3. I'll set up mongot separately
```

If user chooses option 1 and Docker is available, attempt auto-start with the preview compose file (reuse `attemptAutoSetup` logic from `mongodb-auto-setup.ts`, which now tries preview first per Phase 1.5).

### Task 3.3: Write Tests for Onboarding Enhancements

**Files:**

- Modify: `src/wizard/onboarding-memory.test.ts`

Following the existing test pattern in `src/wizard/onboarding-memory.test.ts`:

**Tests for Voyage AI key step:**

- `it("skips Voyage AI prompt when VOYAGE_API_KEY is set in env")` -- mock process.env, verify no Voyage prompt
- `it("prompts for Voyage AI key when not in env and mongot detected")` -- mock topology with hasMongot: true, verify prompt message
- `it("skips Voyage AI prompt when mongot not detected")` -- mock topology with hasMongot: false, verify no Voyage prompt

**Tests for mongot verification step:**

- `it("offers Docker start when mongot not detected and Docker available")` -- mock topology standalone, mock Docker installed, verify options include Docker start
- `it("continues without mongot when user chooses to skip")` -- mock topology standalone, verify config is returned without error
- `it("skips mongot verification when already fullstack")` -- mock topology fullstack, verify no mongot prompt

**Tests for Atlas URI message:**

- `it("Atlas URI rejection mentions atlas-local:preview")` -- verify new error message text

**Step: Run tests**

Run: `pnpm test -- src/wizard/onboarding-memory.test.ts`
Expected: all tests pass

### Task 3.4: Wire MongoDB Setup into the Wizard Flow

**Files:**

- Modify: `src/wizard/setup.ts`

**Context:** The current `runSetupWizard` flow (lines 77-593) runs: risk ack -> config read -> quickstart/manual choice -> workspace -> auth/LLM provider -> model picker -> gateway config -> channels -> search -> skills -> hooks -> finalize. IMPORTANT: `setupMemoryBackend` from `onboarding-memory.ts` is currently exported but NOT imported or called anywhere in `setup.ts`. The memory setup module is disconnected from the wizard flow. This task must WIRE IT IN, not merely reorder.

For ClawMongo, the memory backend (MongoDB) should come BEFORE the LLM provider because:

- Users need MongoDB running before anything else
- The Docker auto-start happens here
- Voyage AI key affects the entire setup

**Implementation:** After the workspace input (line ~432) and before auth choice (line ~448), add a ClawMongo-specific memory setup step:

```typescript
// Wire in MongoDB setup for ClawMongo (BEFORE auth/LLM provider)
const packageName = await resolveOpenClawPackageName();
if (packageName === "@romiluz/clawmongo") {
  const { setupMemoryBackend } = await import("./onboarding-memory.js");
  nextConfig = await setupMemoryBackend(nextConfig, prompter);
}
```

This uses dynamic import (lazy loading pattern matching the rest of setup.ts) and only activates for ClawMongo. The existing upstream OpenClaw flow is completely unchanged.

**Key constraint:** The import of `resolveOpenClawPackageName` already exists in `onboarding-memory.ts` (line 9). For `setup.ts`, import it via `await import("../infra/openclaw-root.js")` using the same dynamic import pattern as other setup.ts imports. Do NOT add a static import -- setup.ts uses dynamic imports for all wizard step modules.

### Task 3.5: Write Tests for MongoDB Wiring

**Files:**

- Modify: `src/wizard/setup.test.ts`

**Context:** Read `src/wizard/setup.test.ts` first to understand the existing mock structure before adding tests.

Tests:

- `it("calls setupMemoryBackend for ClawMongo before auth choice")` -- mock `resolveOpenClawPackageName` to return `"@romiluz/clawmongo"`, mock `setupMemoryBackend` to return config unchanged, verify `setupMemoryBackend` was called before `promptAuthChoiceGrouped`
- `it("skips setupMemoryBackend for upstream OpenClaw")` -- mock `resolveOpenClawPackageName` to return `"openclaw"`, verify `setupMemoryBackend` was NOT called
- `it("passes nextConfig through setupMemoryBackend and continues with returned config")` -- mock `setupMemoryBackend` to add mongodb config, verify subsequent steps receive the enriched config

**Step: Run tests**

Run: `pnpm test -- src/wizard/setup.test.ts`
Expected: all tests pass

### Task 3.6: Commit Phase 3

```bash
scripts/committer "Onboarding: MongoDB-first flow with Voyage AI key and mongot verification" \
  src/wizard/onboarding-memory.ts \
  src/wizard/mongodb-auto-setup.ts \
  src/wizard/setup.ts \
  src/wizard/onboarding-memory.test.ts \
  src/wizard/setup.test.ts
```

---

## Phase 4: Integration Validation

> **Exit Criteria:** All existing tests pass. Docker preview compose works end-to-end. Doctor shows new checks. Full test suite green.

### Task 4.1: Full Test Suite

Run: `pnpm test`
Expected: All tests pass (same baseline as before)

### Task 4.2: Build Verification

Run: `pnpm build`
Expected: exit 0 (no new TS errors)

### Task 4.3: Lint/Format

Run: `pnpm check`
Expected: exit 0 (or same baseline as before)

### Task 4.4: Docker Compose Validation

Run: `docker compose -f docker/mongodb/docker-compose.preview.yml config --quiet`
Expected: exit 0

### Task 4.5: Grep Verification -- No Stale References

Run:

```bash
# Check that "start.sh fullstack" is not referenced anywhere except in the legacy docker README
grep -rn "start.sh fullstack" src/ docs/ --include="*.ts" --include="*.md" | grep -v "docker/mongodb/README.md"
```

Expected: 0 matches (all upgrade guidance points to `start-preview.sh`)

Run:

```bash
# Check that "mongot running alongside mongod" is gone from docs
grep -rn "mongot running alongside mongod" docs/ --include="*.md"
```

Expected: 0 matches

Run:

```bash
# Check that old Atlas URI message is gone
grep -rn "Atlas URIs are not supported" src/ --include="*.ts"
```

Expected: 0 matches (replaced by atlas-local-aware message)

### Task 4.6: Final Commit (if any cleanup needed)

```bash
scripts/committer "Cleanup: fix any lint/format issues from Docker+Doctor+Onboarding+Migration" \
  [files with cleanup changes]
```

---

## Risks And Mitigations

| Risk                                             | P (1-5) | I (1-5) | Score | Mitigation                                                                                      |
| ------------------------------------------------ | ------- | ------- | ----- | ----------------------------------------------------------------------------------------------- |
| preview tag instability (experimental)           | 3       | 3       | 9     | Existing multi-container setup preserved as Advanced fallback. README documents preview status. |
| Docker image pull failure (network)              | 2       | 2       | 4     | start-preview.sh has timeout and clear error messages                                           |
| Existing test breakage from onboarding reorder   | 3       | 4       | 12    | Read existing test mocks before modifying. Run full suite after each change.                    |
| Doctor checks too slow (Docker inspect)          | 2       | 2       | 4     | Docker image check is optional, skipped if Docker not available                                 |
| Voyage AI key in env not secure enough           | 2       | 3       | 6     | Onboarding suggests .env file, not hardcoded. Doctor does not log key values.                   |
| preview tag changes MongoDB version unexpectedly | 3       | 2       | 6     | Doctor reports detected version. README notes preview tracks latest.                            |
| ComposeTier union change breaks existing code    | 2       | 4       | 8     | `preview` is additive. Existing `fullstack`/`replicaset`/`standalone` values unchanged.         |
| Atlas URI rejection confuses users               | 3       | 2       | 6     | New message explicitly explains atlas-local is recommended, SaaS Atlas is not supported.        |

---

## Acceptance Checks

### Docker

- [ ] `docker compose -f docker/mongodb/docker-compose.preview.yml up -d` starts container
- [ ] Container reaches "healthy" state within 90 seconds
- [ ] `mongosh --eval "db.adminCommand('ping')"` succeeds against running container
- [ ] `$vectorSearch` aggregation available (mongot bundled)
- [ ] Existing multi-container `docker-compose.mongodb.yml` still works

### Migration (atlas-local everywhere)

- [ ] `grep -rn "start.sh fullstack" src/ docs/ --include="*.ts" --include="*.md"` returns only `docker/mongodb/README.md` hits
- [ ] `grep -rn "mongot running alongside mongod" docs/` returns 0 hits
- [ ] `grep -rn "Atlas URIs are not supported" src/` returns 0 hits (old message gone)
- [ ] All 6 doc files reference `atlas-local:preview` as primary path
- [ ] All 5 source files have updated upgrade guidance to `start-preview.sh`
- [ ] `clawmongo-preview` container is detected by `detectExistingMongoDB` and `getRunningClawMongoContainers`
- [ ] `TIER_CONTAINERS` and `TIER_URIS` include `preview` key
- [ ] `TIER_LABELS` includes `preview` entry

### Doctor

- [ ] `openclaw doctor` shows "mongot: reachable" when connected to fullstack
- [ ] `openclaw doctor` shows "mongot: not detected" when connected to standalone
- [ ] `openclaw doctor` shows Voyage AI key status
- [ ] `openclaw doctor` shows vector search index count
- [ ] `openclaw doctor` shows Docker image warning when not using preview tag
- [ ] `openclaw doctor` suggests preview migration for legacy multi-container setups
- [ ] All existing doctor tests still pass

### Onboarding

- [ ] `clawmongo setup` runs MongoDB connection before LLM provider
- [ ] Auto-Docker-start uses preview compose file first
- [ ] Voyage AI key prompt appears when mongot detected but key missing
- [ ] Mongot verification offers Docker start when not detected
- [ ] Atlas URI rejection message mentions `mongodb-atlas-local:preview`
- [ ] Existing OpenClaw onboarding flow unchanged
- [ ] All existing onboarding tests still pass

### Full Suite

- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] `pnpm check` passes

---

## Summary

- Plan saved: `docs/plans/2026-03-22-docker-doctor-onboarding-plan.md`
- Phases: 5 (Docker, Legacy Migration, Doctor, Onboarding, Integration Validation)
- Risks: 8 identified, highest score 12 (test breakage from reorder)
- Key decisions: atlas-local:preview everywhere, `community-mongot` profile name stays, multi-container preserved as Advanced, additive doctor checks, MongoDB-first onboarding for ClawMongo only
- Estimated tasks: 25+ across 5 phases
- Files touched: 17 (6 docs, 5 source, 2 new Docker files, 4+ test files)
