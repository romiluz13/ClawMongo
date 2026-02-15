import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("resolveMemoryBackendConfig", () => {
  it("defaults to builtin backend when config missing", () => {
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("builtin");
    expect(resolved.citations).toBe("auto");
    expect(resolved.qmd).toBeUndefined();
  });

  it("resolves qmd backend with default collections", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("qmd");
    expect(resolved.qmd?.collections.length).toBeGreaterThanOrEqual(3);
    expect(resolved.qmd?.command).toBe("qmd");
    expect(resolved.qmd?.searchMode).toBe("search");
    expect(resolved.qmd?.update.intervalMs).toBeGreaterThan(0);
    expect(resolved.qmd?.update.waitForBootSync).toBe(false);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(30_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(120_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(120_000);
  });

  it("parses quoted qmd command paths", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          command: '"/Applications/QMD Tools/qmd" --flag',
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.command).toBe("/Applications/QMD Tools/qmd");
  });

  it("resolves custom paths relative to workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [{ id: "main", workspace: "/workspace/root" }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          paths: [
            {
              path: "notes",
              name: "custom-notes",
              pattern: "**/*.md",
            },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const custom = resolved.qmd?.collections.find((c) => c.name.startsWith("custom-notes"));
    expect(custom).toBeDefined();
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, "main");
    expect(custom?.path).toBe(path.resolve(workspaceRoot, "notes"));
  });

  it("resolves qmd update timeout overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          update: {
            waitForBootSync: true,
            commandTimeoutMs: 12_000,
            updateTimeoutMs: 480_000,
            embedTimeoutMs: 360_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.update.waitForBootSync).toBe(true);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(12_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(480_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(360_000);
  });

  it("resolves qmd search mode override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "vsearch",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.searchMode).toBe("vsearch");
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
    expect(resolved.mongodb!.collectionPrefix).toBe("openclaw_");
    expect(resolved.mongodb!.deploymentProfile).toBe("atlas-default");
    expect(resolved.mongodb!.embeddingMode).toBe("automated");
    expect(resolved.mongodb!.fusionMethod).toBe("scoreFusion");
    expect(resolved.mongodb!.quantization).toBe("none");
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
});
