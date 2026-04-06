import { describe, it, expect } from "vitest";
import { computeImportanceDecay } from "./mongodb-result-trust.js";

describe("computeImportanceDecay", () => {
  const now = new Date("2026-04-07T12:00:00Z");

  it("7-day-old event with importance=1.0 returns ~0.5", () => {
    const createdAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = computeImportanceDecay(1.0, createdAt, now, 7);
    // 1.0 * 0.5^(7/7) = 0.5
    expect(result).toBeCloseTo(0.5, 2);
  });

  it("brand new event (0 days old) with importance=1.0 returns ~1.0", () => {
    const result = computeImportanceDecay(1.0, now, now, 7);
    // 1.0 * 0.5^(0/7) = 1.0
    expect(result).toBeCloseTo(1.0, 2);
  });

  it("missing importance defaults to 0.5", () => {
    const result = computeImportanceDecay(undefined, now, now, 7);
    // default 0.5 * 0.5^(0/7) = 0.5
    expect(result).toBeCloseTo(0.5, 2);
  });

  it("missing createdAt returns raw importance unchanged", () => {
    const result = computeImportanceDecay(0.8, undefined, now, 7);
    // No decay applied: returns clamped raw importance
    expect(result).toBeCloseTo(0.8, 2);
  });
});
