import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn<() => OpenClawConfig>(() => ({
  memory: { mongodb: { uri: "mongodb://localhost:27017/openclaw" } },
}));
const resolveMemoryBackendConfig = vi.fn(() => ({ backend: "mongodb" }));
const resolveDefaultAgentId = vi.fn(() => "main");
const resolveCommandSecretRefsViaGateway = vi.fn(async ({ config }: { config: unknown }) => ({
  resolvedConfig: config,
  diagnostics: [] as string[],
}));

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../memory/backend-config.js", () => ({
  resolveMemoryBackendConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway,
}));

let registerMemoryCli: typeof import("./memory-cli.js").registerMemoryCli;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;
let isVerbose: typeof import("../globals.js").isVerbose;
let setVerbose: typeof import("../globals.js").setVerbose;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./memory-cli.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
  ({ isVerbose, setVerbose } = await import("../globals.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockClear();
  resolveMemoryBackendConfig.mockReset();
  resolveMemoryBackendConfig.mockReturnValue({ backend: "mongodb" });
  resolveCommandSecretRefsViaGateway.mockClear();
  process.exitCode = undefined;
  setVerbose(false);
});

describe("memory cli", () => {
  function spyRuntimeLogs() {
    return vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  }

  function spyRuntimeErrors() {
    return vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  }

  function firstLoggedJson(log: ReturnType<typeof vi.spyOn>) {
    return JSON.parse(String(log.mock.calls[0]?.[0] ?? "null")) as Record<string, unknown>;
  }

  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = spyRuntimeErrors();
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            dims: 1024,
          },
        }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("resolves configured memory SecretRefs through gateway snapshot", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status"]);

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "memory status",
        targetIds: new Set([
          "agents.defaults.memorySearch.remote.apiKey",
          "agents.list[].memorySearch.remote.apiKey",
        ]),
      }),
    );
  });

  it("logs gateway secret diagnostics for non-json status output", async () => {
    const close = vi.fn(async () => {});
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {},
      diagnostics: ["agents.defaults.memorySearch.remote.apiKey inactive"] as string[],
    });
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(
      log.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("agents.defaults.memorySearch.remote.apiKey inactive"),
      ),
    ).toBe(true);
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    spyRuntimeLogs();
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = spyRuntimeErrors();
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });

  it("prints status json output when requested", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload)).toBe(true);
    expect((payload[0] as Record<string, unknown>)?.agentId).toBe("main");
    expect(close).toHaveBeenCalled();
  });

  it("routes gateway secret diagnostics to stderr for json status output", async () => {
    const close = vi.fn(async () => {});
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {},
      diagnostics: ["agents.defaults.memorySearch.remote.apiKey inactive"] as string[],
    });
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const log = spyRuntimeLogs();
    const error = spyRuntimeErrors();
    await runMemoryCli(["status", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload)).toBe(true);
    expect(
      error.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("agents.defaults.memorySearch.remote.apiKey inactive"),
      ),
    ).toBe(true);
  });

  it("logs default message when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValueOnce({ manager: null });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith("Memory search disabled.");
  });

  it("logs backend unsupported message when index has no sync", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () => makeMemoryStatus(),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["index"]);

    expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
    expect(close).toHaveBeenCalled();
  });

  it("prints no matches for empty search results", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "hello"]);

    expect(search).toHaveBeenCalledWith("hello", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
  });

  it("accepts --query for memory search", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "--query", "deployment notes"]);

    expect(search).toHaveBeenCalledWith("deployment notes", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prefers --query when positional and flag are both provided", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    spyRuntimeLogs();
    await runMemoryCli(["search", "positional", "--query", "flagged"]);

    expect(search).toHaveBeenCalledWith("flagged", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(close).toHaveBeenCalled();
  });

  it("fails when neither positional query nor --query is provided", async () => {
    const error = spyRuntimeErrors();
    await runMemoryCli(["search"]);

    expect(error).toHaveBeenCalledWith(
      "Missing search query. Provide a positional query or use --query <text>.",
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints search results as json when requested", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "hello", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results as unknown[]).toHaveLength(1);
    expect(close).toHaveBeenCalled();
  });

  it("runs memory smoke checks successfully", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const writeStructuredMemory = vi.fn(async () => ({ upserted: true, id: "1" }));
    const search = vi.fn(async () => [
      {
        path: "structured/custom.md",
        startLine: 1,
        endLine: 1,
        score: 0.91,
        snippet: "clawmongo smoke marker smoke-123",
        source: "structured",
      },
    ]);
    mockManager({
      sync,
      writeStructuredMemory,
      search,
      status: () => ({ backend: "mongodb" }),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["smoke"]);

    expect(sync).toHaveBeenCalledWith({ reason: "smoke" });
    expect(writeStructuredMemory).toHaveBeenCalled();
    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Memory smoke passed (main)."));
    expect(process.exitCode).toBeUndefined();
  });

  it("fails memory smoke when backend resolution returns a legacy backend", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    resolveMemoryBackendConfig.mockReturnValueOnce({ backend: "builtin" as never });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["smoke"]);

    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Memory smoke failed (main): memory backend is "builtin"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails memory smoke when retrieval cannot find the written marker", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const writeStructuredMemory = vi.fn(async () => ({ upserted: true, id: "1" }));
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-01.md",
        startLine: 1,
        endLine: 1,
        score: 0.12,
        snippet: "no marker here",
        source: "memory",
      },
    ]);
    mockManager({
      sync,
      writeStructuredMemory,
      search,
      status: () => ({ backend: "mongodb" }),
      close,
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    await runMemoryCli(["smoke"]);

    expect(sync).toHaveBeenCalledWith({ reason: "smoke" });
    expect(writeStructuredMemory).toHaveBeenCalled();
    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory smoke failed (main)."));
    expect(process.exitCode).toBe(1);
  });

  it("runs relevance explain command", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const relevanceExplain = vi.fn(async () => ({
      runId: "run-1",
      latencyMs: 11,
      sourceScope: "kb" as const,
      health: "ok" as const,
      sampleRate: 0.01,
      artifacts: [],
      results: [],
    }));
    mockManager({
      relevanceExplain,
      relevanceBenchmark: vi.fn(),
      relevanceReport: vi.fn(),
      relevanceSampleRate: vi.fn(),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["relevance", "explain", "--query", "release notes", "--source", "kb"]);

    expect(relevanceExplain).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "release notes",
        sourceScope: "kb",
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Relevance explain (main)"));
    expect(close).toHaveBeenCalled();
  });

  it("fails relevance explain when source is invalid", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});

    await runMemoryCli(["relevance", "explain", "--query", "release notes", "--source", "bad"]);

    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Invalid --source value "bad"'));
    expect(process.exitCode).toBe(1);
  });

  it("runs relevance report command", async () => {
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const relevanceReport = vi.fn(async () => ({
      health: "ok" as const,
      runs: 10,
      sampledRuns: 2,
      emptyRate: 0.1,
      avgTopScore: 0.8,
      fallbackRate: 0.05,
      profileCapabilities: {
        textExplain: true,
        vectorExplain: true,
        fusionExplain: false,
      },
    }));
    mockManager({
      relevanceExplain: vi.fn(),
      relevanceBenchmark: vi.fn(),
      relevanceReport,
      relevanceSampleRate: vi.fn(),
      close,
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runMemoryCli(["relevance", "report", "--window", "7d"]);

    expect(relevanceReport).toHaveBeenCalledWith(
      expect.objectContaining({ windowMs: 7 * 24 * 60 * 60 * 1000 }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Relevance report (main)"));
    expect(close).toHaveBeenCalled();
  });
});
