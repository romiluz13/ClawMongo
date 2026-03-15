import { describe, it, expect } from "vitest";
import {
  planRetrieval,
  type RetrievalPath,
  type RetrievalContext,
} from "./mongodb-retrieval-planner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PATHS: Set<RetrievalPath> = new Set([
  "structured",
  "raw-window",
  "graph",
  "hybrid",
  "kb",
  "episodic",
]);

function makeContext(overrides: Partial<RetrievalContext> = {}): RetrievalContext {
  return {
    availablePaths: ALL_PATHS,
    ...overrides,
  };
}

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
});
