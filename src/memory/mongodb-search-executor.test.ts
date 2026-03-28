import { describe, expect, it } from "vitest";
import {
  applyHardConstraintRejections,
  buildExecutorPasses,
  buildMemorySearchRequestSignature,
  classifyExecutorSearch,
  normalizeMemorySearchRequest,
  requestHasHardConstraints,
  resolveExecutorTimeRange,
} from "./mongodb-search-executor.js";

describe("normalizeMemorySearchRequest", () => {
  it("applies bounded defaults for mode, passes, and source order", () => {
    const normalized = normalizeMemorySearchRequest({ query: " hello " });
    expect(normalized.query).toBe(" hello ");
    expect(normalized.searchMode).toBe("auto");
    expect(normalized.maxPasses).toBe(2);
    expect(normalized.sourcePreference).toEqual([
      "conversation",
      "structured",
      "procedural",
      "reference",
      "episodic",
      "graph",
    ]);
  });

  it("clamps maxPasses to the supported range", () => {
    const normalized = normalizeMemorySearchRequest({
      query: "hello",
      searchMode: "agentic",
      maxPasses: 99,
    });
    expect(normalized.maxPasses).toBe(3);
  });
});

describe("classifyExecutorSearch", () => {
  it("detects family-style queries", () => {
    expect(classifyExecutorSearch({ query: "open source eval tools family" })).toBe("family");
  });

  it("detects scoped searches when explicit scopes are present", () => {
    expect(
      classifyExecutorSearch({
        query: "find the decision",
        structuredScope: { type: "decision" },
      }),
    ).toBe("scoped");
  });
});

describe("buildExecutorPasses", () => {
  it("keeps direct auto queries single-pass", () => {
    const passes = buildExecutorPasses(
      normalizeMemorySearchRequest({ query: "what is Bloom" }),
      "direct",
    );
    expect(passes).toHaveLength(1);
    expect(passes[0]?.variant).toBe("original");
  });

  it("expands family queries in agentic mode", () => {
    const passes = buildExecutorPasses(
      normalizeMemorySearchRequest({
        query: "open source eval tools",
        searchMode: "agentic",
      }),
      "family",
    );
    expect(passes.map((pass) => pass.query)).toEqual([
      "open source eval tools",
      "open source eval tools alternatives",
      "open source eval tools related tools",
    ]);
  });
});

describe("applyHardConstraintRejections", () => {
  const timeRange = resolveExecutorTimeRange({
    query: "what happened today",
    timeRange: { preset: "today" },
  });

  it("rejects results outside the requested time range", () => {
    if (!timeRange) {
      throw new Error("time range missing");
    }
    const result = applyHardConstraintRejections({
      request: { query: "what happened today", timeRange: { preset: "today" } },
      timeRange,
      results: [
        {
          path: "events/old",
          startLine: 0,
          endLine: 0,
          score: 0.7,
          snippet: "old",
          source: "conversation",
          timestamp: new Date("2001-01-01T00:00:00.000Z"),
        },
      ],
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("outside requested time range");
  });

  it("rejects results without exact evidence when required", () => {
    const result = applyHardConstraintRejections({
      request: { query: "exact", needExactEvidence: true },
      results: [
        {
          path: "",
          startLine: 0,
          endLine: 0,
          score: 0.7,
          snippet: "no locator",
          source: "conversation",
        },
      ],
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("missing exact evidence locator");
  });
});

describe("requestHasHardConstraints", () => {
  it("treats conversation scope as a hard constraint", () => {
    expect(
      requestHasHardConstraints({
        query: "hello",
        conversationScope: { sessionKey: "session-1" },
      }),
    ).toBe(true);
  });

  it("treats explicit scoped filters as hard constraints", () => {
    expect(
      requestHasHardConstraints({
        query: "decision",
        structuredScope: { type: "decision" },
      }),
    ).toBe(true);
  });
});

describe("buildMemorySearchRequestSignature", () => {
  it("is stable across object key ordering", () => {
    const left = buildMemorySearchRequestSignature({
      query: "hello",
      referenceScope: { category: "docs", tags: ["a", "b"] },
    });
    const right = buildMemorySearchRequestSignature({
      query: "hello",
      referenceScope: { tags: ["a", "b"], category: "docs" },
    });
    expect(left).toBe(right);
  });
});
