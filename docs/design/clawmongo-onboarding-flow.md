# ClawMongo Onboarding Flow Design

## Overview

ClawMongo's onboarding must verify MongoDB infrastructure before proceeding to channel setup. This is a design document for future implementation -- no code changes are expected from this document.

The current OpenClaw onboarding flow (`clawmongo onboard --install-daemon`) goes directly from model provider selection to gateway setup. It does not verify MongoDB connectivity, mongot availability, or Voyage AI configuration. ClawMongo needs these checks to prevent users from completing onboarding with a broken memory backend.

---

## Current State

The existing onboarding flow (implemented across 34 files in `src/commands/onboard*.ts`):

1. Select model provider (Anthropic, OpenAI, Google, etc.)
2. Enter API key
3. Configure gateway (port 18789, loopback bind)
4. Install daemon (launchd/systemd)
5. Open Control UI

**What is missing:**

- MongoDB connection verification (is MongoDB reachable?)
- Replica set verification (are change streams available?)
- MongoDB version check (>= 7.0 for mongot compatibility?)
- mongot verification (is Search Index Management available?)
- Voyage AI configuration check (can mongot generate embeddings?)
- Collection and index bootstrap verification (were all 20 collections created?)
- Memory write/read cycle test (does the full pipeline work end-to-end?)

---

## Proposed Flow

### Step 1: MongoDB Connection

**Goal:** Verify the MongoDB URI is valid and the server is reachable.

- Prompt for MongoDB URI (or detect from environment variable `MONGODB_URI` / existing config)
- Test connection with `db.admin().command({ ping: 1 })`
- Verify replica set membership (required for change streams)
  - If single node: suggest `--replSet rs0` startup flag
  - If standalone: warn that change streams will be unavailable (ClawMongo falls back to periodic sync)
- Check MongoDB version via `db.admin().command({ buildInfo: 1 })`
  - Minimum: 7.0 (for mongot compatibility)
  - Recommended: 8.0+ (for `$rankFusion`)
  - Optimal: 8.2+ (for `$scoreFusion`)

**Error handling:**
- Connection refused: print connection troubleshooting steps
- Auth failure: prompt for credentials
- Version too old: warn and suggest upgrade path

### Step 2: mongot Verification

**Goal:** Verify that MongoDB Search (mongot) is available for text and vector indexing.

- Attempt `collection.listSearchIndexes()` on a probe collection
- If successful: mongot is available, proceed
- If failed with "Search Index Management service" error: mongot not available
  - Print setup instructions for the user's deployment type (Docker, local, Atlas)
  - Allow proceeding without mongot (degraded mode: BSON `$text` indexes only, no vector search)

**Error handling:**
- mongot not running: provide platform-specific startup instructions
- Atlas without Search enabled: link to Atlas Search documentation

### Step 3: Voyage AI Configuration

**Goal:** Verify that Voyage AI embeddings work through mongot.

- If mongot is available: attempt to create a test vector search index with `autoEmbed`
- Verify the index reaches `READY` state (not `FAILED` or `PENDING`)
- If the index fails due to Voyage AI credentials: prompt for Voyage AI API key
- Set `memory.mongodb.embeddingMode = "automated"` in config

**Error handling:**
- Missing Voyage AI key: prompt for key, provide signup link (voyageai.com)
- Invalid key: display error, prompt for re-entry
- Rate limit: suggest waiting and retrying

### Step 4: Collection Bootstrap

**Goal:** Create all required collections and indexes.

- Run `ensureCollections(db, prefix)` to create all 20 collections with JSON Schema validation
- Run `ensureStandardIndexes(db, prefix)` to create all 53 standard indexes
- If mongot available: run `ensureSearchIndexes(db, prefix, ...)` to create up to 8 search indexes
- Verify counts:
  - 20 collections created
  - 53 standard indexes created
  - Search indexes created (if mongot available)

**Display to user:**
- Collection count created
- Index count created
- Search index status (created / skipped due to no mongot)
- Any schema validation warnings

**Error handling:**
- Permission denied: suggest database role requirements
- Index creation failure: log specific index and suggest manual creation

### Step 5: LLM Provider (Existing Flow)

**Goal:** Configure the LLM that powers the agent's reasoning.

This step is unchanged from the current onboarding flow:

- Select model provider (Anthropic, OpenAI, Google, Mistral, etc.)
- Enter API key
- Test model connection with a simple prompt
- Save to config

### Step 6: Channel Setup (Existing Flow)

**Goal:** Connect the agent to a messaging channel.

This step is unchanged from the current onboarding flow:

- Suggest Telegram as the quickest channel
- Walk through channel-specific credential setup
- Test channel connection
- Save to config

### Step 7: Health Check

**Goal:** Verify the complete system works end-to-end.

- Run `clawmongo doctor` with MongoDB-specific checks:
  - MongoDB connectivity (ping)
  - Replica set status
  - Collection count (expected: 20)
  - Index count (expected: 53+)
  - mongot availability
  - Voyage AI embedding generation (if mongot available)
- Run a memory write + read cycle:
  - Write a test event via `writeEvent()`
  - Read it back via `getEventsByTimeRange()`
  - Verify the event was projected to a chunk
  - Clean up test data
- Show status summary:
  - MongoDB: connected / version / replica set status
  - mongot: available / unavailable
  - Voyage AI: working / not configured
  - Collections: N/20 created
  - Indexes: N/53 created
  - Memory write/read: passed / failed
  - LLM: connected / model name
  - Channel: connected / channel name (if configured)

---

## Error Handling Summary

| Failure | Recovery | Blocking? |
|---------|----------|-----------|
| MongoDB unreachable | Print connection troubleshooting, retry prompt | Yes |
| Replica set not configured | Warn, suggest `--replSet`, allow proceeding (degraded) | No |
| MongoDB version < 7.0 | Warn, suggest upgrade | No |
| mongot not available | Warn, allow proceeding without vector search | No |
| Voyage AI key missing/invalid | Prompt for key, retry | No (proceed without autoEmbed) |
| Collection creation failed | Log error, suggest permissions fix | Yes |
| Index creation failed | Log specific index, continue with others | No |
| LLM connection failed | Retry prompt, allow different provider | Yes |
| Channel setup failed | Skip, allow setup later | No |
| Memory write/read failed | Log error, suggest troubleshooting | Yes |

---

## Implementation Notes

### Files to Modify

- `src/commands/onboard-interactive.ts` -- add MongoDB steps before LLM provider selection
- `src/commands/onboard-config.ts` -- add MongoDB URI and embeddingMode to config generation
- `src/commands/onboard-helpers.ts` -- add MongoDB connection test, mongot probe, and collection bootstrap helpers

### New Functions Needed

- `testMongoDBConnection(uri: string)` -- ping + version + replica set check
- `testMongotAvailability(db: Db)` -- listSearchIndexes probe
- `testVoyageAIConfiguration(db: Db, prefix: string)` -- create + verify test vector index
- `bootstrapCollections(db: Db, prefix: string)` -- ensureCollections + ensureStandardIndexes + report
- `verifyMemoryWriteReadCycle(db: Db, prefix: string, agentId: string)` -- write event, read back, verify projection

### Non-Interactive Mode

The `--non-interactive` mode should accept MongoDB configuration via environment variables or config file:

- `MONGODB_URI` or `memory.mongodb.uri` in config
- `MONGODB_EMBEDDING_MODE` or `memory.mongodb.embeddingMode` in config
- Skip interactive prompts, run all verification steps, exit non-zero on any blocking failure

### Estimated Implementation Effort

- **Step 1 (MongoDB connection)**: Small. Mostly wrapping existing `MongoClient.connect()` with user-friendly error messages.
- **Step 2 (mongot verification)**: Small. `listSearchIndexes()` probe already exists in `detectCapabilities()`.
- **Step 3 (Voyage AI check)**: Medium. Need to create and verify a test search index, then clean it up.
- **Step 4 (Collection bootstrap)**: Small. `ensureCollections()` and `ensureStandardIndexes()` already exist.
- **Step 5-6 (LLM + Channel)**: None. Existing flow unchanged.
- **Step 7 (Health check)**: Medium. Need to wire existing doctor checks + new memory write/read cycle.

Total: approximately 300-500 lines of new code across 3 files, plus test coverage.

---

## Open Questions (for Implementation Phase)

1. Should the onboarding flow support creating a MongoDB replica set automatically for Docker users?
2. Should the Voyage AI key be stored in ClawMongo config (accessible to the application) or only in mongot config (inaccessible to the application)?
3. Should the onboarding flow support Atlas auto-detection (detect Atlas URI format and skip local mongot checks)?
4. What should the timeout be for mongot search index creation verification? Atlas indexes can take 1-5 minutes to reach READY state.
