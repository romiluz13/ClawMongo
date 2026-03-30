import { describe, it, expect, vi, afterEach } from "vitest";
import {
  planRetrieval,
  resolveTimeRangePreset,
  type RetrievalPath,
  type RetrievalContext,
} from "./mongodb-retrieval-planner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PATHS: Set<RetrievalPath> = new Set([
  "active-critical",
  "structured",
  "raw-window",
  "graph",
  "hybrid",
  "kb",
  "episodic",
  "procedural",
]);

function makeContext(overrides: Partial<RetrievalContext> = {}): RetrievalContext {
  return {
    availablePaths: ALL_PATHS,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-retrieval-planner", () => {
  it("routes 'remember that I prefer dark mode' to structured first", () => {
    const plan = planRetrieval("remember that I prefer dark mode", makeContext());
    expect(plan.paths[0]).toBe("structured");
  });

  it("routes 'what happened today' to raw-window first", () => {
    const plan = planRetrieval("what happened today", makeContext());
    expect(plan.paths[0]).toBe("raw-window");
  });

  it("routes current-situation queries to active-critical first", () => {
    const plan = planRetrieval("what's the situation in Israel right now", makeContext());
    expect(plan.paths[0]).toBe("active-critical");
    expect(plan.constraints?.activeCritical?.salience).toEqual(["critical", "high"]);
  });

  it("routes query with known entity name to graph first", () => {
    const ctx = makeContext({ knownEntityNames: ["Alice"] });
    const plan = planRetrieval("what does Alice work on", ctx);
    expect(plan.paths[0]).toBe("graph");
  });

  it("routes generic recall query to hybrid first (no strong signal)", () => {
    const plan = planRetrieval("tell me about the project", makeContext());
    expect(plan.paths[0]).toBe("hybrid");
  });

  it("routes 'give me a recap of the deployment' to episodic first", () => {
    const plan = planRetrieval("give me a recap of the deployment", makeContext());
    expect(plan.paths[0]).toBe("episodic");
  });

  it("routes workflow queries to procedural first", () => {
    const plan = planRetrieval("what is the runbook for rotating auth keys", makeContext());
    expect(plan.paths[0]).toBe("procedural");
  });

  it("routes 'what's in the docs about authentication' to kb first", () => {
    const plan = planRetrieval("what's in the docs about authentication", makeContext());
    expect(plan.paths[0]).toBe("kb");
  });

  it("returns confidence and reasoning fields", () => {
    const plan = planRetrieval("remember that I prefer dark mode", makeContext());
    expect(plan.confidence).toBeDefined();
    expect(["high", "medium", "low"]).toContain(plan.confidence);
    expect(typeof plan.reasoning).toBe("string");
    expect(plan.reasoning.length).toBeGreaterThan(0);
  });

  it("extracts a hard time constraint for yesterday queries", () => {
    const plan = planRetrieval("what did we decide yesterday", makeContext());
    expect(plan.constraints?.timeRange?.preset).toBe("yesterday");
    expect(plan.constraints?.timeRange?.hard).toBe(true);
  });

  it("extracts a structured type constraint for decision queries", () => {
    const plan = planRetrieval("what was the decision about auth rollout", makeContext());
    expect(plan.constraints?.structured?.type).toBe("decision");
    expect(plan.paths[0]).toBe("structured");
  });

  it("extracts a KB source constraint for API queries", () => {
    const plan = planRetrieval("what does the API docs say about auth", makeContext());
    expect(plan.constraints?.kb?.source).toBe("api");
    expect(plan.paths[0]).toBe("kb");
  });

  it("extracts entity constraints from known names", () => {
    const plan = planRetrieval("what does Alice own", makeContext({ knownEntityNames: ["Alice"] }));
    expect(plan.constraints?.entities?.names).toEqual(["Alice"]);
    expect(plan.paths[0]).toBe("graph");
  });

  it("excludes disabled sources from plan", () => {
    const limited = new Set<RetrievalPath>(["structured", "hybrid", "raw-window"]);
    const plan = planRetrieval("what's in the docs about authentication", {
      availablePaths: limited,
    });
    // kb is not in availablePaths, so it must not appear
    expect(plan.paths).not.toContain("kb");
    // All returned paths must be in the available set
    for (const p of plan.paths) {
      expect(limited.has(p)).toBe(true);
    }
  });

  it("handles multiple signals with correct priority order", () => {
    // "remember that" (+3 structured) + "today" (+3 raw-window) + hybrid baseline (+1)
    const plan = planRetrieval("remember that today we decided on dark mode", makeContext());
    // Both structured and raw-window score 3
    // structured keywords: "remember that", "decided" -> structured gets +3 (one match is enough)
    // time keywords: "today" -> raw-window gets +3
    // The order between equal-score paths is implementation-defined,
    // but both must appear before hybrid (score 1)
    const structuredIdx = plan.paths.indexOf("structured");
    const rawWindowIdx = plan.paths.indexOf("raw-window");
    const hybridIdx = plan.paths.indexOf("hybrid");
    expect(structuredIdx).toBeLessThan(hybridIdx);
    expect(rawWindowIdx).toBeLessThan(hybridIdx);
  });

  // -------------------------------------------------------------------
  // REM-FIX: Additional tests for hunter-found issues
  // -------------------------------------------------------------------

  it("returns low confidence for empty query string", () => {
    const plan = planRetrieval("", makeContext());
    expect(plan.confidence).toBe("low");
    expect(plan.reasoning).toBe("empty query");
    // Should include hybrid if available
    if (plan.paths.length > 0) {
      expect(plan.paths).toContain("hybrid");
    }
  });

  it("returns low confidence for whitespace-only query", () => {
    const plan = planRetrieval("   ", makeContext());
    expect(plan.confidence).toBe("low");
    expect(plan.reasoning).toBe("empty query");
  });

  it("empty query without hybrid available returns empty paths", () => {
    const noHybrid = new Set<RetrievalPath>(["structured", "raw-window"]);
    const plan = planRetrieval("", { availablePaths: noHybrid });
    expect(plan.paths).toEqual([]);
    expect(plan.confidence).toBe("low");
  });

  it("does NOT trigger structured for substring match like 'whenever'", () => {
    // "whenever" contains "never" — word-boundary matching should prevent false positive
    const plan = planRetrieval("whenever I do something", makeContext());
    expect(plan.paths[0]).not.toBe("structured");
  });

  it("does NOT trigger graph for empty entity names", () => {
    const ctx = makeContext({ knownEntityNames: [""] });
    const plan = planRetrieval("tell me about the project", ctx);
    // Empty entity name should not match — graph should not be first
    expect(plan.paths[0]).not.toBe("graph");
  });

  it("produces deterministic order for tied scores", () => {
    // Run multiple times to ensure determinism
    const results: string[][] = [];
    for (let i = 0; i < 10; i++) {
      const plan = planRetrieval("tell me about the project", makeContext());
      results.push([...plan.paths]);
    }
    // All results should be identical
    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
  });

  it("routes 'WHAT HAPPENED TODAY' (uppercase) to raw-window first", () => {
    const plan = planRetrieval("WHAT HAPPENED TODAY", makeContext());
    expect(plan.paths[0]).toBe("raw-window");
  });

  it("empty availablePaths returns empty paths with low confidence", () => {
    const plan = planRetrieval("tell me something", { availablePaths: new Set() });
    expect(plan.paths).toEqual([]);
    expect(plan.confidence).toBe("low");
  });

  it("resolves last-7d time preset against a fixed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));

    const range = resolveTimeRangePreset("last-7d");
    expect(range.start.toISOString()).toBe("2026-03-13T12:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-20T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Coverage-aware planner tests
// ---------------------------------------------------------------------------

describe("planRetrieval with lane coverage", () => {
  const emptyCoverage = (hasData: boolean) => ({
    hasData,
    count: hasData ? 10 : 0,
    lastUpdated: hasData ? new Date() : null,
  });

  const fullCoverage = Object.fromEntries(
    [
      "active-critical",
      "structured",
      "raw-window",
      "graph",
      "hybrid",
      "kb",
      "episodic",
      "procedural",
    ].map((lane) => [lane, emptyCoverage(true)]),
  );

  const sparseContext = (overrides?: Partial<RetrievalContext>): RetrievalContext => ({
    availablePaths: ALL_PATHS,
    ...overrides,
  });

  it("skips lanes with hasData=false when coverage provided", () => {
    const coverage = {
      ...fullCoverage,
      graph: emptyCoverage(false),
      episodic: emptyCoverage(false),
    };
    const plan = planRetrieval(
      "who is Alice and give me a recap",
      sparseContext({ laneCoverage: coverage }),
    );
    expect(plan.paths).not.toContain("graph");
    expect(plan.paths).not.toContain("episodic");
    expect(plan.skippedLanes).toContain("graph");
    expect(plan.skippedLanes).toContain("episodic");
  });

  it("includes all lanes when no coverage provided (backward compatible)", () => {
    const plan = planRetrieval("who is Alice and recap today", sparseContext());
    // Without coverage, no lanes are skipped
    expect(plan.skippedLanes).toBeUndefined();
  });

  it("does not skip hybrid lane even with hasData=false (backstop)", () => {
    const coverage = {
      ...fullCoverage,
      hybrid: emptyCoverage(false),
    };
    const plan = planRetrieval(
      "tell me about the project",
      sparseContext({ laneCoverage: coverage }),
    );
    expect(plan.paths).toContain("hybrid");
  });

  it("does not skip raw-window lane even with hasData=false (always has events)", () => {
    const coverage = {
      ...fullCoverage,
      "raw-window": emptyCoverage(false),
    };
    const plan = planRetrieval("what happened today", sparseContext({ laneCoverage: coverage }));
    expect(plan.paths).toContain("raw-window");
  });

  it("does not skip kb lane even with hasData=false (separate ingestion path)", () => {
    const coverage = {
      ...fullCoverage,
      kb: emptyCoverage(false),
    };
    const plan = planRetrieval(
      "what does the docs say about auth",
      sparseContext({ laneCoverage: coverage }),
    );
    expect(plan.paths).toContain("kb");
  });

  it("includes coverage note in reasoning when lanes skipped", () => {
    const coverage = {
      ...fullCoverage,
      procedural: emptyCoverage(false),
    };
    const plan = planRetrieval("how to deploy", sparseContext({ laneCoverage: coverage }));
    expect(plan.reasoning).toContain("skipped empty lanes");
  });

  it("returns skippedLanes in plan", () => {
    const coverage = {
      ...fullCoverage,
      structured: emptyCoverage(false),
      "active-critical": emptyCoverage(false),
    };
    const plan = planRetrieval("remember my preference", sparseContext({ laneCoverage: coverage }));
    expect(plan.skippedLanes).toBeDefined();
    expect(plan.skippedLanes).toContain("structured");
    expect(plan.skippedLanes).toContain("active-critical");
  });

  it("skips episodic lane when episodes hasData=false", () => {
    const coverage = {
      ...fullCoverage,
      episodic: emptyCoverage(false),
    };
    const plan = planRetrieval("give me a recap", sparseContext({ laneCoverage: coverage }));
    expect(plan.paths).not.toContain("episodic");
  });

  it("skips graph lane when graph hasData=false", () => {
    const coverage = {
      ...fullCoverage,
      graph: emptyCoverage(false),
    };
    const plan = planRetrieval(
      "who is connected to Alice",
      sparseContext({
        laneCoverage: coverage,
        knownEntityNames: ["Alice"],
      }),
    );
    expect(plan.paths).not.toContain("graph");
  });
});
