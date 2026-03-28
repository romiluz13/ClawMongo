import { describe, expect, it, vi } from "vitest";
import {
  buildTieredSummaryPrompt,
  parseTieredSummaryResponse,
  withTieredSummaries,
} from "./mongodb-tiered-summary.js";

function makeEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    body: `message ${i}`,
    timestamp: new Date(Date.now() + i * 60_000),
  }));
}

describe("buildTieredSummaryPrompt", () => {
  it("produces prompt with instructions for 3 tiers + topics", () => {
    const events = makeEvents(3);
    const prompt = buildTieredSummaryPrompt(events);
    expect(prompt).toContain("short_term");
    expect(prompt).toContain("medium_term");
    expect(prompt).toContain("long_term");
    expect(prompt).toContain("topics");
  });

  it("includes event text in prompt", () => {
    const events = makeEvents(3);
    const prompt = buildTieredSummaryPrompt(events);
    expect(prompt).toContain("message 0");
    expect(prompt).toContain("message 1");
  });

  it("handles empty events gracefully", () => {
    const prompt = buildTieredSummaryPrompt([]);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("parseTieredSummaryResponse", () => {
  it("parses valid JSON response with all tiers", () => {
    const response = JSON.stringify({
      short_term: "Short summary",
      medium_term: "Medium summary",
      long_term: "Long summary",
      topics: ["topic1", "topic2"],
    });
    const result = parseTieredSummaryResponse(response);
    expect(result).not.toBeNull();
    expect(result!.shortTermSummary).toBe("Short summary");
    expect(result!.mediumTermSummary).toBe("Medium summary");
    expect(result!.longTermSummary).toBe("Long summary");
    expect(result!.topics).toEqual(["topic1", "topic2"]);
  });

  it("returns null for malformed response", () => {
    expect(parseTieredSummaryResponse("not json")).toBeNull();
    expect(parseTieredSummaryResponse("")).toBeNull();
    expect(parseTieredSummaryResponse("{}")).toBeNull();
  });

  it("handles missing optional fields", () => {
    const response = JSON.stringify({
      short_term: "Short",
      medium_term: "Medium",
      long_term: "Long",
    });
    const result = parseTieredSummaryResponse(response);
    expect(result).not.toBeNull();
    expect(result!.topics).toEqual([]);
  });

  it("extracts topics array", () => {
    const response = JSON.stringify({
      short_term: "S",
      medium_term: "M",
      long_term: "L",
      topics: ["a", "b", "c"],
    });
    const result = parseTieredSummaryResponse(response);
    expect(result!.topics).toEqual(["a", "b", "c"]);
  });

  it("parses JSON embedded in markdown code block", () => {
    const response =
      '```json\n{"short_term":"S","medium_term":"M","long_term":"L","topics":["t"]}\n```';
    const result = parseTieredSummaryResponse(response);
    expect(result).not.toBeNull();
    expect(result!.shortTermSummary).toBe("S");
  });
});

describe("withTieredSummaries", () => {
  it("returns base summary + tiered fields when LLM succeeds", async () => {
    const baseSummarizer = vi.fn().mockResolvedValue({
      title: "Test Title",
      summary: "Test Summary",
      tags: ["tag1"],
    });
    const llmFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        short_term: "Short",
        medium_term: "Medium",
        long_term: "Long",
        topics: ["topic1"],
      }),
    );

    const wrapped = withTieredSummaries(baseSummarizer, llmFn);
    const result = await wrapped(makeEvents(3));

    expect(result.title).toBe("Test Title");
    expect(result.summary).toBe("Test Summary");
    expect(result.tags).toEqual(["tag1"]);
    expect(result.shortTermSummary).toBe("Short");
    expect(result.mediumTermSummary).toBe("Medium");
    expect(result.longTermSummary).toBe("Long");
    expect(result.topics).toEqual(["topic1"]);
  });

  it("returns base summary only when LLM fails", async () => {
    const baseSummarizer = vi.fn().mockResolvedValue({
      title: "Test Title",
      summary: "Test Summary",
    });
    const llmFn = vi.fn().mockRejectedValue(new Error("LLM error"));

    const wrapped = withTieredSummaries(baseSummarizer, llmFn);
    const result = await wrapped(makeEvents(3));

    expect(result.title).toBe("Test Title");
    expect(result.summary).toBe("Test Summary");
    expect(result.shortTermSummary).toBeUndefined();
    expect(result.mediumTermSummary).toBeUndefined();
    expect(result.longTermSummary).toBeUndefined();
  });

  it("returns base summary only when no llmFn provided", async () => {
    const baseSummarizer = vi.fn().mockResolvedValue({
      title: "Test Title",
      summary: "Test Summary",
    });

    const wrapped = withTieredSummaries(baseSummarizer);
    const result = await wrapped(makeEvents(3));

    expect(result.title).toBe("Test Title");
    expect(result.summary).toBe("Test Summary");
    expect(result.shortTermSummary).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Regression: withTieredSummaries return type preserves optional fields
  // ---------------------------------------------------------------------------

  it("preserves all optional tiered fields in the return type (type safety regression)", async () => {
    const baseSummarizer = vi.fn().mockResolvedValue({
      title: "Base Title",
      summary: "Base Summary",
      tags: ["base"],
    });
    const llmFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        short_term: "Short term detail",
        medium_term: "Medium term detail",
        long_term: "Long term detail",
        topics: ["alpha", "beta"],
      }),
    );

    const wrapped = withTieredSummaries(baseSummarizer, llmFn);
    const result = await wrapped(makeEvents(3));

    // These fields MUST exist on the returned object (not just be non-null)
    expect("shortTermSummary" in result).toBe(true);
    expect("mediumTermSummary" in result).toBe(true);
    expect("longTermSummary" in result).toBe(true);
    expect("topics" in result).toBe(true);

    // Values must match what the LLM returned
    expect(result.shortTermSummary).toBe("Short term detail");
    expect(result.mediumTermSummary).toBe("Medium term detail");
    expect(result.longTermSummary).toBe("Long term detail");
    expect(result.topics).toEqual(["alpha", "beta"]);

    // Base fields must also be preserved (spread correctness)
    expect(result.title).toBe("Base Title");
    expect(result.summary).toBe("Base Summary");
    expect(result.tags).toEqual(["base"]);
  });

  it("returns base-only result WITHOUT tiered fields when LLM returns unparseable JSON", async () => {
    const baseSummarizer = vi.fn().mockResolvedValue({
      title: "Fallback Title",
      summary: "Fallback Summary",
    });
    const llmFn = vi.fn().mockResolvedValue("This is not JSON at all");

    const wrapped = withTieredSummaries(baseSummarizer, llmFn);
    const result = await wrapped(makeEvents(3));

    expect(result.title).toBe("Fallback Title");
    expect(result.summary).toBe("Fallback Summary");
    // Tiered fields should NOT be set
    expect(result.shortTermSummary).toBeUndefined();
    expect(result.mediumTermSummary).toBeUndefined();
    expect(result.longTermSummary).toBeUndefined();
  });

  it("returns base-only result when LLM JSON has empty string summaries", async () => {
    const baseSummarizer = vi.fn().mockResolvedValue({
      title: "Title",
      summary: "Summary",
    });
    const llmFn = vi.fn().mockResolvedValue(
      JSON.stringify({
        short_term: "",
        medium_term: "Valid",
        long_term: "Valid",
        topics: [],
      }),
    );

    const wrapped = withTieredSummaries(baseSummarizer, llmFn);
    const result = await wrapped(makeEvents(3));

    // parseTieredSummaryResponse returns null for empty strings
    // so base-only result should be returned
    expect(result.title).toBe("Title");
    expect(result.shortTermSummary).toBeUndefined();
  });
});
