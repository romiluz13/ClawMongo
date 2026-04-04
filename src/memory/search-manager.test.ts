import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMongoDBConfig } from "./backend-config.js";
import { buildMongoDBCacheKey } from "./search-manager.js";

/**
 * Minimal resolved config factory for cache key tests.
 * Only fields relevant to cache key differentiation are varied;
 * the rest are stable defaults.
 */
function makeConfig(overrides?: Partial<ResolvedMongoDBConfig>): ResolvedMongoDBConfig {
  return {
    uri: "mongodb://localhost:27017",
    database: "test",
    collectionPrefix: "mem_",
    deploymentProfile: "community-mongot",
    embeddingMode: "automated",
    fusionMethod: "scoreFusion",
    quantization: "none",
    watchDebounceMs: 500,
    numDimensions: 1024,
    maxPoolSize: 10,
    minPoolSize: 1,
    embeddingCacheTtlDays: 7,
    memoryTtlDays: 90,
    enableChangeStreams: false,
    changeStreamDebounceMs: 500,
    connectTimeoutMs: 5000,
    numCandidates: 100,
    maxSessionChunks: 50,
    kb: {
      enabled: true,
      chunking: { tokens: 512, overlap: 50 },
      autoImportPaths: [],
      maxDocumentSize: 1_000_000,
      autoRefreshHours: 24,
    },
    relevance: {
      enabled: false,
      telemetry: {
        enabled: false,
        baseSampleRate: 0,
        adaptive: { enabled: false, maxSampleRate: 0, minWindowSize: 0 },
        persistRawExplain: false,
        queryPrivacyMode: "none",
      },
      retention: { days: 30 },
      benchmark: { enabled: false, datasetPath: "" },
    },
    episodes: { enabled: false, minEventsForEpisode: 10 },
    graph: {
      enabled: false,
      maxGraphDepth: 2,
      entityExtraction: { method: "regex" as const, model: undefined, timeoutMs: 5000 },
    },
    queryRewriting: { enabled: false, method: "synonym-expansion" as const, maxTokens: 128 },
    reranking: {
      enabled: false,
      model: "rerank-2.5" as const,
      topN: 20,
      minScore: 0.1,
      voyageApiKey: "",
    },
    cache: { enabled: true, conversationTtlSec: 300, kbTtlSec: 3600, similarityThreshold: 0.95 },
    enableContiguousMerge: true,
    enableContextExpansion: true,
    enableConversationWindows: false,
    conversationWindowSize: 7,
    conversationWindowOverlap: 2,
    sources: {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: true },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("buildMongoDBCacheKey", () => {
  it("different source policies produce different cache keys", () => {
    const allEnabled = makeConfig({
      sources: {
        reference: { enabled: true },
        conversation: { enabled: true },
        structured: { enabled: true },
      },
    });
    const structuredDisabled = makeConfig({
      sources: {
        reference: { enabled: true },
        conversation: { enabled: true },
        structured: { enabled: false },
      },
    });

    const key1 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config: allEnabled,
      workspaceDir: "/tmp/workspace-a",
    });
    const key2 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config: structuredDisabled,
      workspaceDir: "/tmp/workspace-a",
    });

    expect(key1).not.toBe(key2);
  });

  it("same config produces same cache key (stability)", () => {
    const config = makeConfig();
    const key1 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-a",
    });
    const key2 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-a",
    });

    expect(key1).toBe(key2);
  });

  it("different agentIds produce different cache keys", () => {
    const config = makeConfig();
    const key1 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-a",
    });
    const key2 = buildMongoDBCacheKey({
      agentId: "agent-2",
      config,
      workspaceDir: "/tmp/workspace-a",
    });

    expect(key1).not.toBe(key2);
  });

  it("cache key changes when conversation source is toggled", () => {
    const enabled = makeConfig({
      sources: {
        reference: { enabled: true },
        conversation: { enabled: true },
        structured: { enabled: true },
      },
    });
    const disabled = makeConfig({
      sources: {
        reference: { enabled: true },
        conversation: { enabled: false },
        structured: { enabled: true },
      },
    });

    const key1 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config: enabled,
      workspaceDir: "/tmp/workspace-a",
    });
    const key2 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config: disabled,
      workspaceDir: "/tmp/workspace-a",
    });

    expect(key1).not.toBe(key2);
  });

  it("cache key changes when workspace changes for the same agent and config", () => {
    const config = makeConfig();

    const key1 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-a",
    });
    const key2 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-b",
    });

    expect(key1).not.toBe(key2);
  });

  it("cache key changes when normalized extra memory paths change", () => {
    const config = makeConfig();

    const key1 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-a",
      extraMemoryPaths: ["/tmp/workspace-a/memory/extra.md"],
    });
    const key2 = buildMongoDBCacheKey({
      agentId: "agent-1",
      config,
      workspaceDir: "/tmp/workspace-a",
      extraMemoryPaths: ["/tmp/workspace-a/memory/extra.md", "/tmp/shared/notes.md"],
    });

    expect(key1).not.toBe(key2);
  });

  it("deduplicates concurrent MongoDB manager initialization for the same cache key", async () => {
    const createMock = vi.fn(async () => ({
      close: vi.fn(),
    }));

    vi.doMock("../agents/agent-scope.js", () => ({
      resolveAgentWorkspaceDir: () => "/tmp/workspace-a",
    }));
    vi.doMock("../agents/memory-search.js", () => ({
      resolveMemorySearchConfig: () => undefined,
    }));
    vi.doMock("./backend-config.js", () => ({
      resolveMemoryBackendConfig: () => ({
        mongodb: makeConfig(),
      }),
    }));
    vi.doMock("./internal.js", () => ({
      normalizeExtraMemoryPaths: () => [],
    }));
    vi.doMock("./mongodb-manager.js", () => ({
      MongoDBMemoryManager: {
        create: createMock,
      },
    }));

    const { closeAllMemorySearchManagers, getMemorySearchManager } =
      await import("./search-manager.js");
    const cfg = {} as never;

    const [first, second] = await Promise.all([
      getMemorySearchManager({ cfg, agentId: "main" }),
      getMemorySearchManager({ cfg, agentId: "main" }),
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(first.manager).toBeTruthy();
    expect(first.manager).toBe(second.manager);

    await closeAllMemorySearchManagers();
  });
});
