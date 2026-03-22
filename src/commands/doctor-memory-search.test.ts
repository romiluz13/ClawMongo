import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const resolveMemoryBackendConfig = vi.hoisted(() => vi.fn());
const getMemoryStats = vi.hoisted(() =>
  vi.fn(async () => ({
    embeddingStatusCoverage: { failed: 0, success: 0, pending: 0, total: 0 },
  })),
);

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider,
}));

vi.mock("../memory/backend-config.js", () => ({
  resolveMemoryBackendConfig,
}));

vi.mock("mongodb", () => ({
  MongoClient: class MockMongoClient {
    async connect() {}
    db() {
      return {
        command: async () => ({ ok: 1 }),
      };
    }
    async close() {}
  },
}));

const mockDetectTopology = vi.hoisted(() =>
  vi.fn(async () => ({ serverVersion: "8.2.0", replicaSetName: "rs0", hasMongot: true })),
);
const mockTopologyToTier = vi.hoisted(() => vi.fn(() => "fullstack"));
const mockTierFeatures = vi.hoisted(() =>
  vi.fn(() => ({ available: ["Search", "Vector Search"], unavailable: [] as string[] })),
);
vi.mock("../memory/mongodb-topology.js", () => ({
  detectTopology: mockDetectTopology,
  topologyToTier: mockTopologyToTier,
  tierFeatures: mockTierFeatures,
}));

vi.mock("../memory/mongodb-analytics.js", () => ({
  getMemoryStats,
}));

import { noteMemorySearchHealth } from "./doctor-memory-search.js";
import { detectLegacyWorkspaceDirs } from "./doctor-workspace.js";

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;

  function expectOnlyBackendHealthNote() {
    // At minimum: backend health note + recall diagnostic note (+ possible mongot/auto-embed/vector notes)
    expect(note.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(String(note.mock.calls[0]?.[0] ?? "")).toContain("MongoDB connected. Profile:");
    // Recall diagnostic is the last note in the standard doctor flow
    const lastNote = note.mock.calls[note.mock.calls.length - 1];
    expect(String(lastNote?.[1] ?? "")).toBe("Memory Recall Diagnostic");
  }

  function getLastNoteMessage(): string {
    return String(note.mock.calls.at(-1)?.[0] ?? "");
  }

  async function expectNoWarningWithConfiguredRemoteApiKey(provider: string) {
    resolveMemorySearchConfig.mockReturnValue({
      provider,
      local: {},
      remote: { apiKey: "from-config" },
    });

    await noteMemorySearchHealth(cfg, {});

    expectOnlyBackendHealthNote();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    note.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockRejectedValue(new Error("missing key"));
    resolveMemoryBackendConfig.mockReset();
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "mongodb",
      citations: "auto",
      mongodb: {
        uri: "mongodb://localhost:27017/openclaw",
        database: "openclaw",
        collectionPrefix: "openclaw_",
        deploymentProfile: "community-mongot",
      },
    });
  });

  it("does not warn when local provider is set with no explicit modelPath (default model fallback)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expectOnlyBackendHealthNote();
  });

  it("warns when local provider with default model but gateway probe reports not ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: false, error: "node-llama-cpp not installed" },
    });

    expect(note.mock.calls.length).toBeGreaterThanOrEqual(3);
    const message = getLastNoteMessage();
    expect(message).toContain("gateway reports local embeddings are not ready");
    expect(message).toContain("node-llama-cpp not installed");
  });

  it("does not warn when local provider with default model and gateway probe is ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expectOnlyBackendHealthNote();
  });

  it("does not warn when local provider has an explicit hf: modelPath", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expectOnlyBackendHealthNote();
  });

  it("stops after MongoDB backend validation fails", async () => {
    const invalidCfg = {} as OpenClawConfig;
    resolveMemoryBackendConfig.mockImplementation(() => {
      throw new Error("MongoDB URI required");
    });
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(invalidCfg, {});

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("MongoDB memory is active but no URI is set."),
      "Memory (MongoDB)",
    );
  });

  it("does not warn when remote apiKey is configured for explicit provider", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("openai");
  });

  it("treats SecretRef remote apiKey as configured for explicit provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expectOnlyBackendHealthNote();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn in auto mode when remote apiKey is configured", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("auto");
  });

  it("treats SecretRef remote apiKey as configured in auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expectOnlyBackendHealthNote();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("resolves provider auth from the default agent directory", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: GEMINI_API_KEY",
      mode: "api-key",
    });

    await noteMemorySearchHealth(cfg, {});

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "google",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expectOnlyBackendHealthNote();
  });

  it("resolves mistral auth for explicit mistral embedding provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "mistral",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: MISTRAL_API_KEY",
      mode: "api-key",
    });

    await noteMemorySearchHealth(cfg);

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "mistral",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expectOnlyBackendHealthNote();
  });

  it("notes when gateway probe reports embeddings ready and CLI API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note.mock.calls.length).toBeGreaterThanOrEqual(3);
    const message = getLastNoteMessage();
    expect(message).toContain("reports memory embeddings are ready");
  });

  it("uses model configure hint when gateway probe is unavailable and API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: true,
        ready: false,
        error: "gateway memory probe unavailable: timeout",
      },
    });

    expect(note.mock.calls.length).toBeGreaterThanOrEqual(3);
    const message = getLastNoteMessage();
    expect(message).toContain("Gateway memory probe for default agent is not ready");
    expect(message).toContain("openclaw configure --section model");
    expect(message).not.toContain("openclaw auth add --provider");
  });

  it("warns in auto mode when no local modelPath and no API keys are configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    expect(note.mock.calls.length).toBeGreaterThanOrEqual(3);
    const message = getLastNoteMessage();
    expect(message).toContain("needs at least one embedding provider");
    expect(message).toContain("openclaw configure --section model");
  });

  it("still warns in auto mode when only ollama credentials exist", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockImplementation(async ({ provider }: { provider: string }) => {
      if (provider === "ollama") {
        return {
          apiKey: "ollama-local", // pragma: allowlist secret
          source: "env: OLLAMA_API_KEY",
          mode: "api-key",
        };
      }
      throw new Error("missing key");
    });

    await noteMemorySearchHealth(cfg);

    expect(note.mock.calls.length).toBeGreaterThanOrEqual(3);
    const providerCalls = resolveApiKeyForProvider.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual(["openai", "google", "voyage", "mistral"]);
  });
});

describe("noteMongoDBBackendHealth - mongot and search diagnostics", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockClear();
    resolveMemoryBackendConfig.mockReset();
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "mongodb",
      citations: "auto",
      mongodb: {
        uri: "mongodb://localhost:27017/openclaw",
        database: "openclaw",
        collectionPrefix: "openclaw_",
        deploymentProfile: "community-mongot",
      },
    });
    mockDetectTopology.mockResolvedValue({
      serverVersion: "8.2.0",
      replicaSetName: "rs0",
      hasMongot: true,
    });
    mockTopologyToTier.mockReturnValue("fullstack");
    mockTierFeatures.mockReturnValue({
      available: ["Search", "Vector Search"],
      unavailable: [],
    });
  });

  it("shows start-preview.sh in upgrade guidance when features missing", async () => {
    mockTopologyToTier.mockReturnValue("standalone");
    mockTierFeatures.mockReturnValue({
      available: [],
      unavailable: ["Vector Search", "Atlas Search"],
    });

    const { noteMongoDBBackendHealth } = await import("./doctor-memory-search.js");
    await noteMongoDBBackendHealth(cfg);

    const allNotes = note.mock.calls.map((c: unknown[]) => String(c[0]));
    const upgradeNote = allNotes.find((n: string) => n.includes("start-preview.sh"));
    expect(upgradeNote).toBeDefined();
    expect(upgradeNote).toContain("mongodb-atlas-local:preview");
  });

  it("reports mongot not reachable when topology.hasMongot is false", async () => {
    mockDetectTopology.mockResolvedValue({
      serverVersion: "8.2.0",
      replicaSetName: "rs0",
      hasMongot: false,
    });

    const { noteMongoDBBackendHealth } = await import("./doctor-memory-search.js");
    await noteMongoDBBackendHealth(cfg);

    const allNotes = note.mock.calls.map((c: unknown[]) => String(c[0]));
    const mongotNote = allNotes.find((n: string) => n.includes("mongot is not reachable"));
    expect(mongotNote).toBeDefined();
    expect(mongotNote).toContain("start-preview.sh");
  });

  it("reports auto-embed not configured when VOYAGE_API_KEY missing", async () => {
    const origKey = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;

    try {
      const { noteMongoDBBackendHealth } = await import("./doctor-memory-search.js");
      await noteMongoDBBackendHealth(cfg);

      const allNotes = note.mock.calls.map((c: unknown[]) => String(c[0]));
      const autoEmbedNote = allNotes.find((n: string) => n.includes("VOYAGE_API_KEY is not set"));
      expect(autoEmbedNote).toBeDefined();
    } finally {
      if (origKey !== undefined) {
        process.env.VOYAGE_API_KEY = origKey;
      }
    }
  });
});

describe("detectLegacyWorkspaceDirs", () => {
  it("returns active workspace and no legacy dirs", () => {
    const workspaceDir = "/home/user/openclaw";
    const detection = detectLegacyWorkspaceDirs({ workspaceDir });
    expect(detection.activeWorkspace).toBe(path.resolve(workspaceDir));
    expect(detection.legacyDirs).toEqual([]);
  });
});
