import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import type { OpenClawConfig } from "../config/config.js";
import { getEventsBySession } from "./mongodb-events.js";
import { chunksCollection } from "./mongodb-schema.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./search-manager.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const TEST_URI =
  process.env.MONGODB_TEST_URI ||
  "mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true";
const TEST_DB = "clawmongo_runtime_e2e";

const asAppendMessage = (message: unknown) => message as AppendMessage;

describe("MongoDB runtime write e2e", () => {
  let client: MongoClient;
  let db: Db;
  let workspaceDir: string;
  let cfg: OpenClawConfig;
  let agentId: string;
  let prefix: string;

  beforeAll(async () => {
    client = new MongoClient(TEST_URI, {
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    db = client.db(TEST_DB);

    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-runtime-e2e-"));
    agentId = `runtime-e2e-${randomUUID().slice(0, 8)}`;
    prefix = `runtime_${randomUUID().slice(0, 8)}_`;

    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            enabled: true,
            experimental: { sessionMemory: true },
            sync: {
              onSessionStart: false,
              onSearch: true,
              watch: false,
            },
            query: {
              maxResults: 6,
              minScore: 0,
            },
          },
        },
      },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: TEST_URI,
          database: TEST_DB,
          collectionPrefix: prefix,
          deploymentProfile: "community-mongot",
          embeddingMode: "automated",
          connectTimeoutMs: 5_000,
          numCandidates: 100,
        },
      },
    };
  }, 30_000);

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    if (db) {
      const collections = await db.listCollections().toArray();
      for (const collection of collections) {
        if (collection.name.startsWith(prefix)) {
          await db
            .collection(collection.name)
            .drop()
            .catch(() => {});
        }
      }
    }
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await client?.close();
  });

  it("persists live session messages into canonical events and searchable chunks without transcript sync", async () => {
    const sessionId = `runtime-session-${randomUUID().slice(0, 8)}`;
    const marker = `runtime-write-marker-${randomUUID().slice(0, 8)}`;

    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    expect(error).toBeUndefined();
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("expected MongoDB memory manager");
    }

    const sessionManager = guardSessionManager(SessionManager.inMemory(), {
      cfg,
      agentId,
      sessionId,
    });

    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: `Remember ${marker} as the live runtime pipeline marker.`,
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Stored ${marker} in the runtime memory path.` }],
        timestamp: Date.now(),
        stopReason: "stop",
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: `tool saw ${marker} in live runtime write e2e` }],
        isError: false,
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Final answer confirms ${marker}.` }],
        timestamp: Date.now(),
        stopReason: "stop",
      }),
    );

    await sessionManager.flushPendingPersistedWrites?.();

    const events = await getEventsBySession({
      db,
      prefix,
      agentId,
      sessionId,
    });
    expect(events.map((event) => event.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    const chunkDocs = await chunksCollection(db, prefix)
      .find({ agentId, source: "conversation" })
      .toArray();
    expect(chunkDocs).toHaveLength(4);
    expect(chunkDocs.every((chunk) => chunk.path.startsWith("events/"))).toBe(true);

    const results = await manager.search(marker, { maxResults: 5, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.path.startsWith("events/"))).toBe(true);
    expect(results.some((result) => result.snippet.includes(marker))).toBe(true);

    const transcriptDir = path.join(workspaceDir, "sessions");
    const transcriptExists = await fs
      .access(transcriptDir)
      .then(() => true)
      .catch(() => false);
    expect(transcriptExists).toBe(false);
  }, 45_000);
});
