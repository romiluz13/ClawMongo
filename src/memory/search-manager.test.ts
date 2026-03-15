import { describe, expect, it } from "vitest";
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
    runtimeMode: "mongo_canonical",
    episodes: { enabled: false, minEventsForEpisode: 10 },
    graph: { enabled: false, maxGraphDepth: 2 },
    sources: {
      reference: { enabled: true },
      conversation: { enabled: true },
      structured: { enabled: true },
    },
    ...overrides,
  };
}

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

    const key1 = buildMongoDBCacheKey("agent-1", allEnabled);
    const key2 = buildMongoDBCacheKey("agent-1", structuredDisabled);

    expect(key1).not.toBe(key2);
  });

  it("same config produces same cache key (stability)", () => {
    const config = makeConfig();
    const key1 = buildMongoDBCacheKey("agent-1", config);
    const key2 = buildMongoDBCacheKey("agent-1", config);

    expect(key1).toBe(key2);
  });

  it("different agentIds produce different cache keys", () => {
    const config = makeConfig();
    const key1 = buildMongoDBCacheKey("agent-1", config);
    const key2 = buildMongoDBCacheKey("agent-2", config);

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

    const key1 = buildMongoDBCacheKey("agent-1", enabled);
    const key2 = buildMongoDBCacheKey("agent-1", disabled);

    expect(key1).not.toBe(key2);
  });
});
