import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("resolveMemoryBackendConfig", () => {
  it("defaults to mongodb backend when config missing and env URI is set", () => {
    vi.stubEnv("OPENCLAW_MONGODB_URI", "mongodb://env-default:27017/openclaw");
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("mongodb");
    expect(resolved.citations).toBe("auto");
    expect(resolved.mongodb?.uri).toBe("mongodb://env-default:27017/openclaw");
    vi.unstubAllEnvs();
  });

  it("rejects unsupported non-mongodb backends", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: { backend: "custom" as never },
    } as unknown as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /Unsupported memory\.backend "custom"/,
    );
  });

  // ---------------------------------------------------------------------------
  // MongoDB backend tests
  // ---------------------------------------------------------------------------

  it("resolves mongodb backend with all defaults", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("mongodb");
    expect(resolved.mongodb).toBeDefined();
    expect(resolved.mongodb!.uri).toBe("mongodb://localhost:27017");
    expect(resolved.mongodb!.database).toBe("openclaw");
    expect(resolved.mongodb!.collectionPrefix).toBe("openclaw_main_");
    expect(resolved.mongodb!.deploymentProfile).toBe("community-mongot");
    expect(resolved.mongodb!.embeddingMode).toBe("automated");
    expect(resolved.mongodb!.fusionMethod).toBe("scoreFusion");
    expect(resolved.mongodb!.quantization).toBe("none");
    expect(resolved.mongodb!.relevance.enabled).toBe(true);
    expect(resolved.mongodb!.relevance.telemetry.enabled).toBe(true);
    expect(resolved.mongodb!.relevance.telemetry.baseSampleRate).toBe(0.01);
    expect(resolved.mongodb!.relevance.telemetry.adaptive.enabled).toBe(true);
    expect(resolved.mongodb!.relevance.telemetry.adaptive.maxSampleRate).toBe(0.1);
    expect(resolved.mongodb!.relevance.telemetry.adaptive.minWindowSize).toBe(200);
    expect(resolved.mongodb!.relevance.telemetry.persistRawExplain).toBe(true);
    expect(resolved.mongodb!.relevance.telemetry.queryPrivacyMode).toBe("redacted-hash");
    expect(resolved.mongodb!.relevance.retention.days).toBe(14);
    expect(resolved.mongodb!.relevance.benchmark.enabled).toBe(true);
    expect(resolved.mongodb!.relevance.benchmark.datasetPath).toContain(
      ".openclaw/relevance/golden.jsonl",
    );
  });

  it("resolves mongodb with custom config values", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          database: "mydb",
          collectionPrefix: "custom_",
          deploymentProfile: "community-mongot",
          embeddingMode: "automated",
          fusionMethod: "rankFusion",
          quantization: "scalar",
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.uri).toBe("mongodb://localhost:27017");
    expect(resolved.mongodb!.database).toBe("mydb");
    expect(resolved.mongodb!.collectionPrefix).toBe("custom_");
    expect(resolved.mongodb!.deploymentProfile).toBe("community-mongot");
    expect(resolved.mongodb!.embeddingMode).toBe("automated");
    expect(resolved.mongodb!.fusionMethod).toBe("rankFusion");
    expect(resolved.mongodb!.quantization).toBe("scalar");
  });

  it("resolves mongodb relevance config overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb+srv://atlas.example.com",
          relevance: {
            enabled: false,
            telemetry: {
              enabled: true,
              baseSampleRate: 0.05,
              adaptive: {
                enabled: true,
                maxSampleRate: 0.2,
                minWindowSize: 500,
              },
              persistRawExplain: false,
              queryPrivacyMode: "raw",
            },
            retention: { days: 21 },
            benchmark: {
              enabled: false,
              datasetPath: "~/datasets/relevance-golden.jsonl",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.relevance.enabled).toBe(false);
    expect(resolved.mongodb!.relevance.telemetry.enabled).toBe(true);
    expect(resolved.mongodb!.relevance.telemetry.baseSampleRate).toBe(0.05);
    expect(resolved.mongodb!.relevance.telemetry.adaptive.enabled).toBe(true);
    expect(resolved.mongodb!.relevance.telemetry.adaptive.maxSampleRate).toBe(0.2);
    expect(resolved.mongodb!.relevance.telemetry.adaptive.minWindowSize).toBe(500);
    expect(resolved.mongodb!.relevance.telemetry.persistRawExplain).toBe(false);
    expect(resolved.mongodb!.relevance.telemetry.queryPrivacyMode).toBe("raw");
    expect(resolved.mongodb!.relevance.retention.days).toBe(21);
    expect(resolved.mongodb!.relevance.benchmark.enabled).toBe(false);
    expect(resolved.mongodb!.relevance.benchmark.datasetPath).toContain(
      "datasets/relevance-golden.jsonl",
    );
  });

  it("resolves mongodb URI from OPENCLAW_MONGODB_URI env var", () => {
    vi.stubEnv("OPENCLAW_MONGODB_URI", "mongodb://from-env:27017");
    try {
      const cfg = {
        agents: { defaults: { workspace: "/tmp/memory-test" } },
        memory: {
          backend: "mongodb",
          mongodb: {},
        },
      } as OpenClawConfig;
      const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
      expect(resolved.mongodb!.uri).toBe("mongodb://from-env:27017");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves numDimensions with default 1024", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.numDimensions).toBe(1024);
  });

  it("resolves custom numDimensions", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", numDimensions: 768 },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.numDimensions).toBe(768);
  });

  it("resolves maxPoolSize with default 10", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.maxPoolSize).toBe(10);
  });

  it("resolves custom maxPoolSize", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", maxPoolSize: 20 },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.maxPoolSize).toBe(20);
  });

  it("resolves embeddingCacheTtlDays with default 30", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.embeddingCacheTtlDays).toBe(30);
  });

  it("resolves custom embeddingCacheTtlDays", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", embeddingCacheTtlDays: 7 },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.embeddingCacheTtlDays).toBe(7);
  });

  it("resolves memoryTtlDays with default 0 (disabled)", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.memoryTtlDays).toBe(0);
  });

  it("resolves enableChangeStreams with default false", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.enableChangeStreams).toBe(false);
  });

  it("resolves enableChangeStreams when true", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", enableChangeStreams: true },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.enableChangeStreams).toBe(true);
  });

  it("resolves changeStreamDebounceMs with default 1000", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.changeStreamDebounceMs).toBe(1000);
  });

  it("defaults embeddingMode to automated for community-mongot profile", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          deploymentProfile: "community-mongot",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.embeddingMode).toBe("automated");
  });

  it("rejects unsupported community-bare profile", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          deploymentProfile: "community-bare",
        },
      },
    } as unknown as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /deploymentProfile "community-bare" is not supported/,
    );
  });

  it("rejects unsupported atlas profile", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          deploymentProfile: "atlas-m0",
        },
      },
    } as unknown as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /deploymentProfile "atlas-m0" is not supported/,
    );
  });

  it("rejects unsupported managed embedding mode", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          deploymentProfile: "community-mongot",
          embeddingMode: "managed",
        },
      },
    } as unknown as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /embeddingMode "managed" is not supported/,
    );
  });

  it("caps numCandidates at 10000 in config resolution (F1)", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          numCandidates: 15000,
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.numCandidates).toBe(10000);
  });

  it("defaults fusionMethod to scoreFusion (F8)", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.fusionMethod).toBe("scoreFusion");
  });

  it("throws when mongodb backend has no URI", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {},
      },
    } as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /MongoDB URI required/,
    );
  });

  it("config URI takes precedence over env var", () => {
    vi.stubEnv("OPENCLAW_MONGODB_URI", "mongodb://from-env:27017");
    try {
      const cfg = {
        agents: { defaults: { workspace: "/tmp/memory-test" } },
        memory: {
          backend: "mongodb",
          mongodb: {
            uri: "mongodb://from-config:27017",
          },
        },
      } as OpenClawConfig;
      const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
      expect(resolved.mongodb!.uri).toBe("mongodb://from-config:27017");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ---------------------------------------------------------------------------
  // KB config resolution tests
  // ---------------------------------------------------------------------------

  it("resolves KB defaults for MongoDB backend", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.kb).toBeDefined();
    expect(resolved.mongodb!.kb.enabled).toBe(true);
    expect(resolved.mongodb!.kb.chunking.tokens).toBe(600);
    expect(resolved.mongodb!.kb.chunking.overlap).toBe(100);
    expect(resolved.mongodb!.kb.autoImportPaths).toEqual([]);
    expect(resolved.mongodb!.kb.maxDocumentSize).toBe(10 * 1024 * 1024);
  });

  // ---------------------------------------------------------------------------
  // maxSessionChunks config resolution tests
  // ---------------------------------------------------------------------------

  it("resolves maxSessionChunks with default 50", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.maxSessionChunks).toBe(50);
  });

  it("resolves custom maxSessionChunks value", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", maxSessionChunks: 100 },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.maxSessionChunks).toBe(100);
  });

  it("clamps invalid maxSessionChunks to default 50", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", maxSessionChunks: -5 },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.maxSessionChunks).toBe(50);
  });

  it("floors fractional maxSessionChunks value", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: { uri: "mongodb://localhost:27017", maxSessionChunks: 75.9 },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.maxSessionChunks).toBe(75);
  });

  // ---------------------------------------------------------------------------
  // mongo_v2 runtime mode tests (Phase 1)
  // ---------------------------------------------------------------------------

  it("resolves mongo_v2 runtimeMode without error", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "mongo_v2",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.runtimeMode).toBe("mongo_v2");
  });

  it("still resolves mongo_canonical runtimeMode (regression)", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "mongo_canonical",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.runtimeMode).toBe("mongo_canonical");
  });

  it("defaults v2 config fields when runtimeMode is mongo_v2", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "mongo_v2",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.episodes).toEqual({ enabled: true, minEventsForEpisode: 10 });
    expect(resolved.mongodb!.graph).toEqual({ enabled: true, maxGraphDepth: 2 });
  });

  it("defaults v2 config fields to disabled when runtimeMode is mongo_canonical", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "mongo_canonical",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.episodes).toEqual({ enabled: false, minEventsForEpisode: 10 });
    expect(resolved.mongodb!.graph).toEqual({ enabled: false, maxGraphDepth: 2 });
  });

  it("throws on invalid runtimeMode", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "invalid_mode",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /Unsupported memory\.runtimeMode/,
    );
  });

  it("passes through runtimeMode to resolved config instead of hardcoding", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "mongo_v2",
        mongodb: { uri: "mongodb://localhost:27017" },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    // Must NOT be "mongo_canonical" when "mongo_v2" is configured
    expect(resolved.mongodb!.runtimeMode).not.toBe("mongo_canonical");
    expect(resolved.mongodb!.runtimeMode).toBe("mongo_v2");
  });

  it("resolves custom v2 episode and graph config", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        runtimeMode: "mongo_v2",
        mongodb: {
          uri: "mongodb://localhost:27017",
          episodes: { enabled: false, minEventsForEpisode: 20 },
          graph: { enabled: false, maxGraphDepth: 5 },
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.episodes).toEqual({ enabled: false, minEventsForEpisode: 20 });
    expect(resolved.mongodb!.graph).toEqual({ enabled: false, maxGraphDepth: 5 });
  });

  it("resolves custom KB config for MongoDB backend", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          kb: {
            enabled: false,
            chunking: { tokens: 800, overlap: 150 },
            autoImportPaths: ["/docs", "/wiki"],
            maxDocumentSize: 5 * 1024 * 1024,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.kb.enabled).toBe(false);
    expect(resolved.mongodb!.kb.chunking.tokens).toBe(800);
    expect(resolved.mongodb!.kb.chunking.overlap).toBe(150);
    expect(resolved.mongodb!.kb.autoImportPaths).toEqual(["/docs", "/wiki"]);
    expect(resolved.mongodb!.kb.maxDocumentSize).toBe(5 * 1024 * 1024);
  });
});
