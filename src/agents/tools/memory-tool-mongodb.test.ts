import { beforeEach, describe, it, expect } from "vitest";
import {
  getStubMemoryManager,
  resetMemoryToolMockState,
  setKBSearchImpl,
  setMemorySearchDetailedImpl,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createKBSearchTool,
  createMemorySearchTool,
  createMemoryWriteTool,
} from "./memory-tool.js";

describe("createKBSearchTool", () => {
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

describe("createMemorySearchTool detailed path", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchDetailedImpl: null });
  });

  it("forwards the structured search request to searchDetailed() when available", async () => {
    setMemorySearchDetailedImpl(async () => ({
      results: [],
      metadata: {
        mode: "agentic",
        classification: "family",
        sourceOrder: ["reference", "conversation"],
        passes: [],
        queriesTried: ["eval tools"],
        constraintsApplied: ["needExactEvidence"],
        resultsRejected: [],
        evidenceCoverage: "none",
        pathsExecuted: ["kb"],
        resultsByPath: { kb: 0 },
        queryRewritten: false,
        reranked: false,
      },
    }));

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemorySearchTool({ config: cfg, agentSessionKey: "agent:main:session-1" });
    expect(tool).not.toBeNull();

    await tool!.execute("call-search", {
      query: "eval tools",
      searchMode: "agentic",
      sourcePreference: ["reference", "conversation"],
      needExactEvidence: true,
      maxPasses: 3,
    });

    expect(getStubMemoryManager().searchDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "eval tools",
        searchMode: "agentic",
        sourcePreference: ["reference", "conversation"],
        needExactEvidence: true,
        maxPasses: 3,
        conversationScope: { sessionKey: "agent:main:session-1" },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// kb_search direct path (searchKB on manager)
// ---------------------------------------------------------------------------

describe("createKBSearchTool direct searchKB path", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchDetailedImpl: null });
  });

  it("uses direct searchKB() when manager has it", async () => {
    const kbResults = [
      {
        path: "docs/api.md",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "API docs",
        source: "reference" as const,
      },
    ];
    setKBSearchImpl(async () => kbResults);
    setMemorySearchImpl(async () => []);

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
    expect(getStubMemoryManager().searchKB).toHaveBeenCalledWith(
      "API rate limits",
      expect.objectContaining({ maxResults: 5 }),
    );
    // Fallback search should NOT be called
    expect(getStubMemoryManager().search).not.toHaveBeenCalled();
    // Results should come through
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].source).toBe("reference");
  });

  it("forwards tags/category/source filters to direct searchKB()", async () => {
    setKBSearchImpl(async () => []);
    setMemorySearchImpl(async () => []);

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createKBSearchTool({ config: cfg });
    expect(tool).not.toBeNull();

    await tool!.execute("call-filter", {
      query: "vector indexing",
      tags: ["docs", "api"],
      category: "architecture",
      source: "file",
    });

    expect(getStubMemoryManager().searchKB).toHaveBeenCalledWith(
      "vector indexing",
      expect.objectContaining({
        maxResults: 5,
        filter: {
          tags: ["docs", "api"],
          category: "architecture",
          source: "file",
        },
      }),
    );
  });

  it("falls back to search() + filter when searchKB is not available", async () => {
    const mixedResults = [
      {
        path: "docs/api.md",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "API docs",
        source: "reference" as const,
      },
      {
        path: "conversation/chat.jsonl",
        startLine: 1,
        endLine: 5,
        score: 0.7,
        snippet: "notes",
        source: "conversation" as const,
      },
    ];
    setMemorySearchImpl(async () => mixedResults);
    (getStubMemoryManager() as { searchKB?: unknown }).searchKB = undefined;

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
    expect(getStubMemoryManager().search).toHaveBeenCalledWith(
      "API rate limits",
      expect.objectContaining({ maxResults: 5 }),
    );
    // Results should be filtered to KB only
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].source).toBe("reference");
  });
});
