import { beforeEach, describe, expect, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemorySearchDetailedImpl,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import {
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("quota", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("surfaces detailed search metadata when the backend provides it", async () => {
    setMemorySearchDetailedImpl(async () => ({
      results: [
        {
          path: "memory/test.md",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "hello",
          source: "conversation",
        },
      ],
      metadata: {
        mode: "agentic",
        classification: "family",
        sourceOrder: ["conversation", "reference", "structured"],
        passes: [
          {
            pass: 1,
            query: "hello",
            reason: "original",
            pathsExecuted: ["hybrid"],
            resultCount: 1,
            queryRewritten: false,
            reranked: false,
          },
        ],
        queriesTried: ["hello"],
        constraintsApplied: [],
        resultsRejected: [],
        evidenceCoverage: "direct",
        pathsExecuted: ["hybrid"],
        resultsByPath: { hybrid: 1 },
        queryRewritten: false,
        reranked: false,
      },
    }));

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("detailed", { query: "hello", searchMode: "agentic" });
    expect(result.details).toEqual(
      expect.objectContaining({
        mode: "agentic",
        metadata: expect.objectContaining({
          classification: "family",
          pathsExecuted: ["hybrid"],
        }),
      }),
    );
  });
});
