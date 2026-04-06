import { beforeEach, describe, it, expect } from "vitest";
import {
  getStubMemoryManager,
  resetMemoryToolMockState,
  setKBSearchImpl,
  setMemoryActiveSlateImpl,
  setMemoryContextBundleImpl,
  setMemoryDiscoveryProjectionImpl,
  setMemorySearchDetailedImpl,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createKBSearchTool,
  createMemoryActiveSlateTool,
  createMemoryContextBundleTool,
  createMemoryDiscoveryProjectionTool,
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

describe("mongodb memory specialty tools", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchDetailedImpl: null });
  });

  it("forwards scope inputs to hydrateActiveSlate()", async () => {
    setMemoryActiveSlateImpl(async () => ({
      items: [
        {
          kind: "project",
          title: "Phoenix rollout",
          summary: "Current blocker is release validation.",
          source: "structured",
          score: 0.97,
          locator: "structured:fact:phoenix-rollout",
        },
      ],
      metadata: {
        partial: false,
        sourceCounts: { structured: 1, procedural: 0, conversation: 0 },
      },
    }));

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemoryActiveSlateTool({ config: cfg });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-slate", {
      scope: "session",
      scopeRef: "agent:main:session-1",
      maxItems: 4,
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);

    expect(getStubMemoryManager().hydrateActiveSlate).toHaveBeenCalledWith({
      scope: "session",
      scopeRef: "agent:main:session-1",
      maxItems: 4,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].title).toBe("Phoenix rollout");
  });

  it("forwards discovery projection request fields", async () => {
    setMemoryDiscoveryProjectionImpl(async () => ({
      kind: "what-changed",
      target: "Phoenix",
      sections: [
        {
          title: "Changes",
          summary: "Release window moved to Friday.",
          items: [],
        },
      ],
      metadata: {
        partial: false,
        truncated: false,
        sourceCount: 2,
      },
    }));

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemoryDiscoveryProjectionTool({ config: cfg });
    expect(tool).not.toBeNull();

    await tool!.execute("call-discovery", {
      kind: "what-changed",
      query: "Phoenix",
      scope: "workspace",
      scopeRef: "clawmongo",
      maxItems: 3,
      timeRange: { preset: "last-7d" },
    });

    expect(getStubMemoryManager().buildDiscoveryProjection).toHaveBeenCalledWith({
      kind: "what-changed",
      query: "Phoenix",
      scope: "workspace",
      scopeRef: "clawmongo",
      maxItems: 3,
      timeRange: { preset: "last-7d" },
    });
  });

  it("forwards context bundle request fields", async () => {
    setMemoryContextBundleImpl(async () => ({
      sections: [
        {
          kind: "active-slate",
          title: "Active slate",
          text: "Phoenix is blocked on release validation.",
          items: [],
          estimatedTokens: 18,
        },
      ],
      rendered: "Phoenix is blocked on release validation.",
      metadata: {
        partial: false,
        truncated: false,
        tokenBudget: 250,
        estimatedTokensUsed: 18,
        pathsExecuted: ["active-slate"],
      },
    }));

    const cfg = {
      agents: { defaults: { workspace: "/tmp" } },
      memory: { backend: "mongodb", mongodb: { uri: "mongodb://localhost" } },
    } as OpenClawConfig;

    const tool = createMemoryContextBundleTool({ config: cfg });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call-context", {
      query: "Phoenix handoff",
      scope: "session",
      scopeRef: "agent:main:session-1",
      sessionId: "session-1",
      tokenBudget: 250,
      maxActiveItems: 3,
      maxRecentEvents: 5,
      maxEvidenceItems: 4,
      includeDiscoveryProjection: true,
      includeProfile: true,
      discoveryKind: "topic-brief",
      timeRange: { preset: "last-24h" },
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);

    expect(getStubMemoryManager().buildContextBundle).toHaveBeenCalledWith({
      query: "Phoenix handoff",
      scope: "session",
      scopeRef: "agent:main:session-1",
      sessionId: "session-1",
      tokenBudget: 250,
      maxActiveItems: 3,
      maxRecentEvents: 5,
      maxEvidenceItems: 4,
      includeDiscoveryProjection: true,
      includeProfile: true,
      discoveryKind: "topic-brief",
      timeRange: { preset: "last-24h" },
    });
    expect(parsed.metadata.tokenBudget).toBe(250);
  });
});
