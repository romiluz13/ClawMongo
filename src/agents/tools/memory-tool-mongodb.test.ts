import { beforeEach, describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createKBSearchTool, createMemoryWriteTool } from "./memory-tool.js";

describe("createKBSearchTool", () => {
  it("returns null when backend is not mongodb", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "builtin" },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).toBeNull();
  });

  it("returns tool when mongodb backend is active", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("kb_search");
  });

  it("returns null when config is undefined", () => {
    const tool = createKBSearchTool({});
    expect(tool).toBeNull();
  });
});

describe("createMemoryWriteTool", () => {
  it("returns null when backend is not mongodb", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "qmd" },
    } as OpenClawConfig;

    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).toBeNull();
  });

  it("returns tool when mongodb backend is active", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("memory_write");
    expect(tool!.description).toContain("structured observation");
  });

  it("returns null when config is undefined", () => {
    const tool = createMemoryWriteTool({});
    expect(tool).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kb_search direct path (searchKB on manager)
// ---------------------------------------------------------------------------

const mockGetMemorySearchManager = vi.hoisted(() => vi.fn());
vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: mockGetMemorySearchManager,
}));

describe("createKBSearchTool direct searchKB path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses direct searchKB() when manager has it", async () => {
    const kbResults = [
      {
        path: "docs/api.md",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "API docs",
        source: "kb" as const,
      },
    ];
    const searchKBMock = vi.fn().mockResolvedValue(kbResults);
    const searchMock = vi.fn();
    mockGetMemorySearchManager.mockResolvedValue({
      manager: {
        searchKB: searchKBMock,
        search: searchMock,
        status: () => ({ backend: "mongodb", provider: "test" }),
      },
      error: null,
    });

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call1", { query: "API rate limits" });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);

    // Direct searchKB should be called
    expect(searchKBMock).toHaveBeenCalledWith(
      "API rate limits",
      expect.objectContaining({ maxResults: 5 }),
    );
    // Fallback search should NOT be called
    expect(searchMock).not.toHaveBeenCalled();
    // Results should come through
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].source).toBe("kb");
  });

  it("falls back to search() + filter when searchKB is not available", async () => {
    const mixedResults = [
      {
        path: "docs/api.md",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "API docs",
        source: "kb" as const,
      },
      {
        path: "memory/notes.md",
        startLine: 1,
        endLine: 5,
        score: 0.7,
        snippet: "notes",
        source: "memory" as const,
      },
    ];
    const searchMock = vi.fn().mockResolvedValue(mixedResults);
    mockGetMemorySearchManager.mockResolvedValue({
      manager: {
        // No searchKB method — should fall back
        search: searchMock,
        status: () => ({ backend: "mongodb", provider: "test" }),
      },
      error: null,
    });

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call2", { query: "API rate limits" });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);

    // Fallback search should be called
    expect(searchMock).toHaveBeenCalledWith(
      "API rate limits",
      expect.objectContaining({ maxResults: 5 }),
    );
    // Results should be filtered to KB only
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].source).toBe("kb");
  });
});
