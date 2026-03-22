# ClawMongo v2026.3.27 -- Atlas Local Migration

## Highlights

ClawMongo now runs entirely on `mongodb-atlas-local:preview` -- a single Docker container that bundles mongod, mongot, and Voyage AI auto-embeddings. No separate services, no raw mongod fallback.

## What's New

### Atlas-Local Migration
- **Single-container deployment**: `mongodb-atlas-local:preview` replaces separate mongod + mongot setup
- **Docker one-command start**: `./docker/mongodb/start-preview.sh` handles container lifecycle
- **Docker is required**: No raw `mongod --dbpath` fallback. The onboarding wizard enforces Docker availability.

### Interactive Onboarding
- **Voyage AI key prompt**: The setup wizard now prompts for `VOYAGE_API_KEY` before Docker auto-setup, ensuring auto-embeddings work from the first run
- **Docker requirement enforcement**: Clear guidance when Docker is not installed or not running, instead of falling through to manual mongod setup
- **Atlas-local health verification**: Post-setup topology detection warns when mongot is not detected

### Doctor MongoDB Checks
- **mongot health**: Detects whether the search engine is reachable
- **VOYAGE_API_KEY validation**: Warns when auto-embeddings are configured but the API key is missing
- **Vector search index audit**: Reports vector and text search index counts on chunk collections
- **Three-failure-mode diagnostic**: Guided troubleshooting for memory recall issues (Not Retrieved, Compaction Lost It, Never Stored)

### README and Documentation
- **Architecture diagrams**: ASCII flow diagrams for Write Path and Retrieval Path
- **12 MongoDB capabilities table**: Each capability with "why it matters" and "how it works"
- **20 collections and 8 retrieval paths**: Full data model documentation

### Upstream Sync
- **Wave 2**: 50 upstream commits absorbed (271 ahead / 0 behind)
- **Wave 1**: 729 upstream commits absorbed with 48 conflict resolutions
- Source taxonomy migrated: "memory" to "conversation" in production code

### Test Coverage
- 53 live e2e tests pass against real MongoDB 8.2 + Voyage AI
- 573 total memory unit tests
- 205 v2 memory architecture tests

## Breaking Changes

- Docker is now required for ClawMongo setup. The raw `mongod --dbpath` fallback has been removed from the onboarding wizard.
- The `mongodb-atlas-local:preview` image is the only supported local deployment target.

## Upgrade Guide

```bash
# 1. Start the atlas-local:preview container
./docker/mongodb/start-preview.sh

# 2. Update ClawMongo
npm install -g @romiluz/clawmongo@latest

# 3. Verify
clawmongo doctor
```

## npm

```bash
npm install -g @romiluz/clawmongo@2026.3.27
```
