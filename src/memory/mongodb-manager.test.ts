import { describe, it, expect } from "vitest";
import { deduplicateSearchResults } from "./mongodb-manager.js";
import type { MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Phase 3: Result dedup at merge by content hash
// ---------------------------------------------------------------------------

describe("deduplicateSearchResults", () => {
  const makeResult = (
    filePath: string,
    snippet: string,
    score: number,
    source: MemorySearchResult["source"],
  ): MemorySearchResult => ({
    filePath,
    path: filePath,
    startLine: 1,
    endLine: 1,
    snippet,
    score,
    source,
  });

  it("removes duplicate results by content, keeping the highest-scoring one", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "same content here", 0.9, "memory"),
      makeResult("/b.md", "same content here", 0.7, "kb"),
      makeResult("/c.md", "different content", 0.8, "sessions"),
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(2);
    // The duplicate "same content here" should keep the one with score 0.9
    const sameContentResult = deduped.find((r) => r.snippet === "same content here");
    expect(sameContentResult?.score).toBe(0.9);
    expect(sameContentResult?.filePath).toBe("/a.md");
  });

  it("returns empty array for empty input", () => {
    const deduped = deduplicateSearchResults([]);
    expect(deduped).toHaveLength(0);
  });

  it("keeps all results when no duplicates exist", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "first content", 0.9, "memory"),
      makeResult("/b.md", "second content", 0.7, "kb"),
      makeResult("/c.md", "third content", 0.5, "sessions"),
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(3);
  });

  it("handles multiple duplicates correctly", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "alpha content", 0.3, "memory"),
      makeResult("/b.md", "alpha content", 0.9, "kb"),
      makeResult("/c.md", "alpha content", 0.5, "structured"),
      makeResult("/d.md", "beta content", 0.8, "memory"),
      makeResult("/e.md", "beta content", 0.6, "sessions"),
    ];

    const deduped = deduplicateSearchResults(results);
    expect(deduped).toHaveLength(2);
    const alpha = deduped.find((r) => r.snippet === "alpha content");
    expect(alpha?.score).toBe(0.9);
    const beta = deduped.find((r) => r.snippet === "beta content");
    expect(beta?.score).toBe(0.8);
  });

  it("returns dedupCount in the result when logging is needed", () => {
    const results: MemorySearchResult[] = [
      makeResult("/a.md", "dup content", 0.9, "memory"),
      makeResult("/b.md", "dup content", 0.7, "kb"),
    ];

    // The function should return deduped results — the count of removed duplicates
    // can be derived from input.length - output.length
    const deduped = deduplicateSearchResults(results);
    const dedupCount = results.length - deduped.length;
    expect(dedupCount).toBe(1);
  });
});
