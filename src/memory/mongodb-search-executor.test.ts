import { describe, expect, it, vi } from "vitest";
import {
  analyzeContradictionCorrection,
  analyzeCorrectionNeeded,
  analyzeFreshnessCorrection,
  applyHardConstraintRejections,
  applyMMRReranking,
  buildExecutorPasses,
  buildMemorySearchRequestSignature,
  classifyExecutorSearch,
  executeMongoSearchPlan,
  identifyRelaxableConstraint,
  normalizeMemorySearchRequest,
  requestHasHardConstraints,
  resolveExecutorTimeRange,
} from "./mongodb-search-executor.js";
import type { MemorySearchResult } from "./types.js";

describe("normalizeMemorySearchRequest", () => {
  it("applies bounded defaults for mode and passes without forcing source order", () => {
    const normalized = normalizeMemorySearchRequest({ query: " hello " });
    expect(normalized.query).toBe(" hello ");
    expect(normalized.searchMode).toBe("auto");
    expect(normalized.maxPasses).toBe(2);
    expect(normalized.sourcePreference).toEqual([]);
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

  it("decomposes comparison queries into focused subject passes", () => {
    const passes = buildExecutorPasses(
      normalizeMemorySearchRequest({
        query: "compare MongoDB and Postgres",
        searchMode: "agentic",
      }),
      "comparison",
    );
    expect(passes.map((pass) => pass.query)).toEqual([
      "compare MongoDB and Postgres",
      "MongoDB overview",
      "Postgres overview",
    ]);
  });

  it("decomposes multi-hop queries into clause-focused follow-up passes", () => {
    const passes = buildExecutorPasses(
      normalizeMemorySearchRequest({
        query:
          "Who worked on the Istio service mesh config and what rollback procedures did they define?",
        searchMode: "agentic",
      }),
      "multi-hop",
    );
    expect(passes.map((pass) => pass.query)).toEqual([
      "Who worked on the Istio service mesh config and what rollback procedures did they define?",
      "Who worked on the Istio service mesh config",
      "Istio service mesh config rollback procedures",
    ]);
  });

  it("gives direct current-state auto queries a bounded freshness follow-up", () => {
    const passes = buildExecutorPasses(
      normalizeMemorySearchRequest({
        query: "who owns the production database right now",
        searchMode: "auto",
        maxPasses: 2,
      }),
      "direct",
    );
    expect(passes.map((pass) => pass.query)).toEqual([
      "who owns the production database right now",
      "who owns the production database right now latest status",
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

// ---------------------------------------------------------------------------
// executeMongoSearchPlan orchestration tests
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    path: overrides.path ?? "chunks/abc",
    startLine: 0,
    endLine: 0,
    score: overrides.score ?? 0.8,
    snippet: overrides.snippet ?? "test snippet",
    source: overrides.source ?? "conversation",
    canonicalId: overrides.canonicalId ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    ...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
    ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.signals ? { signals: overrides.signals } : {}),
    ...(overrides.trust ? { trust: overrides.trust } : {}),
  };
}

function makeMockExecutePass(passResults: MemorySearchResult[][]) {
  let callIdx = 0;
  return vi.fn().mockImplementation(async () => {
    const results = passResults[callIdx] ?? [];
    callIdx++;
    return {
      results,
      metadata: {
        plan: { paths: ["hybrid"], confidence: "high" as const, reasoning: "test" },
        pathsExecuted: ["hybrid"],
        resultsByPath: { hybrid: results.length },
        reranked: false,
        queryRewritten: false,
      },
    };
  });
}

describe("executeMongoSearchPlan", () => {
  const allPaths = new Set([
    "active-critical",
    "structured",
    "raw-window",
    "graph",
    "hybrid",
    "kb",
    "episodic",
    "procedural",
  ] as const);

  it("executes a single pass for a direct query", async () => {
    const r1 = makeResult({ canonicalId: "r1" });
    const mock = makeMockExecutePass([[r1]]);

    const response = await executeMongoSearchPlan({
      request: { query: "what is Bloom", searchMode: "direct" },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.metadata.passes).toHaveLength(1);
    expect(response.metadata.classification).toBe("direct");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.canonicalId).toBe("r1");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not narrow direct auto queries to conversation lanes when no source preference was given", async () => {
    const mock = vi.fn().mockResolvedValue({
      results: [makeResult({ canonicalId: "critical", source: "structured" })],
      metadata: {
        plan: {
          paths: ["active-critical", "hybrid"],
          confidence: "high" as const,
          reasoning: "test",
        },
        pathsExecuted: ["active-critical"],
        resultsByPath: { "active-critical": 1 },
        reranked: false,
        queryRewritten: false,
      },
    });

    await executeMongoSearchPlan({
      request: { query: "what's the situation in Israel right now", searchMode: "auto" },
      availablePaths: allPaths,
      executePass: mock,
    });

    const firstCall = mock.mock.calls[0]?.[0];
    expect(firstCall?.availablePaths.has("active-critical")).toBe(true);
    expect(firstCall?.availablePaths.has("hybrid")).toBe(true);
  });

  it("accumulates results across multiple passes for family queries", async () => {
    const r1 = makeResult({ canonicalId: "r1", snippet: "result from pass 1" });
    const r2 = makeResult({ canonicalId: "r2", snippet: "result from pass 2" });
    const mock = makeMockExecutePass([[r1], [r2]]);

    const response = await executeMongoSearchPlan({
      request: { query: "eval tools family", searchMode: "agentic", maxPasses: 3 },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.metadata.classification).toBe("family");
    expect(response.metadata.passes.length).toBeGreaterThanOrEqual(2);
    expect(response.results).toHaveLength(2);
    const ids = response.results.map((r) => r.canonicalId);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });

  it("terminates early when family query accumulates enough results", async () => {
    const results = [
      makeResult({ canonicalId: "r1" }),
      makeResult({ canonicalId: "r2" }),
      makeResult({ canonicalId: "r3" }),
    ];
    const mock = makeMockExecutePass([results, [makeResult({ canonicalId: "r4" })]]);

    const response = await executeMongoSearchPlan({
      request: { query: "eval tools family", searchMode: "agentic", maxPasses: 3, maxResults: 3 },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.results).toHaveLength(3);
    // Early termination: pass 2 should not be called because pass 1 returned >= min(maxResults, 3) = 3
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates results with the same canonicalId across passes", async () => {
    const shared = makeResult({ canonicalId: "shared-id", snippet: "same chunk" });
    const unique = makeResult({ canonicalId: "unique-id", snippet: "different chunk" });
    const mock = makeMockExecutePass([[shared], [{ ...shared }, unique]]);

    const response = await executeMongoSearchPlan({
      request: { query: "eval tools family", searchMode: "agentic", maxPasses: 3 },
      availablePaths: allPaths,
      executePass: mock,
    });

    const ids = response.results.map((r) => r.canonicalId);
    expect(ids.filter((id) => id === "shared-id")).toHaveLength(1);
    expect(ids).toContain("unique-id");
  });

  it("propagates hard constraint rejections into metadata", async () => {
    const oldResult = makeResult({
      canonicalId: "old",
      timestamp: new Date("2001-01-01T00:00:00.000Z"),
    });
    const mock = makeMockExecutePass([[oldResult]]);

    const response = await executeMongoSearchPlan({
      request: {
        query: "what happened today",
        searchMode: "direct",
        timeRange: { preset: "today" },
        needExactEvidence: true,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.results).toHaveLength(0);
    expect(response.metadata.resultsRejected.length).toBeGreaterThan(0);
    expect(response.metadata.resultsRejected[0]?.reason).toBe("outside requested time range");
    expect(response.metadata.noDirectEvidenceReason).toContain("No exact-evidence results");
    expect(response.metadata.abstained).toBe(true);
    expect(response.metadata.abstainReason).toContain("No exact-evidence results");
  });

  it("returns noDirectEvidenceReason when needExactEvidence filters all results", async () => {
    // Result with no canonicalId and empty path — fails resultHasExactEvidence
    const noLocator: MemorySearchResult = {
      path: "",
      startLine: 0,
      endLine: 0,
      score: 0.8,
      snippet: "no locator snippet",
      source: "conversation",
    };
    const mock = makeMockExecutePass([[noLocator]]);

    const response = await executeMongoSearchPlan({
      request: { query: "find exact", searchMode: "direct", needExactEvidence: true },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.results).toHaveLength(0);
    expect(response.metadata.noDirectEvidenceReason).toContain("No exact-evidence results");
    expect(response.metadata.abstained).toBe(true);
    expect(response.metadata.abstainReason).toContain("No exact-evidence results");
  });

  it("merges pathsExecuted and resultsByPath across passes", async () => {
    const hybridResult = makeResult({ canonicalId: "h1" });
    const kbResult = makeResult({ canonicalId: "kb1" });
    const pass3Result = makeResult({ canonicalId: "p3" });
    const mockPass = vi
      .fn()
      .mockResolvedValueOnce({
        results: [hybridResult],
        metadata: {
          plan: { paths: ["hybrid"], confidence: "high" as const, reasoning: "pass 1" },
          pathsExecuted: ["hybrid"],
          resultsByPath: { hybrid: 1 },
          reranked: false,
          queryRewritten: false,
        },
      })
      .mockResolvedValueOnce({
        results: [kbResult],
        metadata: {
          plan: { paths: ["kb"], confidence: "high" as const, reasoning: "pass 2" },
          pathsExecuted: ["kb"],
          resultsByPath: { kb: 1 },
          reranked: true,
          queryRewritten: true,
        },
      })
      .mockResolvedValueOnce({
        results: [pass3Result],
        metadata: {
          plan: { paths: ["procedural"], confidence: "high" as const, reasoning: "pass 3" },
          pathsExecuted: ["procedural"],
          resultsByPath: { procedural: 1 },
          reranked: false,
          queryRewritten: false,
        },
      });

    const response = await executeMongoSearchPlan({
      request: { query: "eval tools family", searchMode: "agentic", maxPasses: 3 },
      availablePaths: allPaths,
      executePass: mockPass,
    });

    expect(response.metadata.pathsExecuted).toContain("hybrid");
    expect(response.metadata.pathsExecuted).toContain("kb");
    expect(response.metadata.resultsByPath.hybrid).toBe(1);
    expect(response.metadata.resultsByPath.kb).toBe(1);
    expect(response.metadata.passes.length).toBeGreaterThanOrEqual(2);
    expect(response.metadata.queriesTried.length).toBeGreaterThanOrEqual(2);
  });

  it("triggers CRAG corrective pass when evidence coverage is none", async () => {
    // All main-loop passes return results outside time range → rejected → coverage "none"
    const oldResult = makeResult({
      canonicalId: "old",
      timestamp: new Date("2001-01-01T00:00:00.000Z"),
    });
    // Corrective pass: returns a valid result within widened time range
    const validResult = makeResult({ canonicalId: "valid", timestamp: new Date() });
    // Temporal agentic query generates 2 planned passes + 1 corrective = 3 mock calls needed
    const mock = makeMockExecutePass([[oldResult], [oldResult], [validResult]]);

    const response = await executeMongoSearchPlan({
      request: {
        query: "what happened recently",
        searchMode: "agentic",
        maxPasses: 3,
        timeRange: { preset: "today" },
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    // The corrective pass should have fired
    const correctivePasses = response.metadata.passes.filter((p) => p.correctionApplied);
    expect(correctivePasses.length).toBeGreaterThanOrEqual(1);
    expect(correctivePasses[0]?.correctionApplied).toBe("time-range-widened-2x");
  });

  it("triggers constraint relaxation when all results are rejected", async () => {
    // All passes return results outside time range → all rejected → relaxation fires
    const oldResult = makeResult({
      canonicalId: "old",
      timestamp: new Date("2001-01-01T00:00:00.000Z"),
    });
    // Relaxation pass returns result without time constraint
    const anyResult = makeResult({ canonicalId: "any" });
    const mock = vi
      .fn()
      // Pass 1 (main): returns old result
      .mockResolvedValueOnce({
        results: [oldResult],
        metadata: {
          plan: { paths: ["hybrid"], confidence: "high" as const, reasoning: "pass 1" },
          pathsExecuted: ["hybrid"],
          resultsByPath: { hybrid: 1 },
          reranked: false,
          queryRewritten: false,
        },
      })
      // Corrective pass: also returns old result
      .mockResolvedValueOnce({
        results: [oldResult],
        metadata: {
          plan: { paths: ["hybrid"], confidence: "high" as const, reasoning: "corrective" },
          pathsExecuted: ["hybrid"],
          resultsByPath: { hybrid: 1 },
          reranked: false,
          queryRewritten: false,
        },
      })
      // Relaxation pass: returns valid result
      .mockResolvedValueOnce({
        results: [anyResult],
        metadata: {
          plan: { paths: ["hybrid"], confidence: "high" as const, reasoning: "relaxation" },
          pathsExecuted: ["hybrid"],
          resultsByPath: { hybrid: 1 },
          reranked: false,
          queryRewritten: false,
        },
      });

    const response = await executeMongoSearchPlan({
      request: {
        query: "some query",
        searchMode: "direct",
        timeRange: { preset: "today" },
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.metadata.constraintRelaxations).toBeDefined();
    expect(response.metadata.constraintRelaxations?.[0]?.action).toBe("removed-time-range");
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("does not stop early on stale current-state hits when a fresher follow-up pass is available", async () => {
    const stale = makeResult({
      canonicalId: "stale-owner",
      path: "structured:owner-stale",
      snippet: "Current owner of the production database is Mike.",
      signals: {
        state: "active",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2025-10-01T00:00:00.000Z"),
        reviewAt: new Date("2025-11-01T00:00:00.000Z"),
      },
    });
    const fresh = makeResult({
      canonicalId: "fresh-owner",
      path: "events/fresh-owner",
      snippet: "Sarah owns the production database right now after the handoff.",
      timestamp: new Date(),
    });
    const mock = makeMockExecutePass([[stale], [fresh]]);

    const response = await executeMongoSearchPlan({
      request: {
        query: "who owns the production database right now",
        searchMode: "auto",
        maxPasses: 2,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(response.results[0]?.snippet.toLowerCase()).toContain("sarah");
  });

  it("fires freshness corrective retrieval when direct current-state results stay stale", async () => {
    const stale = makeResult({
      canonicalId: "stale-owner",
      path: "structured:owner-stale",
      snippet: "Current owner of the production database is Mike.",
      signals: {
        state: "active",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2025-10-01T00:00:00.000Z"),
        reviewAt: new Date("2025-11-01T00:00:00.000Z"),
      },
    });
    const fresh = makeResult({
      canonicalId: "fresh-owner",
      path: "events/fresh-owner",
      snippet: "Sarah owns the production database right now after the handoff.",
      timestamp: new Date(),
    });
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        results: [stale],
        metadata: {
          plan: { paths: ["structured"], confidence: "high" as const, reasoning: "pass 1" },
          pathsExecuted: ["structured"],
          resultsByPath: { structured: 1 },
          reranked: false,
          queryRewritten: false,
          trustApplied: true,
        },
      })
      .mockResolvedValueOnce({
        results: [fresh],
        metadata: {
          plan: { paths: ["raw-window"], confidence: "medium" as const, reasoning: "corrective" },
          pathsExecuted: ["raw-window"],
          resultsByPath: { "raw-window": 1 },
          reranked: false,
          queryRewritten: false,
          trustApplied: true,
        },
      });

    const response = await executeMongoSearchPlan({
      request: {
        query: "who owns the production database right now",
        searchMode: "direct",
        maxPasses: 2,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    const correctivePass = response.metadata.passes.find(
      (pass) => pass.correctionApplied === "freshness-rebalanced",
    );
    expect(correctivePass).toBeDefined();
    expect(response.results[0]?.snippet.toLowerCase()).toContain("sarah");
    const secondCall = mock.mock.calls[1]?.[0];
    expect(secondCall?.availablePaths.has("raw-window")).toBe(true);
    expect(secondCall?.availablePaths.has("structured")).toBe(true);
    expect(secondCall?.sourcePreference).toEqual(["conversation", "structured"]);
  });

  it("does not stop early on conflicted current-state hits when a disambiguating follow-up pass is available", async () => {
    const conflicted = makeResult({
      canonicalId: "owner-conflicted",
      path: "structured:owner-conflicted",
      snippet: "Current owner of the production database is Mike.",
      signals: {
        state: "conflicted",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2026-04-01T00:00:00.000Z"),
        conflictCount: 1,
      },
    });
    const fresh = makeResult({
      canonicalId: "owner-resolution",
      path: "events/owner-resolution",
      snippet: "Sarah owns the production database right now after the handoff.",
      timestamp: new Date(),
    });
    const mock = makeMockExecutePass([[conflicted], [fresh]]);

    const response = await executeMongoSearchPlan({
      request: {
        query: "who owns the production database right now",
        searchMode: "auto",
        maxPasses: 2,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(response.results[0]?.snippet.toLowerCase()).toContain("sarah");
  });

  it("fires contradiction corrective retrieval when current-state results are conflicted", async () => {
    const conflicted = makeResult({
      canonicalId: "owner-conflicted",
      path: "structured:owner-conflicted",
      snippet: "Current owner of the production database is Mike.",
      signals: {
        state: "conflicted",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2026-04-01T00:00:00.000Z"),
        conflictCount: 1,
      },
    });
    const fresh = makeResult({
      canonicalId: "owner-resolution",
      path: "events/owner-resolution",
      snippet: "Sarah owns the production database right now after the handoff.",
      timestamp: new Date(),
    });
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        results: [conflicted],
        metadata: {
          plan: { paths: ["structured"], confidence: "high" as const, reasoning: "pass 1" },
          pathsExecuted: ["structured"],
          resultsByPath: { structured: 1 },
          reranked: false,
          queryRewritten: false,
          trustApplied: true,
        },
      })
      .mockResolvedValueOnce({
        results: [fresh],
        metadata: {
          plan: {
            paths: ["raw-window", "graph"],
            confidence: "medium" as const,
            reasoning: "corrective",
          },
          pathsExecuted: ["raw-window", "graph"],
          resultsByPath: { "raw-window": 1, graph: 0 },
          reranked: false,
          queryRewritten: false,
          trustApplied: true,
        },
      });

    const response = await executeMongoSearchPlan({
      request: {
        query: "who owns the production database right now",
        searchMode: "direct",
        maxPasses: 2,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    const correctivePass = response.metadata.passes.find(
      (pass) => pass.correctionApplied === "conflict-evidence-required",
    );
    expect(correctivePass).toBeDefined();
    expect(response.results[0]?.snippet.toLowerCase()).toContain("sarah");
    expect(response.metadata.contradictionSummary?.status).toBe("detected");
    expect(response.metadata.contradictionSummary?.exactResolutionAvailable).toBe(true);
    expect(response.metadata.contradictionSummary?.topResultConflicted).toBe(false);
    const secondCall = mock.mock.calls[1]?.[0];
    expect(secondCall?.availablePaths.has("raw-window")).toBe(true);
    expect(secondCall?.availablePaths.has("structured")).toBe(true);
    expect(secondCall?.availablePaths.has("graph")).toBe(true);
    expect(secondCall?.availablePaths.has("hybrid")).toBe(false);
    expect(secondCall?.sourcePreference).toEqual(["conversation", "graph", "structured"]);
  });

  it("skips active-critical on anchored structured queries so current-state facts do not drown exact subject matches", async () => {
    const mock = vi.fn().mockResolvedValue({
      results: [],
      metadata: {
        plan: { paths: ["structured"], confidence: "high" as const, reasoning: "anchored" },
        pathsExecuted: ["structured"],
        resultsByPath: { structured: 0 },
        reranked: false,
        queryRewritten: false,
        trustApplied: true,
      },
    });

    await executeMongoSearchPlan({
      request: {
        query: "who owns the contradiction-owner-abc123 production database right now",
        searchMode: "direct",
        sourcePreference: ["structured"],
        maxPasses: 1,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    const firstCall = mock.mock.calls[0]?.[0];
    expect(firstCall?.availablePaths.has("structured")).toBe(true);
    expect(firstCall?.availablePaths.has("active-critical")).toBe(false);
  });

  it("does not treat stale exact structured memory as conflict resolution support", async () => {
    const stale = makeResult({
      canonicalId: "owner-stale",
      path: "structured:owner-stale",
      snippet: "Mike owns the production database right now.",
      signals: {
        state: "active",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2026-03-01T00:00:00.000Z"),
        reviewAt: new Date("2026-03-15T00:00:00.000Z"),
      },
    });
    const conflicted = makeResult({
      canonicalId: "owner-conflicted",
      path: "structured:owner-conflicted",
      snippet: "Ownership is conflicted for the production database right now.",
      signals: {
        state: "conflicted",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2026-04-01T00:00:00.000Z"),
        conflictCount: 1,
      },
    });
    const fresh = makeResult({
      canonicalId: "owner-resolution",
      path: "events/owner-resolution",
      snippet: "Sarah owns the production database right now after the handoff.",
      timestamp: new Date("2026-04-06T00:00:00.000Z"),
    });
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        results: [stale, conflicted],
        metadata: {
          plan: { paths: ["structured"], confidence: "high" as const, reasoning: "pass 1" },
          pathsExecuted: ["structured"],
          resultsByPath: { structured: 2 },
          reranked: false,
          queryRewritten: false,
          trustApplied: true,
        },
      })
      .mockResolvedValueOnce({
        results: [fresh],
        metadata: {
          plan: {
            paths: ["raw-window", "graph"],
            confidence: "medium" as const,
            reasoning: "corrective",
          },
          pathsExecuted: ["raw-window", "graph"],
          resultsByPath: { "raw-window": 1, graph: 0 },
          reranked: false,
          queryRewritten: false,
          trustApplied: true,
        },
      });

    const response = await executeMongoSearchPlan({
      request: {
        query: "who owns the production database right now",
        searchMode: "direct",
        maxPasses: 2,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    const correctivePass = response.metadata.passes.find(
      (pass) => pass.correctionApplied === "conflict-evidence-required",
    );
    expect(correctivePass).toBeDefined();
    expect(response.results[0]?.snippet.toLowerCase()).toContain("sarah");
  });

  it("reports unresolved contradiction metadata when only conflicted current-state memory remains", async () => {
    const conflicted = makeResult({
      canonicalId: "owner-conflicted",
      path: "structured:owner-conflicted",
      snippet: "Current owner of the production database is Mike.",
      signals: {
        state: "conflicted",
        temporalScope: "ongoing",
        lastConfirmedAt: new Date("2026-04-01T00:00:00.000Z"),
        conflictCount: 1,
      },
    });
    const mock = makeMockExecutePass([[conflicted]]);

    const response = await executeMongoSearchPlan({
      request: {
        query: "who owns the production database right now",
        searchMode: "direct",
        maxPasses: 1,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(response.results).toHaveLength(1);
    expect(response.metadata.contradictionSummary).toEqual({
      status: "unresolved",
      conflictedResults: 1,
      invalidatedResults: 0,
      lowTrustResults: 1,
      exactResolutionAvailable: false,
      topResultConflicted: true,
    });
    expect(response.metadata.abstained).toBe(false);
  });

  it("continues into a decomposition pass for multi-hop queries when the first pass is thin", async () => {
    const mock = makeMockExecutePass([
      [
        makeResult({
          canonicalId: "istio-owner",
          snippet: "Sarah worked on the Istio service mesh config.",
        }),
      ],
      [
        makeResult({
          canonicalId: "rollback-procedure",
          snippet: "Rollback procedures were defined in the incident playbook.",
        }),
      ],
    ]);

    const response = await executeMongoSearchPlan({
      request: {
        query:
          "Who worked on the Istio service mesh config and what rollback procedures did they define?",
        searchMode: "agentic",
        maxPasses: 3,
      },
      availablePaths: allPaths,
      executePass: mock,
    });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(response.metadata.queriesTried[1]).toBe("Who worked on the Istio service mesh config");
    expect(response.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// analyzeCorrectionNeeded unit tests
// ---------------------------------------------------------------------------

describe("analyzeCorrectionNeeded", () => {
  it("returns needed:false when coverage is direct", () => {
    expect(
      analyzeCorrectionNeeded({
        evidenceCoverage: "direct",
        rejected: [{ reason: "outside requested time range" }],
        passCount: 1,
        maxPasses: 3,
      }),
    ).toEqual({ needed: false });
  });

  it("identifies time-range correction when dominant rejection is temporal", () => {
    const result = analyzeCorrectionNeeded({
      evidenceCoverage: "none",
      rejected: [
        { reason: "outside requested time range" },
        { reason: "outside requested time range" },
        { reason: "missing exact evidence locator" },
      ],
      passCount: 1,
      maxPasses: 3,
    });
    expect(result.needed).toBe(true);
    expect(result.correction).toBe("time-range-widened-2x");
  });

  it("identifies evidence relaxation when dominant rejection is locator", () => {
    const result = analyzeCorrectionNeeded({
      evidenceCoverage: "indirect",
      rejected: [{ reason: "missing exact evidence locator" }],
      passCount: 1,
      maxPasses: 2,
    });
    expect(result.needed).toBe(true);
    expect(result.correction).toBe("hybrid-evidence-relaxed");
  });

  it("returns needed:false when all passes exhausted", () => {
    expect(
      analyzeCorrectionNeeded({
        evidenceCoverage: "none",
        rejected: [{ reason: "outside requested time range" }],
        passCount: 3,
        maxPasses: 3,
      }),
    ).toEqual({ needed: false });
  });
});

describe("analyzeFreshnessCorrection", () => {
  it("requests correction when current-state results are stale and passes remain", () => {
    const result = analyzeFreshnessCorrection({
      query: "who owns the production database right now",
      accepted: [
        makeResult({
          path: "structured:owner-stale",
          snippet: "Current owner is Mike.",
          signals: {
            state: "active",
            temporalScope: "ongoing",
            lastConfirmedAt: new Date("2025-10-01T00:00:00.000Z"),
            reviewAt: new Date("2025-11-01T00:00:00.000Z"),
          },
        }),
      ],
      passCount: 1,
      maxPasses: 2,
      now: new Date("2026-04-05T00:00:00.000Z"),
    });
    expect(result).toEqual({
      needed: true,
      correction: "freshness-rebalanced",
      reason: "current-state results were stale or weak",
    });
  });

  it("does not request correction when a fresh current-state result is already present", () => {
    expect(
      analyzeFreshnessCorrection({
        query: "who owns the production database right now",
        accepted: [
          makeResult({
            path: "events/fresh-owner",
            snippet: "Sarah owns the production database right now.",
            timestamp: new Date("2026-04-05T00:00:00.000Z"),
          }),
        ],
        passCount: 1,
        maxPasses: 2,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toEqual({ needed: false });
  });
});

describe("analyzeContradictionCorrection", () => {
  it("requests correction when current-state results are conflicted and unresolved", () => {
    expect(
      analyzeContradictionCorrection({
        query: "who owns the production database right now",
        accepted: [
          makeResult({
            path: "structured:owner-conflicted",
            snippet: "Current owner is Mike.",
            signals: {
              state: "conflicted",
              temporalScope: "ongoing",
              conflictCount: 1,
            },
          }),
        ],
        passCount: 1,
        maxPasses: 2,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toEqual({
      needed: true,
      correction: "conflict-evidence-required",
      reason: "current-state results were conflicted or contradictory",
    });
  });

  it("does not request correction when exact non-conflicted evidence is already present", () => {
    expect(
      analyzeContradictionCorrection({
        query: "who owns the production database right now",
        accepted: [
          makeResult({
            path: "events/fresh-owner",
            snippet: "Sarah owns the production database right now.",
            timestamp: new Date("2026-04-05T00:00:00.000Z"),
          }),
          makeResult({
            path: "structured:owner-conflicted",
            snippet: "Current owner is Mike.",
            signals: {
              state: "conflicted",
              temporalScope: "ongoing",
              conflictCount: 1,
            },
          }),
        ],
        passCount: 1,
        maxPasses: 2,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toEqual({ needed: false });
  });
});

// ---------------------------------------------------------------------------
// identifyRelaxableConstraint unit tests
// ---------------------------------------------------------------------------

describe("identifyRelaxableConstraint", () => {
  it("returns null for empty rejections", () => {
    expect(identifyRelaxableConstraint([])).toBeNull();
  });

  it("identifies time range as relaxable constraint", () => {
    const result = identifyRelaxableConstraint([
      { reason: "outside requested time range" },
      { reason: "outside requested time range" },
    ]);
    expect(result).toEqual({ constraint: "timeRange", action: "removed-time-range" });
  });

  it("identifies exact evidence as relaxable constraint", () => {
    const result = identifyRelaxableConstraint([{ reason: "missing exact evidence locator" }]);
    expect(result).toEqual({
      constraint: "needExactEvidence",
      action: "disabled-exact-evidence",
    });
  });
});

// ---------------------------------------------------------------------------
// applyMMRReranking unit tests
// ---------------------------------------------------------------------------

describe("applyMMRReranking", () => {
  it("returns unchanged results for fewer than 3 items", () => {
    const results: MemorySearchResult[] = [
      makeResult({ snippet: "one", score: 0.9 }),
      makeResult({ snippet: "two", score: 0.8 }),
    ];
    const { results: mmrResults, mmrApplied } = applyMMRReranking({
      results,
      classification: "family",
    });
    expect(mmrApplied).toBe(false);
    expect(mmrResults).toHaveLength(2);
  });

  it("applies MMR reranking for family queries with 3+ results", () => {
    const results: MemorySearchResult[] = [
      makeResult({ snippet: "kubernetes helm chart deployment rollback procedure", score: 0.9 }),
      makeResult({ snippet: "kubernetes helm chart deployment rollback steps", score: 0.85 }),
      makeResult({ snippet: "monitoring grafana dashboard alerts notification", score: 0.8 }),
    ];
    const {
      results: mmrResults,
      mmrApplied,
      mmrLambda,
    } = applyMMRReranking({
      results,
      classification: "family",
    });
    expect(mmrApplied).toBe(true);
    expect(mmrLambda).toBe(0.3);
    expect(mmrResults).toHaveLength(3);
    // First result always stays (highest score)
    expect(mmrResults[0]?.snippet).toContain("kubernetes helm chart deployment rollback procedure");
    // MMR with lambda=0.3 (high diversity) should promote the diverse result over the similar one
    expect(mmrResults[1]?.snippet).toContain("monitoring grafana");
  });

  it("uses higher lambda for direct classification (relevance-dominant)", () => {
    const results: MemorySearchResult[] = [
      makeResult({ snippet: "result a specific topic exact", score: 0.95 }),
      makeResult({ snippet: "result b specific topic exact match", score: 0.9 }),
      makeResult({ snippet: "result c completely different content", score: 0.85 }),
    ];
    const { mmrLambda, mmrApplied } = applyMMRReranking({
      results,
      classification: "direct",
    });
    expect(mmrApplied).toBe(true);
    expect(mmrLambda).toBe(0.7);
  });

  it("preserves all results without losing any", () => {
    const results: MemorySearchResult[] = [
      makeResult({ canonicalId: "a", snippet: "alpha beta gamma", score: 0.9 }),
      makeResult({ canonicalId: "b", snippet: "delta epsilon zeta", score: 0.85 }),
      makeResult({ canonicalId: "c", snippet: "eta theta iota", score: 0.8 }),
      makeResult({ canonicalId: "d", snippet: "kappa lambda mu", score: 0.75 }),
    ];
    const { results: mmrResults } = applyMMRReranking({
      results,
      classification: "comparison",
    });
    expect(mmrResults).toHaveLength(4);
    const ids = new Set(mmrResults.map((r) => r.canonicalId));
    expect(ids.size).toBe(4);
  });
});
