import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";

// Mock resolveOpenClawPackageName — default returns "openclaw" (upstream behaviour)
const mockResolvePackageName = vi.hoisted(() => vi.fn(async () => "openclaw"));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageName: mockResolvePackageName,
}));
const mockAttemptAutoSetup = vi.hoisted(() => vi.fn(async () => ({ success: false, reason: "" })));
vi.mock("./mongodb-auto-setup.js", () => ({
  attemptAutoSetup: mockAttemptAutoSetup,
}));

function createMockPrompter(responses: {
  selectResponses?: unknown[];
  textResponses?: string[];
}): WizardPrompter {
  const selectResponses = [...(responses.selectResponses ?? [])];
  const textResponses = [...(responses.textResponses ?? [])];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => selectResponses.shift()),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => textResponses.shift() ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("setupMemoryBackend", () => {
  beforeEach(() => {
    mockAttemptAutoSetup.mockResolvedValue({ success: false, reason: "Auto-setup unavailable" });
  });

  it("returns config unchanged when builtin is selected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = { gateway: { mode: "local" } };
    const prompter = createMockPrompter({ selectResponses: ["builtin"] });

    const result = await setupMemoryBackend(config, prompter);

    expect(result).toBe(config);
  });

  it("prompts for URI and profile when mongodb is selected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(prompter.text).toHaveBeenCalledTimes(1);
    expect(result.memory?.backend).toBe("mongodb");
    expect(result.memory?.mongodb?.uri).toBe("mongodb+srv://user:pass@cluster.mongodb.net/");
    expect(result.memory?.mongodb?.deploymentProfile).toBe("atlas-default");
  });

  it("rejects empty URI via validation", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    let validateFn: ((value: string) => string | undefined) | undefined;
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    const origText = prompter.text;
    prompter.text = vi.fn(async (params) => {
      validateFn = params.validate;
      return origText(params);
    }) as WizardPrompter["text"];

    await setupMemoryBackend(config, prompter);

    expect(validateFn).toBeDefined();
    expect(validateFn!("")).toBe("URI is required for MongoDB backend");
    expect(validateFn!("   ")).toBe("URI is required for MongoDB backend");
  });

  it("rejects invalid URI scheme via validation", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    let validateFn: ((value: string) => string | undefined) | undefined;
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    const origText = prompter.text;
    prompter.text = vi.fn(async (params) => {
      validateFn = params.validate;
      return origText(params);
    }) as WizardPrompter["text"];

    await setupMemoryBackend(config, prompter);

    expect(validateFn).toBeDefined();
    expect(validateFn!("http://localhost")).toBe(
      "URI must start with mongodb:// or mongodb+srv://",
    );
    expect(validateFn!("postgres://localhost")).toBe(
      "URI must start with mongodb:// or mongodb+srv://",
    );
  });

  it("accepts valid URI schemes via validation", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    let validateFn: ((value: string) => string | undefined) | undefined;
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    const origText = prompter.text;
    prompter.text = vi.fn(async (params) => {
      validateFn = params.validate;
      return origText(params);
    }) as WizardPrompter["text"];

    await setupMemoryBackend(config, prompter);

    expect(validateFn).toBeDefined();
    expect(validateFn!("mongodb://localhost:27017/")).toBeUndefined();
    expect(validateFn!("mongodb+srv://user:pass@cluster.mongodb.net/")).toBeUndefined();
  });

  it("auto-suggests atlas-default profile for Atlas URI", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });

    await setupMemoryBackend(config, prompter);

    // The second select call should have initialValue "atlas-default"
    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    expect(selectCalls.length).toBe(3); // backend, profile, kb-import
    const profileSelectParams = selectCalls[1][0];
    expect(profileSelectParams.initialValue).toBe("atlas-default");
  });

  it("auto-suggests community-mongot profile for non-Atlas URI", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      // 3rd select is embedding provider (triggered by community-mongot flow)
      selectResponses: ["mongodb", "community-mongot", "voyage"],
      textResponses: ["mongodb://localhost:27017/", "sk-test"],
    });

    await setupMemoryBackend(config, prompter);

    // The second select call should have initialValue "community-mongot"
    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    expect(selectCalls.length).toBe(4); // backend, profile, embedding provider, kb-import
    const profileSelectParams = selectCalls[1][0];
    expect(profileSelectParams.initialValue).toBe("community-mongot");
  });

  it("sets backend to qmd when qmd is selected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({ selectResponses: ["qmd"] });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.backend).toBe("qmd");
  });

  it("preserves existing config fields when selecting mongodb", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {
      gateway: { mode: "local" },
      memory: { citations: "on" },
    };
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.gateway?.mode).toBe("local");
    expect(result.memory?.citations).toBe("on");
    expect(result.memory?.backend).toBe("mongodb");
  });

  it("defaults to mongodb when running as @romiluz/clawmongo", async () => {
    mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    await setupMemoryBackend(config, prompter);

    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    // First select is memory backend — initialValue should be "mongodb"
    expect(selectCalls[0][0].initialValue).toBe("mongodb");
    // MongoDB option should say "(Recommended)"
    const mongoOption = selectCalls[0][0].options.find(
      (o: { value: string }) => o.value === "mongodb",
    );
    expect(mongoOption.label).toContain("Recommended");
  });

  it("shows no-docker local setup hint when docker auto-setup is unavailable", async () => {
    mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
    mockAttemptAutoSetup.mockResolvedValueOnce({
      success: false,
      reason: "Docker is not installed. Enter a MongoDB URI manually.",
    });
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    await setupMemoryBackend(config, prompter);

    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const noDockerNote = noteCalls.find(
      (c: unknown[]) => typeof c[1] === "string" && c[1] === "Local MongoDB (No Docker)",
    );
    expect(noDockerNote).toBeDefined();
  });

  it("sets embeddingMode to managed for community-mongot and prompts for vector search", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    // select: backend=mongodb, profile=community-mongot, provider=voyage
    // confirm: wantVectorSearch=true
    // text: URI, API key
    const confirmResponses = [true];
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot", "voyage"],
      textResponses: ["mongodb://localhost:27017/", "sk-voyage-test-key"],
    });
    prompter.confirm = vi.fn(
      async () => confirmResponses.shift() ?? true,
    ) as WizardPrompter["confirm"];

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.mongodb?.embeddingMode).toBe("managed");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
    expect(result.agents?.defaults?.memorySearch?.provider).toBe("voyage");
    expect(result.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("sk-voyage-test-key");
  });

  it("sets embeddingMode to automated for atlas profiles (no embedding prompt)", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
    // No embedding provider prompt for Atlas (automated mode)
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("skips embedding prompt for community-bare (text search only)", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.mongodb?.embeddingMode).toBe("managed");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(false);
    // No confirm for community-bare — just a note about text search
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalled();
    const noteCall = (prompter.note as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("$text"),
    );
    expect(noteCall).toBeDefined();
  });

  it("saves local provider without API key prompt", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const confirmResponses = [true];
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot", "local"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    prompter.confirm = vi.fn(
      async () => confirmResponses.shift() ?? true,
    ) as WizardPrompter["confirm"];

    const result = await setupMemoryBackend(config, prompter);

    expect(result.agents?.defaults?.memorySearch?.provider).toBe("local");
    // Only 1 text call (URI) — no API key prompt for local
    expect(prompter.text).toHaveBeenCalledTimes(1);
  });

  it("shows reminder when API key is left blank", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const confirmResponses = [true];
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot", "openai"],
      textResponses: ["mongodb://localhost:27017/", ""],
    });
    prompter.confirm = vi.fn(
      async () => confirmResponses.shift() ?? true,
    ) as WizardPrompter["confirm"];

    const result = await setupMemoryBackend(config, prompter);

    expect(result.agents?.defaults?.memorySearch?.provider).toBe("openai");
    expect(result.agents?.defaults?.memorySearch?.remote?.apiKey).toBeUndefined();
    // Should show reminder note about env var
    const noteCall = (prompter.note as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("OPENAI_API_KEY"),
    );
    expect(noteCall).toBeDefined();
  });

  it("skips vector search when user declines", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const confirmResponses = [false];
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    prompter.confirm = vi.fn(
      async () => confirmResponses.shift() ?? true,
    ) as WizardPrompter["confirm"];

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.mongodb?.embeddingMode).toBe("managed");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
    // No embedding provider saved
    expect(result.agents?.defaults?.memorySearch?.provider).toBeUndefined();
    // Should show text-search-only note
    const noteCall = (prompter.note as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Text search"),
    );
    expect(noteCall).toBeDefined();
  });

  it("defaults to builtin when running as openclaw", async () => {
    mockResolvePackageName.mockResolvedValueOnce("openclaw");
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({ selectResponses: ["builtin"] });

    await setupMemoryBackend(config, prompter);

    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    expect(selectCalls[0][0].initialValue).toBe("builtin");
    const mongoOption = selectCalls[0][0].options.find(
      (o: { value: string }) => o.value === "mongodb",
    );
    expect(mongoOption.label).not.toContain("Recommended");
  });
});

// ---------------------------------------------------------------------------
// Topology detection in wizard tests
// ---------------------------------------------------------------------------

// Mock mongodb driver for topology detection tests
const mockMongoClientCloseFn = vi.hoisted(() => vi.fn(async () => {}));
const mockMongoClientConnectFn = vi.hoisted(() => vi.fn(async () => {}));
const mockMongoClientDbFn = vi.hoisted(() =>
  vi.fn(() => ({
    admin: () => ({ command: vi.fn() }),
    listCollections: () => ({ toArray: vi.fn(async () => []) }),
    collection: () => ({
      listSearchIndexes: () => ({
        toArray: vi.fn(async () => {
          throw new Error("not supported");
        }),
      }),
    }),
  })),
);

vi.mock("mongodb", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock requires constructor pattern
  const MockMongoClient: any = function (this: Record<string, unknown>) {
    this.connect = mockMongoClientConnectFn;
    this.close = mockMongoClientCloseFn;
    this.db = mockMongoClientDbFn;
  };
  MockMongoClient.prototype = {};
  return { MongoClient: MockMongoClient };
});

// Mock the topology module
const mockDetectTopology = vi.hoisted(() => vi.fn());
const mockTopologyToTier = vi.hoisted(() => vi.fn());
const mockTierFeatures = vi.hoisted(() => vi.fn());
const mockSuggestConnectionString = vi.hoisted(() => vi.fn());
vi.mock("../memory/mongodb-topology.js", () => ({
  detectTopology: mockDetectTopology,
  topologyToTier: mockTopologyToTier,
  tierFeatures: mockTierFeatures,
  suggestConnectionString: mockSuggestConnectionString,
}));

describe("topology detection in wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMongoClientConnectFn.mockResolvedValue(undefined);
    mockMongoClientCloseFn.mockResolvedValue(undefined);
  });

  it("detects topology and shows features note when connected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    // Setup topology detection mocks
    mockDetectTopology.mockResolvedValue({
      isReplicaSet: true,
      hasMongot: true,
      serverVersion: "8.2.0",
      replicaSetName: "rs0",
    });
    mockTopologyToTier.mockReturnValue("fullstack");
    mockTierFeatures.mockReturnValue({
      available: ["ACID transactions", "$vectorSearch"],
      unavailable: [],
    });
    mockSuggestConnectionString.mockReturnValue("mongodb://localhost:27017/?replicaSet=rs0");

    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot", "voyage"],
      textResponses: ["mongodb://localhost:27017/", "sk-test"],
    });
    prompter.confirm = vi.fn(async () => true) as WizardPrompter["confirm"];

    await setupMemoryBackend(config, prompter);

    // Should have called detectTopology
    expect(mockDetectTopology).toHaveBeenCalled();
    // Should have shown a topology note
    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const topologyNote = noteCalls.find(
      (c: unknown[]) => typeof c[1] === "string" && c[1] === "MongoDB Topology",
    );
    expect(topologyNote).toBeDefined();
  });

  it("auto-suggests community-bare profile when standalone detected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    mockDetectTopology.mockResolvedValue({
      isReplicaSet: false,
      hasMongot: false,
      serverVersion: "8.2.0",
    });
    mockTopologyToTier.mockReturnValue("standalone");
    mockTierFeatures.mockReturnValue({
      available: ["$text keyword search"],
      unavailable: ["ACID transactions", "$vectorSearch"],
    });
    mockSuggestConnectionString.mockReturnValue("mongodb://localhost:27017/");

    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    // Profile select should have initialValue "community-bare" based on standalone detection
    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    const profileSelectParams = selectCalls[1][0];
    expect(profileSelectParams.initialValue).toBe("community-bare");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(false);
  });

  it("suggests replicaSet in connection string when detected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    mockDetectTopology.mockResolvedValue({
      isReplicaSet: true,
      hasMongot: false,
      serverVersion: "8.2.0",
      replicaSetName: "rs0",
    });
    mockTopologyToTier.mockReturnValue("replicaset");
    mockTierFeatures.mockReturnValue({
      available: ["ACID transactions", "$text keyword search"],
      unavailable: ["$vectorSearch (requires mongot)"],
    });
    // The key: suggested URI is different from input URI
    mockSuggestConnectionString.mockReturnValue("mongodb://localhost:27017/?replicaSet=rs0");

    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    // Should have shown connection string suggestion note
    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const connStringNote = noteCalls.find(
      (c: unknown[]) => typeof c[1] === "string" && c[1] === "Connection String",
    );
    expect(connStringNote).toBeDefined();
    expect(connStringNote![0]).toContain("replicaSet");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
  });

  it("skips topology detection when connection fails", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    mockMongoClientConnectFn.mockRejectedValue(new Error("ECONNREFUSED"));

    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    // Should NOT have called detectTopology
    expect(mockDetectTopology).not.toHaveBeenCalled();
    // Should still succeed (graceful degradation)
    expect(result.memory?.backend).toBe("mongodb");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
  });

  it("shows docker-compose hint when standalone detected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    mockDetectTopology.mockResolvedValue({
      isReplicaSet: false,
      hasMongot: false,
      serverVersion: "8.2.0",
    });
    mockTopologyToTier.mockReturnValue("standalone");
    mockTierFeatures.mockReturnValue({
      available: ["$text keyword search"],
      unavailable: ["ACID transactions", "$vectorSearch"],
    });
    mockSuggestConnectionString.mockReturnValue("mongodb://localhost:27017/");

    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    await setupMemoryBackend(config, prompter);

    // Should show docker-compose hint in topology note
    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const topologyNote = noteCalls.find(
      (c: unknown[]) => typeof c[1] === "string" && c[1] === "MongoDB Topology",
    );
    expect(topologyNote).toBeDefined();
    expect(topologyNote![0]).toContain("start.sh fullstack");
  });

  it("auto-suggests community-mongot when fullstack detected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    mockDetectTopology.mockResolvedValue({
      isReplicaSet: true,
      hasMongot: true,
      serverVersion: "8.2.0",
      replicaSetName: "rs0",
    });
    mockTopologyToTier.mockReturnValue("fullstack");
    mockTierFeatures.mockReturnValue({
      available: ["ACID transactions", "$vectorSearch", "Automated embeddings"],
      unavailable: [],
    });
    mockSuggestConnectionString.mockReturnValue("mongodb://localhost:27017/?replicaSet=rs0");

    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot", "voyage"],
      textResponses: ["mongodb://localhost:27017/", "sk-test"],
    });
    prompter.confirm = vi.fn(async () => true) as WizardPrompter["confirm"];

    const result = await setupMemoryBackend(config, prompter);

    // Profile select should have initialValue "community-mongot" based on fullstack detection
    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    const profileSelectParams = selectCalls[1][0];
    expect(profileSelectParams.initialValue).toBe("community-mongot");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// customizeWorkspaceForMongoDB tests
// ---------------------------------------------------------------------------

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockAppendFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    appendFile: mockAppendFile,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  appendFile: mockAppendFile,
}));

describe("customizeWorkspaceForMongoDB", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends MongoDB section to AGENTS.md", async () => {
    const { customizeWorkspaceForMongoDB } = await import("./onboarding-memory.js");
    // AGENTS.md exists without MongoDB section
    mockReadFile.mockResolvedValue("# Agent Instructions\nDo stuff.\n");
    mockWriteFile.mockResolvedValue(undefined);

    await customizeWorkspaceForMongoDB("/tmp/workspace");

    // Should read AGENTS.md
    expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining("AGENTS.md"), "utf-8");
    // Should append the MongoDB section to AGENTS.md
    expect(mockAppendFile).toHaveBeenCalledWith(
      expect.stringContaining("AGENTS.md"),
      expect.stringContaining("## MongoDB Memory Backend"),
    );
  });

  it("seeds MEMORY.md with correct initial content", async () => {
    const { customizeWorkspaceForMongoDB } = await import("./onboarding-memory.js");
    // AGENTS.md exists without MongoDB section
    mockReadFile.mockResolvedValue("# Agent Instructions\n");
    mockWriteFile.mockResolvedValue(undefined);

    await customizeWorkspaceForMongoDB("/tmp/workspace");

    // Should create MEMORY.md with wx flag (exclusive create)
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("MEMORY.md"),
      expect.stringContaining("MongoDB"),
      expect.objectContaining({ flag: "wx" }),
    );
  });

  it("is idempotent - does not duplicate MongoDB section if already present", async () => {
    const { customizeWorkspaceForMongoDB } = await import("./onboarding-memory.js");
    // AGENTS.md already has the MongoDB section
    mockReadFile.mockResolvedValue(
      "# Agent Instructions\n\n## MongoDB Memory Backend\nExisting content.\n",
    );
    mockWriteFile.mockResolvedValue(undefined);

    await customizeWorkspaceForMongoDB("/tmp/workspace");

    // Should NOT append again
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("does not overwrite existing MEMORY.md (wx flag)", async () => {
    const { customizeWorkspaceForMongoDB } = await import("./onboarding-memory.js");
    mockReadFile.mockResolvedValue("# Agent Instructions\n");
    // writeFile with wx flag throws EEXIST if file exists
    const existError = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
    existError.code = "EEXIST";
    mockWriteFile.mockRejectedValue(existError);

    // Should NOT throw — EEXIST is expected and silently ignored
    await expect(customizeWorkspaceForMongoDB("/tmp/workspace")).resolves.toBeUndefined();
  });
});
