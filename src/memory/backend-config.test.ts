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

  it("rejects builtin backend with a migration error", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /Legacy memory backend "builtin"/,
    );
  });

  it("rejects qmd backend with a migration error", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;
    expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
      /Legacy memory backend "qmd"/,
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
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("mongodb");
    expect(resolved.mongodb).toBeDefined();
    expect(resolved.mongodb!.uri).toBe("mongodb://localhost:27017");
    expect(resolved.mongodb!.database).toBe("openclaw");
    expect(resolved.mongodb!.collectionPrefix).toBe("openclaw_main_");
    expect(resolved.mongodb!.deploymentProfile).toBe("atlas-default");
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
          uri: "mongodb+srv://atlas.example.com",
          database: "mydb",
          collectionPrefix: "custom_",
          deploymentProfile: "community-mongot",
          embeddingMode: "managed",
          fusionMethod: "rankFusion",
          quantization: "scalar",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.uri).toBe("mongodb+srv://atlas.example.com");
    expect(resolved.mongodb!.database).toBe("mydb");
    expect(resolved.mongodb!.collectionPrefix).toBe("custom_");
    expect(resolved.mongodb!.deploymentProfile).toBe("community-mongot");
    expect(resolved.mongodb!.embeddingMode).toBe("managed");
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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
    } as OpenClawConfig;
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

  it("defaults embeddingMode to managed for community-bare profile", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          deploymentProfile: "community-bare",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.embeddingMode).toBe("managed");
  });

  it("defaults embeddingMode to automated for atlas-m0 profile", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb+srv://atlas.example.com",
          deploymentProfile: "atlas-m0",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.embeddingMode).toBe("automated");
  });

  it("respects explicit embeddingMode override regardless of profile", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "mongodb",
        mongodb: {
          uri: "mongodb://localhost:27017",
          deploymentProfile: "community-mongot",
          embeddingMode: "automated",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.mongodb!.embeddingMode).toBe("automated");
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
