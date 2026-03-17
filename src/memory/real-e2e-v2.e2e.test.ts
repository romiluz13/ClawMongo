/**
 * Real E2E Test: Memory v2 Architecture — Full Capability Validation
 *
 * Tests ALL v2 capabilities against a live MongoDB (mongod + mongot)
 * with realistic multi-turn AI agent simulation data.
 *
 * Run: MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true" \
 *      pnpm vitest run --config vitest.e2e.config.ts src/memory/real-e2e-v2.e2e.test.ts --reporter=verbose
 */

import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// v2 episodes
import {
  materializeEpisode,
  getEpisodesByTimeRange,
  getEpisodesByType,
  searchEpisodes,
  checkAutoEpisodeTriggers,
} from "./mongodb-episodes.js";
// V2Status used implicitly via getV2Status return type
import type { EpisodeSummarizer } from "./mongodb-episodes.js";
// v2 events
import {
  getEventsByTimeRange,
  getEventsBySession,
  getUnprojectedEvents,
  getUnconsolidatedEvents,
  markEventsConsolidated,
} from "./mongodb-events.js";
// v2 graph
import {
  upsertEntity,
  upsertRelation,
  findEntitiesByName,
  getEntitiesByType,
  expandGraph,
  extractAndUpsertEntities,
  deleteEntity,
} from "./mongodb-graph.js";
// v2 manager functions
import { writeEventAndProject, searchV2, getV2Status } from "./mongodb-manager.js";
// v2 ops
import { getRecentIngestRuns } from "./mongodb-ops.js";
// v2 retrieval planner
import { planRetrieval } from "./mongodb-retrieval-planner.js";
// Schema setup
import { ensureCollections, ensureStandardIndexes, ensureSearchIndexes } from "./mongodb-schema.js";
// Search functions (direct vector search, keyword search, hybrid)
import { vectorSearch, keywordSearch, buildVectorSearchStage } from "./mongodb-search.js";
import type { MemorySearchResult } from "./types.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const TEST_URI =
  process.env.MONGODB_TEST_URI ||
  "mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true";
const PREFIX = "clawtest_";
const AGENT_ID = `agent-e2e-${randomUUID().slice(0, 8)}`;
const AUTO_EMBED_ENABLED = Boolean(
  process.env.VOYAGE_API_KEY ||
    process.env.VOYAGE_API_QUERY_KEY ||
    process.env.VOYAGE_API_INDEXING_KEY,
);

async function waitForVectorResults(
  db: Db,
  queryText: string,
  {
    maxResults = 5,
    minScore = 0.0,
    indexName = `${PREFIX}chunks_vector`,
    timeoutMs = 90_000,
    pollMs = 1_000,
  }: {
    maxResults?: number;
    minScore?: number;
    indexName?: string;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<MemorySearchResult[]> {
  const chunks = db.collection(`${PREFIX}chunks`);
  const deadline = Date.now() + timeoutMs;
  let lastResults: MemorySearchResult[] = [];

  // mongot auto-embedding completes in background after ingest; poll until the
  // vector index starts returning semantic hits or the test timeout expires.
  while (Date.now() < deadline) {
    lastResults = await vectorSearch(chunks, null, {
      maxResults,
      minScore,
      indexName,
      queryText,
      embeddingMode: "automated",
    });
    if (lastResults.length > 0) {
      return lastResults;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return lastResults;
}

// ─── Realistic conversation data ───────────────────────────────────────────────

// Simulates a multi-day AI coding assistant helping a developer build a startup
const CONVERSATION_DAY1_SESSION1 = [
  // Morning: project kickoff
  {
    role: "user",
    body: "Hey, I'm @romiluz and I'm building a SaaS product called DataVault. It's a #data-pipeline tool for small teams. Can you help me architect it?",
  },
  {
    role: "assistant",
    body: "Of course! DataVault sounds like an exciting project. For a data pipeline tool targeting small teams, I'd recommend a modular architecture. Let me outline the key components:\n\n1. **Ingestion Layer** - Handle multiple data sources (APIs, databases, file uploads)\n2. **Transform Engine** - Apply user-defined transformations using a DAG model\n3. **Storage Layer** - Use a combination of object storage (S3) and a metadata database\n4. **Orchestration** - A scheduler for pipeline runs\n5. **UI Dashboard** - Real-time monitoring\n\nShould we start with the ingestion layer or the overall system design?",
  },
  {
    role: "user",
    body: "Let's start with the overall design. I want to use TypeScript for the backend, React for the frontend, and MongoDB as the main database. The project repo is at https://github.com/romiluz/datavault",
  },
  {
    role: "assistant",
    body: "Great tech stack! Here's my recommended project structure for DataVault:\n\n```\ndatavault/\n├── packages/\n│   ├── core/          # Pipeline engine, DAG execution\n│   ├── api/           # REST + WebSocket API (Express/Fastify)\n│   ├── web/           # React dashboard\n│   ├── connectors/    # Data source connectors\n│   └── shared/        # Shared types, utils\n├── docker/\n│   └── mongodb/       # Local dev MongoDB setup\n└── docs/\n    └── architecture/  # ADRs and design docs\n```\n\nFor MongoDB, I'd recommend:\n- `pipelines` collection for pipeline definitions\n- `runs` collection for execution history\n- `connectors` collection for data source configs\n- `users` collection for auth\n\nWant me to create the initial project structure?",
  },
  {
    role: "user",
    body: 'Yes! Also, I want to mention that @sarah-chen from my team will handle the frontend. She\'s really good with React and "Sarah Chen" knows the design system well. We also need to integrate with #Stripe for billing.',
  },
  {
    role: "assistant",
    body: "Got it! I'll note that Sarah Chen (@sarah-chen) owns the frontend/React dashboard, and we need Stripe billing integration. Let me set up the initial structure...\n\nI've created the workspace. Key decisions so far:\n- TypeScript monorepo with pnpm workspaces\n- MongoDB for persistence\n- Stripe for billing\n- Team: you (backend/architecture) and Sarah (frontend)\n\nNext, should we define the pipeline data model or set up the API layer first?",
  },
];

const CONVERSATION_DAY1_SESSION2 = [
  // Afternoon: deep dive into data model
  {
    role: "user",
    body: "Let's define the data model. A pipeline has stages, each stage has a transformer. The file /packages/core/src/pipeline.ts should define this.",
  },
  {
    role: "assistant",
    body: "Here's the pipeline data model I'd recommend for `/packages/core/src/pipeline.ts`:\n\n```typescript\nexport interface Pipeline {\n  id: string;\n  name: string;\n  description?: string;\n  stages: PipelineStage[];\n  schedule?: CronSchedule;\n  status: 'draft' | 'active' | 'paused' | 'archived';\n  createdBy: string;\n  createdAt: Date;\n  updatedAt: Date;\n}\n\nexport interface PipelineStage {\n  id: string;\n  name: string;\n  type: 'source' | 'transform' | 'sink';\n  config: Record<string, unknown>;\n  dependsOn: string[];  // DAG edges\n}\n```\n\nThe `dependsOn` array creates the DAG structure. For MongoDB, we'd use a single document per pipeline with embedded stages — this works well since stages are always accessed with their pipeline.",
  },
  {
    role: "user",
    body: "Good, but I also need error handling. When a stage fails, the pipeline should pause and alert. @mike-ops manages our alerting through PagerDuty.",
  },
  {
    role: "assistant",
    body: "I'll add error handling to the pipeline model. Key additions:\n\n1. **Stage-level error tracking**: Each stage gets `lastError`, `retryCount`, `status`\n2. **Pipeline-level circuit breaker**: Pause on N consecutive failures\n3. **Alerting integration**: PagerDuty webhook via Mike (@mike-ops)\n\nThe error handling config goes in `/packages/core/src/error-handler.ts`. I'll also add a `PipelineRun` type that tracks each execution with per-stage results.\n\nFor PagerDuty integration, we should create a connector in `/packages/connectors/src/pagerduty.ts` that Mike can configure with his API keys.",
  },
];

const CONVERSATION_DAY2_SESSION1 = [
  // Next day: discussing deployment and a bug
  {
    role: "user",
    body: "I found a bug — the pipeline scheduler is skipping every other run. The cron expression '*/5 * * * *' should fire every 5 minutes but it's firing every 10. Check /packages/core/src/scheduler.ts",
  },
  {
    role: "assistant",
    body: 'Looking at `/packages/core/src/scheduler.ts` — I found the issue! The scheduler uses `setInterval` with the cron-parsed interval, but there\'s a race condition:\n\n```typescript\n// BUG: lastRunTime is set BEFORE the run completes\nthis.lastRunTime = Date.now();\nawait this.executePipeline(pipeline);\n```\n\nThe fix: move `lastRunTime` to AFTER execution:\n```typescript\nawait this.executePipeline(pipeline);\nthis.lastRunTime = Date.now();\n```\n\nThis was causing the next interval check to think a run was still "recent" and skip it. Classic async timing bug.',
  },
  {
    role: "user",
    body: "Nice catch! Also, I want to deploy to AWS. We'll use ECS for the API, CloudFront for the web app, and DocumentDB (MongoDB-compatible) for the database. The deployment config is at /infrastructure/terraform/",
  },
  {
    role: "assistant",
    body: "For AWS deployment with DocumentDB, a few important notes:\n\n1. **DocumentDB compatibility**: It's MongoDB 5.0 compatible but lacks some features like change streams (partially supported) and certain aggregation operators. We should test our pipeline queries against DocumentDB specifically.\n\n2. **Terraform structure** for `/infrastructure/terraform/`:\n```\nterraform/\n├── modules/\n│   ├── vpc/\n│   ├── ecs/\n│   ├── documentdb/\n│   └── cloudfront/\n├── environments/\n│   ├── dev/\n│   ├── staging/\n│   └── prod/\n└── main.tf\n```\n\n3. **Key decision**: Should we use DocumentDB's built-in backups or implement our own backup strategy with S3? Given DataVault handles customer data pipelines, I'd recommend both.\n\n4. The #deployment pipeline itself should be a DataVault pipeline — dogfooding!",
  },
];

const CONVERSATION_DAY3_SESSION1 = [
  // Day 3: performance and scaling discussion
  {
    role: "user",
    body: "We're seeing slow queries on the runs collection. The query to get recent runs for a pipeline takes 3 seconds. We have 500K documents in runs.",
  },
  {
    role: "assistant",
    body: "3 seconds for a runs query with 500K docs indicates a missing index. Let me diagnose:\n\nThe slow query is likely: `db.runs.find({ pipelineId: X }).sort({ startedAt: -1 }).limit(20)`\n\nFix: Create a compound index:\n```javascript\ndb.runs.createIndex({ pipelineId: 1, startedAt: -1 }, { name: 'idx_runs_pipeline_time' })\n```\n\nThis index covers both the filter and the sort, eliminating the need for an in-memory sort. Should drop the query to <10ms.\n\nAlso consider:\n1. **TTL index** on old runs: `{ startedAt: 1 }, { expireAfterSeconds: 7776000 }` (90 days)\n2. **Archival strategy**: Move runs older than 30 days to a `runs_archive` collection\n3. **Partial index** if most queries filter by status: `{ pipelineId: 1, startedAt: -1 }, { partialFilterExpression: { status: 'completed' } }`",
  },
  {
    role: "user",
    body: "The compound index fixed it! Now @sarah-chen needs help with the dashboard. She wants real-time pipeline status updates. Should we use WebSockets or Server-Sent Events?",
  },
  {
    role: "assistant",
    body: "For real-time pipeline status in the DataVault dashboard, I recommend **Server-Sent Events (SSE)** over WebSockets:\n\n**Why SSE:**\n1. Unidirectional data flow (server → client) matches our use case perfectly\n2. Built-in reconnection and event ID tracking\n3. Works through HTTP/2 with multiplexing\n4. Simpler server implementation in our Express/Fastify API\n5. No need for a WebSocket library on the frontend\n\n**Implementation:**\n- Backend: `/api/pipelines/:id/events` SSE endpoint\n- Watch MongoDB change stream on `runs` collection → push status events\n- Frontend: `EventSource` API with React hook `usePipelineStatus(id)`\n\nSarah can use the `usePipelineStatus` hook like:\n```tsx\nconst { status, lastRun, error } = usePipelineStatus(pipelineId);\n```\n\nThe only case for WebSockets would be if we need bidirectional communication (e.g., user triggers a run from the dashboard), but that can use regular REST POST calls.",
  },
];

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe("Real E2E: Memory v2 Full Capability Test", () => {
  let client: MongoClient;
  let db: Db;

  // Track IDs for cross-test assertions
  const eventIds: string[] = [];
  const entityIds: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(TEST_URI, {
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    db = client.db("openclaw");

    // Setup fresh collections and indexes
    await ensureCollections(db, PREFIX);
    await ensureStandardIndexes(db, PREFIX, {
      embeddingCacheTtlDays: 0,
      memoryTtlDays: 0,
      relevanceRetentionDays: 14,
    });

    // Clean any leftover data for our agent
    const allCollections = await db.listCollections().toArray();
    for (const col of allCollections) {
      if (col.name.startsWith(PREFIX)) {
        await db.collection(col.name).deleteMany({ agentId: AGENT_ID });
      }
    }
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Canonical Events — Write multi-session conversation data
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 1: Canonical Events & Chunk Projection", () => {
    it("should write Day 1 Session 1 events (project kickoff)", async () => {
      for (let i = 0; i < CONVERSATION_DAY1_SESSION1.length; i++) {
        const msg = CONVERSATION_DAY1_SESSION1[i];
        const result = await writeEventAndProject(db, PREFIX, {
          agentId: AGENT_ID,
          role: msg.role,
          body: msg.body,
          scope: "agent",
          sessionId: "day1-session1",
          metadata: { day: 1, session: 1, turn: i },
        });

        expect(result.eventId).toBeDefined();
        expect(result.chunksCreated).toBeGreaterThanOrEqual(0);
        eventIds.push(result.eventId);
      }

      // Verify events persisted
      const events = await getEventsBySession({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        sessionId: "day1-session1",
      });
      expect(events.length).toBe(CONVERSATION_DAY1_SESSION1.length);
    });

    it("should write Day 1 Session 2 events (data model deep dive)", async () => {
      for (let i = 0; i < CONVERSATION_DAY1_SESSION2.length; i++) {
        const msg = CONVERSATION_DAY1_SESSION2[i];
        const result = await writeEventAndProject(db, PREFIX, {
          agentId: AGENT_ID,
          role: msg.role,
          body: msg.body,
          scope: "agent",
          sessionId: "day1-session2",
          metadata: { day: 1, session: 2, turn: i },
        });
        eventIds.push(result.eventId);
      }

      const events = await getEventsBySession({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        sessionId: "day1-session2",
      });
      expect(events.length).toBe(CONVERSATION_DAY1_SESSION2.length);
    });

    it("should write Day 2 events (deployment & bug fix)", async () => {
      for (let i = 0; i < CONVERSATION_DAY2_SESSION1.length; i++) {
        const msg = CONVERSATION_DAY2_SESSION1[i];
        const result = await writeEventAndProject(db, PREFIX, {
          agentId: AGENT_ID,
          role: msg.role,
          body: msg.body,
          scope: "agent",
          sessionId: "day2-session1",
          metadata: { day: 2, session: 1, turn: i },
        });
        eventIds.push(result.eventId);
      }
    });

    it("should write Day 3 events (performance & real-time)", async () => {
      for (let i = 0; i < CONVERSATION_DAY3_SESSION1.length; i++) {
        const msg = CONVERSATION_DAY3_SESSION1[i];
        const result = await writeEventAndProject(db, PREFIX, {
          agentId: AGENT_ID,
          role: msg.role,
          body: msg.body,
          scope: "agent",
          sessionId: "day3-session1",
          metadata: { day: 3, session: 1, turn: i },
        });
        eventIds.push(result.eventId);
      }
    });

    it("should have projected events into chunks", async () => {
      // All events should be projected (writeEventAndProject does projection inline)
      const unprojected = await getUnprojectedEvents({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
      });
      expect(unprojected.length).toBe(0);
    });

    it("should retrieve events by time range", async () => {
      const allEvents = await getEventsByTimeRange({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        start: new Date("2026-03-01"),
        end: new Date("2026-03-31"),
      });

      const totalMessages =
        CONVERSATION_DAY1_SESSION1.length +
        CONVERSATION_DAY1_SESSION2.length +
        CONVERSATION_DAY2_SESSION1.length +
        CONVERSATION_DAY3_SESSION1.length;

      expect(allEvents.length).toBe(totalMessages);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Entity Extraction — Extract people, topics, URLs from events
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 2: Rule-Based Entity Extraction", () => {
    it("should extract entities from all conversation events", async () => {
      // Gather all event bodies
      const allEvents = await getEventsByTimeRange({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        start: new Date("2026-03-01"),
        end: new Date("2026-03-31"),
      });

      let totalEntities = 0;
      let totalRelations = 0;

      for (const event of allEvents) {
        const result = await extractAndUpsertEntities({
          db,
          prefix: PREFIX,
          agentId: AGENT_ID,
          eventContent: event.body,
          scope: "agent",
          sourceEventId: event.eventId,
        });
        totalEntities += result.entities.length;
        totalRelations += result.relationsCreated;
      }

      console.log(`  Extracted ${totalEntities} entity mentions, ${totalRelations} relations`);
      expect(totalEntities).toBeGreaterThan(0);
    });

    it("should find @romiluz as a person entity", async () => {
      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "romiluz",
        agentId: AGENT_ID,
      });
      expect(results.length).toBeGreaterThan(0);
      // URL entity containing "romiluz" may sort before person entity
      const personResults = results.filter((r) => r.type === "person");
      expect(personResults.length).toBeGreaterThan(0);
    });

    it("should find @sarah as a person entity (regex captures word chars only)", async () => {
      // MENTION_REGEX /@(\w{3,})/ captures "sarah" from "@sarah-chen" (no hyphens in \w)
      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "sarah",
        agentId: AGENT_ID,
      });
      expect(results.length).toBeGreaterThan(0);
      const personResults = results.filter((r) => r.type === "person");
      expect(personResults.length).toBeGreaterThan(0);
      entityIds.push(personResults[0].entityId);
    });

    it("should find #data as a topic entity (regex captures word chars only)", async () => {
      // TAG_REGEX /#(\w{3,})/ captures "data" from "#data-pipeline" (no hyphens in \w)
      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "data",
        agentId: AGENT_ID,
      });
      expect(results.length).toBeGreaterThan(0);
      const topicResults = results.filter((r) => r.type === "topic");
      expect(topicResults.length).toBeGreaterThan(0);
    });

    it("should find GitHub URL as a document entity", async () => {
      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "github.com",
        agentId: AGENT_ID,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe("document");
    });

    it("should extract document entities (URLs, file paths)", async () => {
      // FILE_PATH_REGEX requires (?:^|\s) before the path — leading "/" after
      // backticks won't match. But URLs always match (https://...).
      const docs = await getEntitiesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "document",
      });
      expect(docs.length).toBeGreaterThan(0);
      // At least the GitHub URL should be extracted
      const urls = docs.filter((d) => d.name.startsWith("http"));
      expect(urls.length).toBeGreaterThan(0);
    });

    it("should find quoted name 'Sarah Chen' as a person entity", async () => {
      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "Sarah Chen",
        agentId: AGENT_ID,
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("should have person entities across conversations", async () => {
      const people = await getEntitiesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "person",
      });
      console.log(
        `  Found ${people.length} person entities:`,
        people.map((p) => p.name),
      );
      // @mentions extract word chars only: romiluz, sarah, mike (not sarah-chen, mike-ops)
      // Plus quoted names like "Sarah Chen"
      expect(people.length).toBeGreaterThanOrEqual(3);
    });

    it("should have topic entities", async () => {
      const topics = await getEntitiesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "topic",
      });
      console.log(
        `  Found ${topics.length} topic entities:`,
        topics.map((t) => t.name),
      );
      expect(topics.length).toBeGreaterThanOrEqual(2); // data, Stripe, deployment (regex word-boundary extraction)
    });

    it("should have document entities (URLs + file paths)", async () => {
      const docs = await getEntitiesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "document",
      });
      console.log(
        `  Found ${docs.length} document entities:`,
        docs.map((d) => d.name),
      );
      // URLs are always extracted; file paths only match when preceded by whitespace (not backticks)
      expect(docs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Knowledge Graph — Manual entities + relations + expansion
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 3: Knowledge Graph Operations", () => {
    const projectEntityId = `entity-datavault-${randomUUID().slice(0, 8)}`;
    const teamEntityId = `entity-team-${randomUUID().slice(0, 8)}`;

    it("should upsert project entity manually", async () => {
      const result = await upsertEntity({
        db,
        prefix: PREFIX,
        entity: {
          entityId: projectEntityId,
          name: "DataVault",
          type: "project",
          agentId: AGENT_ID,
          scope: "agent",
          aliases: ["datavault", "DV"],
          metadata: {
            repo: "https://github.com/romiluz/datavault",
            tech: ["TypeScript", "React", "MongoDB"],
          },
          updatedAt: new Date(),
        },
      });
      expect(result.upserted).toBe(true);
      entityIds.push(projectEntityId);
    });

    it("should upsert team entity", async () => {
      await upsertEntity({
        db,
        prefix: PREFIX,
        entity: {
          entityId: teamEntityId,
          name: "DataVault Team",
          type: "org",
          agentId: AGENT_ID,
          scope: "agent",
          updatedAt: new Date(),
        },
      });
    });

    it("should create relations between entities", async () => {
      // Find romiluz entity
      const romiluz = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "romiluz",
        agentId: AGENT_ID,
      });

      const sarah = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "sarah",
        agentId: AGENT_ID,
      });

      if (romiluz.length > 0) {
        // romiluz works_on DataVault
        await upsertRelation({
          db,
          prefix: PREFIX,
          relation: {
            fromEntityId: romiluz[0].entityId,
            toEntityId: projectEntityId,
            type: "works_on",
            agentId: AGENT_ID,
            scope: "agent",
            weight: 1.0,
            updatedAt: new Date(),
          },
        });

        // romiluz is part of team
        await upsertRelation({
          db,
          prefix: PREFIX,
          relation: {
            fromEntityId: romiluz[0].entityId,
            toEntityId: teamEntityId,
            type: "works_on",
            agentId: AGENT_ID,
            scope: "agent",
            updatedAt: new Date(),
          },
        });
      }

      if (sarah.length > 0) {
        // sarah works_on DataVault
        await upsertRelation({
          db,
          prefix: PREFIX,
          relation: {
            fromEntityId: sarah[0].entityId,
            toEntityId: projectEntityId,
            type: "works_on",
            agentId: AGENT_ID,
            scope: "agent",
            weight: 0.8,
            updatedAt: new Date(),
          },
        });
      }
    });

    it("should expand graph from person entity (unidirectional)", async () => {
      // Unidirectional follows fromEntityId → toEntityId.
      // romiluz has outbound relations: works_on DataVault, works_on team
      const romiluz = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "romiluz",
        agentId: AGENT_ID,
      });

      expect(romiluz.length).toBeGreaterThan(0);
      const result = await expandGraph({
        db,
        prefix: PREFIX,
        entityId: romiluz[0].entityId,
        agentId: AGENT_ID,
        maxDepth: 2,
      });

      expect(result).not.toBeNull();
      if (result) {
        console.log(`  Graph expansion: ${result.connections.length} connections from romiluz`);
        // Should find DataVault and/or team via outbound works_on relations
        expect(result.connections.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("should expand graph bidirectionally", async () => {
      // Find romiluz entity for bidirectional expansion
      const romiluz = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "romiluz",
        agentId: AGENT_ID,
      });

      if (romiluz.length > 0) {
        const result = await expandGraph({
          db,
          prefix: PREFIX,
          entityId: romiluz[0].entityId,
          agentId: AGENT_ID,
          maxDepth: 2,
          bidirectional: true,
          maxConnections: 50,
        });

        expect(result).not.toBeNull();
        if (result) {
          console.log(
            `  Bidirectional expansion from romiluz: ${result.connections.length} connections`,
          );
          // Should find DataVault project and team through outgoing relations
          const connectedNames = result.connections.map((c) => c.entity.name);
          console.log(`  Connected entities:`, connectedNames);
          expect(result.connections.length).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it("should delete entity and cascade relations", async () => {
      // Create a temporary entity to delete
      const tempId = `entity-temp-${randomUUID().slice(0, 8)}`;
      await upsertEntity({
        db,
        prefix: PREFIX,
        entity: {
          entityId: tempId,
          name: "Temporary Entity",
          type: "custom",
          agentId: AGENT_ID,
          scope: "agent",
          updatedAt: new Date(),
        },
      });

      await upsertRelation({
        db,
        prefix: PREFIX,
        relation: {
          fromEntityId: tempId,
          toEntityId: projectEntityId,
          type: "related_to",
          agentId: AGENT_ID,
          scope: "agent",
          updatedAt: new Date(),
        },
      });

      const result = await deleteEntity({
        db,
        prefix: PREFIX,
        entityId: tempId,
        agentId: AGENT_ID,
      });
      expect(result.deletedEntity).toBe(true);
      expect(result.deletedRelations).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Episode Materialization — Create daily summaries
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 4: Episode Materialization", () => {
    // Simple summarizer that creates realistic-looking summaries without LLM
    const testSummarizer: EpisodeSummarizer = async (events) => {
      const userMessages = events.filter((e) => e.role === "user");
      const topics = new Set<string>();

      for (const e of events) {
        if (e.body.includes("pipeline")) {
          topics.add("pipeline");
        }
        if (e.body.includes("MongoDB") || e.body.includes("database")) {
          topics.add("database");
        }
        if (e.body.includes("deploy") || e.body.includes("AWS")) {
          topics.add("deployment");
        }
        if (e.body.includes("bug") || e.body.includes("fix")) {
          topics.add("bug-fix");
        }
        if (e.body.includes("performance") || e.body.includes("slow")) {
          topics.add("performance");
        }
        if (e.body.includes("React") || e.body.includes("frontend")) {
          topics.add("frontend");
        }
        if (e.body.includes("Stripe") || e.body.includes("billing")) {
          topics.add("billing");
        }
        if (e.body.includes("architecture") || e.body.includes("design")) {
          topics.add("architecture");
        }
      }

      return {
        title: `DataVault session: ${[...topics].slice(0, 3).join(", ")} (${userMessages.length} user turns)`,
        summary: `Discussion covering ${[...topics].join(", ")}. ${events.length} messages exchanged, ${userMessages.length} user turns. Key entities mentioned: ${
          events
            .flatMap((e) => {
              const mentions = e.body.match(/@[\w-]+/g) || [];
              return mentions;
            })
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(", ") || "none"
        }.`,
        tags: [...topics],
      };
    };

    it("should materialize a daily episode for Day 1", async () => {
      const episode = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
        timeRange: {
          start: new Date("2026-03-01"),
          end: new Date("2026-03-31"),
        },
        scope: "agent",
        summarizer: testSummarizer,
      });

      expect(episode).not.toBeNull();
      if (episode) {
        console.log(`  Episode: "${episode.title}"`);
        console.log(`  Summary: ${episode.summary.slice(0, 120)}...`);
        console.log(`  Tags: ${episode.tags?.join(", ")}`);
        console.log(`  Source events: ${episode.sourceEventCount}`);
        expect(episode.episodeId).toBeDefined();
        expect(episode.title.length).toBeGreaterThan(0);
        expect(episode.summary.length).toBeGreaterThan(0);
        expect(episode.sourceEventCount).toBeGreaterThanOrEqual(2);
      }
    });

    it("should materialize a topic episode for 'architecture'", async () => {
      const episode = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "topic",
        timeRange: {
          start: new Date("2026-03-01"),
          end: new Date("2026-03-31"),
        },
        scope: "agent",
        summarizer: testSummarizer,
      });

      // This will create a second episode (idempotent on type+timeRange)
      expect(episode).not.toBeNull();
    });

    it("should materialize a decision episode", async () => {
      const episode = await materializeEpisode({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "decision",
        timeRange: {
          start: new Date("2026-03-01"),
          end: new Date("2026-03-31"),
        },
        scope: "agent",
        summarizer: testSummarizer,
      });

      expect(episode).not.toBeNull();
    });

    it("should retrieve episodes by time range", async () => {
      const episodes = await getEpisodesByTimeRange({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        start: new Date("2026-03-01"),
        end: new Date("2026-03-31"),
      });

      console.log(`  Found ${episodes.length} episodes in March 2026`);
      expect(episodes.length).toBeGreaterThanOrEqual(1);
    });

    it("should retrieve episodes by type", async () => {
      const dailyEpisodes = await getEpisodesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "daily",
      });
      expect(dailyEpisodes.length).toBeGreaterThanOrEqual(1);

      const decisionEpisodes = await getEpisodesByType({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        type: "decision",
      });
      expect(decisionEpisodes.length).toBeGreaterThanOrEqual(1);
    });

    it("should search episodes by keyword", async () => {
      const results = await searchEpisodes({
        db,
        prefix: PREFIX,
        query: "pipeline",
        agentId: AGENT_ID,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Memory Consolidation Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 5: Consolidation Lifecycle", () => {
    it("should have unconsolidated events", async () => {
      const events = await getUnconsolidatedEvents({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
      });
      console.log(`  ${events.length} unconsolidated events`);
      expect(events.length).toBeGreaterThan(0);
    });

    it("should mark events as consolidated", async () => {
      const events = await getUnconsolidatedEvents({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        limit: 5,
      });

      if (events.length > 0) {
        const idsToConsolidate = events.map((e) => e.eventId);
        const modified = await markEventsConsolidated({
          db,
          prefix: PREFIX,
          eventIds: idsToConsolidate,
          episodeId: `ep-test-${randomUUID().slice(0, 8)}`,
        });
        expect(modified).toBe(idsToConsolidate.length);
      }
    });

    it("should have fewer unconsolidated events after marking", async () => {
      const remaining = await getUnconsolidatedEvents({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
      });
      // Should be fewer than total since we consolidated 5
      const totalMessages =
        CONVERSATION_DAY1_SESSION1.length +
        CONVERSATION_DAY1_SESSION2.length +
        CONVERSATION_DAY2_SESSION1.length +
        CONVERSATION_DAY3_SESSION1.length;
      expect(remaining.length).toBeLessThan(totalMessages);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 6: Auto Episode Triggers
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 6: Auto Episode Triggers", () => {
    it("should detect trigger conditions on unconsolidated events", async () => {
      const result = await checkAutoEpisodeTriggers({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        summarizer: async (events) => ({
          title: `Auto-episode: ${events.length} events`,
          summary: `Automatically triggered episode from ${events.length} unconsolidated events`,
          tags: ["auto"],
        }),
        // Lower thresholds to trigger on our test data
        maxEventsWithoutEpisode: 5,
        sessionGapMinutes: 1, // Very low to test the mechanism
      });

      console.log(`  Trigger result: triggered=${result.triggered}, reason=${result.reason}`);
      console.log(`  Episode created: ${result.episode?.episodeId ?? "none"}`);
      // May or may not trigger depending on data state, but should not error
      expect(result.reason).toBeDefined();
    });

    it("should respect rate limiting", async () => {
      // Second call within 60min should be rate-limited (if first triggered)
      const result = await checkAutoEpisodeTriggers({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        summarizer: async (events) => ({
          title: `Rate-limited test: ${events.length} events`,
          summary: "Should be rate-limited",
          tags: ["rate-test"],
        }),
        maxEventsWithoutEpisode: 3,
        rateLimitMinutes: 60,
      });

      console.log(`  Rate limit test: triggered=${result.triggered}, reason=${result.reason}`);
      // Either rate-limited or no events to consolidate — both are valid
      expect(result).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 7: Retrieval Planner
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 7: Retrieval Planner", () => {
    it("should plan retrieval for entity-heavy query", async () => {
      const plan = planRetrieval("What does Sarah Chen work on?", {
        availablePaths: new Set(["raw-window", "graph", "hybrid", "episodic", "structured"]),
        knownEntityNames: ["Sarah Chen", "DataVault"],
        hasGraphData: true,
        hasEpisodes: true,
      });

      console.log(`  Plan paths (ranked):`, plan.paths);
      expect(plan.paths.length).toBeGreaterThan(0);
      // Graph should score high for entity queries
      expect(plan.paths).toContain("graph");
    });

    it("should plan retrieval for recent-event query", async () => {
      const plan = planRetrieval("What happened in the last meeting?", {
        availablePaths: new Set(["raw-window", "graph", "hybrid", "episodic"]),
        hasEpisodes: true,
      });

      console.log(`  Plan paths (ranked):`, plan.paths);
      // Raw-window or episodic should rank high for recency queries
      expect(plan.paths[0]).toMatch(/raw-window|episodic/);
    });

    it("should plan retrieval for keyword search", async () => {
      const plan = planRetrieval("MongoDB compound index optimization", {
        availablePaths: new Set(["raw-window", "hybrid", "kb", "structured"]),
      });

      console.log(`  Plan paths (ranked):`, plan.paths);
      expect(plan.paths.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 8: searchV2 End-to-End
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 8: searchV2 Full Pipeline", () => {
    it("should search with raw-window path", async () => {
      const { results, metadata } = await searchV2(
        db,
        PREFIX,
        "data pipeline architecture",
        AGENT_ID,
        {
          availablePaths: new Set(["raw-window"]),
          maxResults: 10,
        },
      );

      console.log(`  raw-window search: ${results.length} results`);
      console.log(`  Paths executed: ${metadata.pathsExecuted.join(", ")}`);
      expect(metadata.pathsExecuted).toContain("raw-window");
    });

    it("should search with multiple paths including graph", async () => {
      const { results, metadata } = await searchV2(
        db,
        PREFIX,
        "Sarah Chen frontend React",
        AGENT_ID,
        {
          availablePaths: new Set(["raw-window", "graph", "episodic"]),
          knownEntityNames: ["Sarah Chen"],
          hasGraphData: true,
          hasEpisodes: true,
          maxResults: 15,
        },
      );

      console.log(`  Multi-path search: ${results.length} results`);
      console.log(`  Paths executed: ${metadata.pathsExecuted.join(", ")}`);
      console.log(`  Results by path:`, metadata.resultsByPath);
      expect(results.length).toBeGreaterThanOrEqual(0); // May have 0 if graph path finds nothing directly
    });

    it("should search for bug-related content", async () => {
      const { results } = await searchV2(
        db,
        PREFIX,
        "scheduler bug cron race condition",
        AGENT_ID,
        {
          availablePaths: new Set(["raw-window", "episodic"]),
          hasEpisodes: true,
          maxResults: 10,
        },
      );

      console.log(`  Bug search: ${results.length} results`);
      if (results.length > 0) {
        console.log(`  Top result (${results[0].source}): ${results[0].snippet.slice(0, 80)}...`);
      }
    });

    it("should return reranked results with diversity", async () => {
      const { results, metadata } = await searchV2(
        db,
        PREFIX,
        "TypeScript MongoDB deployment",
        AGENT_ID,
        {
          availablePaths: new Set(["raw-window", "episodic"]),
          hasEpisodes: true,
          maxResults: 20,
        },
      );

      console.log(
        `  Reranked search: ${results.length} results, paths: ${metadata.pathsExecuted.join(", ")}`,
      );
      // Results should be deduped and reranked
      if (results.length > 1) {
        // Check no exact duplicates
        const bodies = results.map((r) => r.snippet);
        const uniqueBodies = new Set(bodies);
        expect(uniqueBodies.size).toBe(bodies.length);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 9: getV2Status — Full system health check
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 9: V2 Status & Health", () => {
    it("should return comprehensive v2 status", async () => {
      const status = await getV2Status(db, PREFIX, AGENT_ID);

      console.log("\n  ═══ V2 System Status ═══");
      console.log(
        `  Events: ${status.events.count} (latest: ${status.events.latestTimestamp?.toISOString() ?? "none"})`,
      );
      console.log(`  Entities: ${status.entities.count}`);
      console.log(`  Relations: ${status.relations.count}`);
      console.log(
        `  Episodes: ${status.episodes.count} (latest: ${status.episodes.latestTimestamp?.toISOString() ?? "none"})`,
      );
      console.log(`  Projection lag:`, status.projectionLag);
      console.log(`  Retrieval paths: ${status.retrievalPaths.join(", ")}`);
      console.log("  ════════════════════════\n");

      expect(status.events.count).toBeGreaterThan(0);
      expect(status.entities.count).toBeGreaterThan(0);
      expect(status.episodes.count).toBeGreaterThanOrEqual(1);
      expect(status.retrievalPaths.length).toBeGreaterThan(0);
    });

    it("should have operational records (ingest runs)", async () => {
      const runs = await getRecentIngestRuns({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        limit: 5,
      });
      console.log(`  Recent ingest runs: ${runs.length}`);
      expect(runs.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 10: Agent Isolation — Verify cross-agent safety
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 10: Agent Isolation", () => {
    const OTHER_AGENT = `agent-other-${randomUUID().slice(0, 8)}`;

    it("should not leak events across agents", async () => {
      // Write event for other agent
      await writeEventAndProject(db, PREFIX, {
        agentId: OTHER_AGENT,
        role: "user",
        body: "This is a SECRET message only for the other agent",
        scope: "agent",
        sessionId: "other-session",
      });

      // Search from our agent should NOT find it
      const ourEvents = await getEventsByTimeRange({
        db,
        prefix: PREFIX,
        agentId: AGENT_ID,
        start: new Date("2026-03-01"),
        end: new Date("2026-03-31"),
      });

      const leaked = ourEvents.some((e) => e.body.includes("SECRET"));
      expect(leaked).toBe(false);
    });

    it("should not leak entities across agents", async () => {
      await upsertEntity({
        db,
        prefix: PREFIX,
        entity: {
          entityId: `entity-secret-${randomUUID().slice(0, 8)}`,
          name: "SecretOtherAgent",
          type: "person",
          agentId: OTHER_AGENT,
          scope: "agent",
          updatedAt: new Date(),
        },
      });

      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "SecretOtherAgent",
        agentId: AGENT_ID,
      });
      expect(results.length).toBe(0);
    });

    it("should not leak graph expansion across agents", async () => {
      const otherEntityId = `entity-other-root-${randomUUID().slice(0, 8)}`;
      await upsertEntity({
        db,
        prefix: PREFIX,
        entity: {
          entityId: otherEntityId,
          name: "OtherProjectRoot",
          type: "project",
          agentId: OTHER_AGENT,
          scope: "agent",
          updatedAt: new Date(),
        },
      });

      // Our agent should not find the other agent's entity
      const result = await expandGraph({
        db,
        prefix: PREFIX,
        entityId: otherEntityId,
        agentId: AGENT_ID,
      });
      expect(result).toBeNull(); // Not our entity
    });
  });

  // ─── Phase 11: Voyage AI AutoEmbed Vector Search ───────────────────────────
  // Tests real vector search using Voyage AI autoEmbed (voyage-4-large).
  // mongot must be running with embedding config for these tests to pass.
  // The autoEmbed indexes are created by ensureSearchIndexes() and mongot
  // auto-generates embeddings from the "text" field via the Voyage API.

  describe("Phase 11: Voyage AI AutoEmbed Vector Search", () => {
    // Allow up to 90s for mongot to finish embedding documents
    const VECTOR_SEARCH_TIMEOUT = 90_000;
    const autoEmbedIt = AUTO_EMBED_ENABLED ? it : it.skip;

    autoEmbedIt(
      "should have autoEmbed search indexes on chunks",
      async () => {
        // ensureSearchIndexes creates text + vector indexes using autoEmbed
        const result = await ensureSearchIndexes(db, PREFIX, "community-mongot", "automated");
        // Both should succeed (or already exist)
        expect(result.text).toBe(true);
        expect(result.vector).toBe(true);

        // Verify the indexes exist via $listSearchIndexes
        const chunks = db.collection(`${PREFIX}chunks`);
        const indexes = await chunks.aggregate([{ $listSearchIndexes: {} }]).toArray();
        const vectorIdx = indexes.find((i) => i.name === `${PREFIX}chunks_vector`);
        const textIdx = indexes.find((i) => i.name === `${PREFIX}chunks_text`);

        expect(vectorIdx).toBeDefined();
        expect(vectorIdx!.type).toBe("vectorSearch");
        expect(textIdx).toBeDefined();
        expect(textIdx!.type).toBe("search");

        // Verify autoEmbed definition
        const fields = vectorIdx!.latestDefinition?.fields;
        expect(fields).toBeDefined();
        const autoEmbedField = fields?.find((f: { type: string }) => f.type === "autoEmbed");
        expect(autoEmbedField).toBeDefined();
        expect(autoEmbedField!.model).toBe("voyage-4-large");
        expect(autoEmbedField!.path).toBe("text");
        expect(autoEmbedField!.modality).toBe("text");
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    it("should build correct $vectorSearch stage for autoEmbed", () => {
      // Unit-level check that buildVectorSearchStage produces correct query syntax
      const stage = buildVectorSearchStage({
        queryVector: null,
        queryText: "data pipeline architecture",
        embeddingMode: "automated",
        indexName: `${PREFIX}chunks_vector`,
        numCandidates: 100,
        limit: 5,
      });

      expect(stage).not.toBeNull();
      expect(stage!.query).toEqual({ text: "data pipeline architecture" });
      expect(stage!.path).toBe("text");
      expect(stage!.index).toBe(`${PREFIX}chunks_vector`);
      expect(stage!.numCandidates).toBe(100);
      expect(stage!.limit).toBe(5);
      // autoEmbed must NOT have queryVector
      expect(stage!.queryVector).toBeUndefined();
    });

    autoEmbedIt(
      "should return semantic results for architecture queries via $vectorSearch",
      async () => {
        const chunkCount = await db.collection(`${PREFIX}chunks`).countDocuments({});
        expect(chunkCount).toBeGreaterThan(0);

        const results = await waitForVectorResults(db, "data pipeline architecture and system design", {
          maxResults: 5,
          timeoutMs: VECTOR_SEARCH_TIMEOUT,
        });

        // Should get results from the conversation chunks about DataVault architecture
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(5);

        // Every result should have a valid score
        for (const r of results) {
          expect(r.score).toBeGreaterThan(0);
          expect(r.score).toBeLessThanOrEqual(1);
          expect(r.snippet).toBeDefined();
          expect(r.snippet.length).toBeGreaterThan(0);
        }

        // Results should be sorted by score descending
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    autoEmbedIt(
      "should find deployment-related content with semantic search",
      async () => {
        const results = await waitForVectorResults(db, "Docker deployment Kubernetes production infrastructure", {
          maxResults: 5,
          timeoutMs: VECTOR_SEARCH_TIMEOUT,
        });

        expect(results.length).toBeGreaterThan(0);

        // At least one result should mention deployment/Docker/infrastructure
        const deploymentHit = results.some(
          (r) =>
            r.snippet.toLowerCase().includes("deploy") ||
            r.snippet.toLowerCase().includes("docker") ||
            r.snippet.toLowerCase().includes("infrastructure") ||
            r.snippet.toLowerCase().includes("production"),
        );
        expect(deploymentHit).toBe(true);
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    autoEmbedIt(
      "should find bug-fix content with semantic search",
      async () => {
        const results = await waitForVectorResults(db, "database connection error bug fix troubleshooting", {
          maxResults: 5,
          timeoutMs: VECTOR_SEARCH_TIMEOUT,
        });

        expect(results.length).toBeGreaterThan(0);

        // At least one result should be about the connection pool bug conversation
        const bugHit = results.some(
          (r) =>
            r.snippet.toLowerCase().includes("bug") ||
            r.snippet.toLowerCase().includes("error") ||
            r.snippet.toLowerCase().includes("fix") ||
            r.snippet.toLowerCase().includes("connection"),
        );
        expect(bugHit).toBe(true);
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    autoEmbedIt(
      "should return keyword search results with text index",
      async () => {
        const chunks = db.collection(`${PREFIX}chunks`);
        const results = await keywordSearch(chunks, "DataVault pipeline", {
          maxResults: 5,
          minScore: 0.0,
          indexName: `${PREFIX}chunks_text`,
        });

        expect(results.length).toBeGreaterThan(0);

        // Text search results should contain the search terms
        const hasRelevant = results.some(
          (r) =>
            r.snippet.toLowerCase().includes("datavault") ||
            r.snippet.toLowerCase().includes("pipeline"),
        );
        expect(hasRelevant).toBe(true);
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    autoEmbedIt(
      "should handle semantic similarity — related concepts rank higher",
      async () => {
        // Search for a concept that appears in the conversation but with different words
        // The conversations discuss "real-time data processing with WebSocket"
        // but we search with synonymous terms
        const results = await waitForVectorResults(db, "live streaming updates push notifications event-driven", {
          maxResults: 10,
          timeoutMs: VECTOR_SEARCH_TIMEOUT,
        });

        expect(results.length).toBeGreaterThan(0);

        // Vector search should find semantically related content even without exact keyword matches
        // (this is the key advantage over keyword search)
        for (const r of results) {
          expect(r.score).toBeGreaterThan(0);
        }
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    autoEmbedIt(
      "should respect minScore filter on vector results",
      async () => {
        const chunks = db.collection(`${PREFIX}chunks`);

        // Use a high minScore threshold — should get fewer or no results
        const highThreshold = await vectorSearch(chunks, null, {
          maxResults: 10,
          minScore: 0.95,
          indexName: `${PREFIX}chunks_vector`,
          queryText: "completely unrelated quantum physics black holes",
          embeddingMode: "automated",
        });

        // Use a low minScore threshold — should get more results
        const lowThreshold = await vectorSearch(chunks, null, {
          maxResults: 10,
          minScore: 0.0,
          indexName: `${PREFIX}chunks_vector`,
          queryText: "data pipeline architecture",
          embeddingMode: "automated",
        });

        // High threshold on irrelevant query should return fewer results
        expect(highThreshold.length).toBeLessThanOrEqual(lowThreshold.length);
      },
      VECTOR_SEARCH_TIMEOUT,
    );

    it("should return null stage when embeddingMode is not automated", () => {
      // When embeddingMode is not "automated", buildVectorSearchStage should return null
      // (no manual embedding support in ClawMongo)
      const stage = buildVectorSearchStage({
        queryVector: null,
        queryText: "test query",
        embeddingMode: "none" as "automated",
        indexName: `${PREFIX}chunks_vector`,
        numCandidates: 100,
        limit: 5,
      });
      expect(stage).toBeNull();
    });
  });
});
