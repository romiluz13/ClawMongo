import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import type { OpenClawConfig } from "../config/config.js";
import { materializeEpisode } from "./mongodb-episodes.js";
import { getEventsBySession, writeEvent } from "./mongodb-events.js";
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
    const searchStatus = manager.status().custom as
      | {
          searchMode?: string;
          searchModeDetails?: { pathsExecuted?: string[] };
        }
      | undefined;
    expect(searchStatus?.searchMode).toBe("v2");
    expect(searchStatus?.searchModeDetails?.pathsExecuted?.length ?? 0).toBeGreaterThan(0);

    const transcriptDir = path.join(workspaceDir, "sessions");
    const transcriptExists = await fs
      .access(transcriptDir)
      .then(() => true)
      .catch(() => false);
    expect(transcriptExists).toBe(false);
  }, 45_000);

  it("preserves event chunks across bridge-note sync and supports exact bridge reads", async () => {
    const localWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-bridge-sync-"));
    const localAgentId = "main";
    const localPrefix = `runtime_${randomUUID().slice(0, 8)}_`;
    const baseMongoConfig = cfg.memory?.mongodb;
    if (!baseMongoConfig) {
      throw new Error("expected MongoDB memory config");
    }
    const localCfg: OpenClawConfig = {
      ...cfg,
      agents: {
        defaults: {
          ...cfg.agents?.defaults,
          workspace: localWorkspace,
          memorySearch: cfg.agents?.defaults?.memorySearch,
        },
      },
      memory: {
        ...cfg.memory,
        mongodb: {
          ...baseMongoConfig,
          collectionPrefix: localPrefix,
        },
      },
    };

    const { manager, error } = await getMemorySearchManager({
      cfg: localCfg,
      agentId: localAgentId,
    });
    expect(error).toBeUndefined();
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("expected MongoDB memory manager");
    }

    const writableManager = manager as typeof manager & {
      sync?: (params?: { reason?: string; force?: boolean }) => Promise<void>;
    };

    const sessionManager = guardSessionManager(SessionManager.inMemory(), {
      cfg: localCfg,
      agentId: localAgentId,
      sessionId: `bridge-sync-${randomUUID().slice(0, 8)}`,
    });
    const liveMarker = `live-marker-${randomUUID().slice(0, 8)}`;
    const bridgeMarker = `bridge-marker-${randomUUID().slice(0, 8)}`;

    sessionManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: `Keep ${liveMarker} in canonical runtime memory.`,
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Confirmed ${liveMarker}.` }],
        timestamp: Date.now(),
        stopReason: "stop",
      }),
    );
    await sessionManager.flushPendingPersistedWrites?.();

    await fs.mkdir(path.join(localWorkspace, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(localWorkspace, "memory", "bridge.md"),
      `# Bridge\n\nThis bridge note stores ${bridgeMarker} for operator context.\n`,
      "utf-8",
    );

    await writableManager.sync?.({ reason: "test", force: true });

    const liveResults = await manager.search(liveMarker, { maxResults: 5, minScore: 0 });
    expect(liveResults.some((result) => result.path.startsWith("events/"))).toBe(true);

    const bridgeResults = await manager.search(bridgeMarker, { maxResults: 5, minScore: 0 });
    expect(bridgeResults.some((result) => result.path === "memory/bridge.md")).toBe(true);
    const bridgeSearchStatus = manager.status().custom as
      | {
          searchMode?: string;
          searchModeDetails?: { resultsByPath?: Record<string, number> };
        }
      | undefined;
    expect(bridgeSearchStatus?.searchMode).toBe("v2");
    expect(bridgeSearchStatus?.searchModeDetails?.resultsByPath).toBeTruthy();

    const bridgeRead = await manager.readFile({ relPath: "memory/bridge.md" });
    expect(bridgeRead.text).toContain(bridgeMarker);

    const eventChunks = await chunksCollection(db, localPrefix)
      .find({ agentId: localAgentId, source: "conversation" })
      .toArray();
    expect(eventChunks.some((chunk) => String(chunk.path).startsWith("events/"))).toBe(true);

    await fs.rm(localWorkspace, { recursive: true, force: true }).catch(() => {});
  }, 45_000);

  it("reads episode locators as compact summaries and can expand them back to canonical events", async () => {
    const sessionId = `episode-session-${randomUUID().slice(0, 8)}`;
    const episodeMarker = `episode-marker-${randomUUID().slice(0, 8)}`;

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
        content: `We should summarize ${episodeMarker} as a runtime-memory milestone.`,
        timestamp: Date.now(),
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Acknowledged ${episodeMarker}; I will keep the milestone in canonical events.`,
          },
        ],
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
    expect(events).toHaveLength(2);

    const episode = await materializeEpisode({
      db,
      prefix,
      agentId,
      type: "thread",
      scope: "agent",
      timeRange: {
        start: new Date(events[0].timestamp.getTime() - 1_000),
        end: new Date(events[events.length - 1].timestamp.getTime() + 1_000),
      },
      summarizer: async () => ({
        title: "Runtime summary locator",
        summary: `Summary for ${episodeMarker}`,
        tags: ["runtime", "summary"],
      }),
    });
    expect(episode?.episodeId).toBeDefined();

    const compactRead = await manager.readFile({ relPath: `episode:${episode!.episodeId}` });
    expect(compactRead.text).toContain(`summary: Summary for ${episodeMarker}`);
    expect(compactRead.text).toContain(
      `expandLocator: episode:${episode!.episodeId}?expand=events`,
    );
    expect(compactRead.text).not.toContain("sourceEvents:");

    const expandedRead = await manager.readFile({
      relPath: `episode:${episode!.episodeId}?expand=events`,
    });
    expect(expandedRead.text).toContain("sourceEvents:");
    expect(expandedRead.text).toContain(`user: We should summarize ${episodeMarker}`);
    expect(expandedRead.text).toContain(
      `assistant: Acknowledged ${episodeMarker}; I will keep the milestone in canonical events.`,
    );
  }, 45_000);

  it("recalls and reopens recent canonical events even when chunk projection has not happened yet", async () => {
    const recentMarker = `recent-marker-${randomUUID().slice(0, 8)}`;

    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    expect(error).toBeUndefined();
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("expected MongoDB memory manager");
    }

    const written = await writeEvent({
      db,
      prefix,
      event: {
        agentId,
        role: "user",
        body: `Please remember ${recentMarker} from the event-only freshness path.`,
        scope: "agent",
      },
    });

    const projectedChunk = await chunksCollection(db, prefix).findOne({
      path: `events/${written.eventId}`,
    });
    expect(projectedChunk).toBeNull();

    const results = await manager.search(`what did I say recently about ${recentMarker}`, {
      maxResults: 5,
      minScore: 0,
    });
    expect(results.some((result) => result.path === `events/${written.eventId}`)).toBe(true);
    expect(results.some((result) => result.snippet.includes(recentMarker))).toBe(true);

    const exactRead = await manager.readFile({ relPath: `events/${written.eventId}` });
    expect(exactRead.text).toContain(
      `user: Please remember ${recentMarker} from the event-only freshness path.`,
    );
    expect(exactRead.type).toBe("event");
  }, 45_000);

  it("keeps bridge imports isolated across agents and workspaces sharing one MongoDB collection set", async () => {
    const sharedPrefix = `runtime_${randomUUID().slice(0, 8)}_`;
    const workspaceA = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-workspace-a-"));
    const workspaceB = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-workspace-b-"));
    const agentA = `runtime-agent-a-${randomUUID().slice(0, 6)}`;
    const agentB = `runtime-agent-b-${randomUUID().slice(0, 6)}`;
    const markerA = `workspace-a-${randomUUID().slice(0, 8)}`;
    const markerB = `workspace-b-${randomUUID().slice(0, 8)}`;
    const baseMongoConfig = cfg.memory?.mongodb;
    if (!baseMongoConfig) {
      throw new Error("expected MongoDB memory config");
    }

    const makeCfg = (workspace: string): OpenClawConfig => ({
      ...cfg,
      agents: {
        defaults: {
          ...cfg.agents?.defaults,
          workspace,
          memorySearch: cfg.agents?.defaults?.memorySearch,
        },
        list: [
          { id: agentA, workspace: workspaceA },
          { id: agentB, workspace: workspaceB },
        ],
      },
      memory: {
        ...cfg.memory,
        mongodb: {
          ...baseMongoConfig,
          collectionPrefix: sharedPrefix,
        },
      },
    });

    await fs.writeFile(
      path.join(workspaceA, "MEMORY.md"),
      `Workspace A note ${markerA}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceB, "MEMORY.md"),
      `Workspace B note ${markerB}\n`,
      "utf-8",
    );

    const { manager: managerA } = await getMemorySearchManager({
      cfg: makeCfg(workspaceA),
      agentId: agentA,
    });
    const { manager: managerB } = await getMemorySearchManager({
      cfg: makeCfg(workspaceB),
      agentId: agentB,
    });
    expect(managerA).toBeTruthy();
    expect(managerB).toBeTruthy();
    if (!managerA || !managerB) {
      throw new Error("expected both MongoDB managers");
    }

    await (
      managerA as typeof managerA & {
        sync?: (params?: { reason?: string; force?: boolean }) => Promise<void>;
      }
    ).sync?.({
      reason: "test",
      force: true,
    });
    await (
      managerB as typeof managerB & {
        sync?: (params?: { reason?: string; force?: boolean }) => Promise<void>;
      }
    ).sync?.({
      reason: "test",
      force: true,
    });

    const resultsA = await managerA.search(markerA, { maxResults: 5, minScore: 0 });
    const resultsB = await managerB.search(markerB, { maxResults: 5, minScore: 0 });
    const leakIntoA = await managerA.search(markerB, { maxResults: 5, minScore: 0 });
    const leakIntoB = await managerB.search(markerA, { maxResults: 5, minScore: 0 });

    expect(resultsA.some((result) => result.path === "MEMORY.md")).toBe(true);
    expect(resultsB.some((result) => result.path === "MEMORY.md")).toBe(true);
    expect(leakIntoA.some((result) => result.snippet.includes(markerB))).toBe(false);
    expect(leakIntoB.some((result) => result.snippet.includes(markerA))).toBe(false);

    await fs.rm(workspaceA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceB, { recursive: true, force: true }).catch(() => {});
  }, 45_000);

  it("reads scope-qualified structured memory locators without crossing namespaces", async () => {
    const localWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-structured-read-"));
    const localAgentId = "main";
    const localPrefix = `runtime_${randomUUID().slice(0, 8)}_`;
    const baseMongoConfig = cfg.memory?.mongodb;
    if (!baseMongoConfig) {
      throw new Error("expected MongoDB memory config");
    }
    const localCfg: OpenClawConfig = {
      ...cfg,
      agents: {
        defaults: {
          ...cfg.agents?.defaults,
          workspace: localWorkspace,
          memorySearch: cfg.agents?.defaults?.memorySearch,
        },
      },
      memory: {
        ...cfg.memory,
        mongodb: {
          ...baseMongoConfig,
          collectionPrefix: localPrefix,
        },
      },
    };

    const { manager, error } = await getMemorySearchManager({
      cfg: localCfg,
      agentId: localAgentId,
    });
    expect(error).toBeUndefined();
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("expected MongoDB memory manager");
    }

    const structuredManager = manager as typeof manager & {
      writeStructuredMemory?: (entry: {
        type: "decision";
        key: string;
        value: string;
        agentId: string;
        scope: "agent" | "session";
        sessionId?: string;
      }) => Promise<unknown>;
    };
    expect(typeof structuredManager.writeStructuredMemory).toBe("function");

    const sharedKey = `shared-key-${randomUUID().slice(0, 8)}`;
    const sessionId = `structured-session-${randomUUID().slice(0, 8)}`;
    await structuredManager.writeStructuredMemory?.({
      type: "decision",
      key: sharedKey,
      value: "Agent scoped decision",
      agentId: localAgentId,
      scope: "agent",
    });
    await structuredManager.writeStructuredMemory?.({
      type: "decision",
      key: sharedKey,
      value: "Session scoped decision",
      agentId: localAgentId,
      scope: "session",
      sessionId,
    });

    const structuredHits = await manager.search("scoped decision", { maxResults: 10, minScore: 0 });
    const structuredPaths = structuredHits
      .filter((result) => result.source === "structured")
      .map((result) => result.path);

    expect(structuredPaths.some((path) => path.includes("scope=agent"))).toBe(true);
    expect(structuredPaths.some((path) => path.includes("scope=session"))).toBe(true);

    const agentLocator = structuredPaths.find((path) => path.includes("scope=agent"));
    const sessionLocator = structuredPaths.find((path) => path.includes("scope=session"));
    expect(agentLocator).toBeDefined();
    expect(sessionLocator).toBeDefined();

    const agentRead = await manager.readFile({ relPath: agentLocator! });
    const sessionRead = await manager.readFile({ relPath: sessionLocator! });
    expect(agentRead.text).toContain("Agent scoped decision");
    expect(sessionRead.text).toContain("Session scoped decision");

    await fs.rm(localWorkspace, { recursive: true, force: true }).catch(() => {});
  }, 45_000);
});
