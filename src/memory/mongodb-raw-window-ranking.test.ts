import { describe, expect, it } from "vitest";
import { rankRawWindowEvents } from "./mongodb-raw-window-ranking.js";

describe("rankRawWindowEvents", () => {
  it("prefers subject-specific evidence over generic recent conversation noise", () => {
    const targetSubject = "contradiction-owner-abc123";
    const results = rankRawWindowEvents(
      [
        {
          eventId: "generic-newer",
          body: "Ownership clarification for payment-service: Sarah owns the production database right now after Mike handed it off.",
          metadata: { subject: "payment-service" },
          timestamp: new Date("2026-04-06T12:05:00.000Z"),
        },
        {
          eventId: "target",
          body: `Ownership clarification for ${targetSubject}: Sarah owns the production database right now after Mike handed it off.`,
          metadata: { subject: targetSubject, phase: "contradiction-correction" },
          timestamp: new Date("2026-04-06T12:00:00.000Z"),
        },
      ],
      `who owns the ${targetSubject} production database right now`,
      5,
    );

    expect(results[0]?.canonicalId).toBe("target");
    expect(results[0]?.snippet).toContain(targetSubject);
  });

  it("falls back to recency ordering when the query has no useful anchor terms", () => {
    const results = rankRawWindowEvents(
      [
        {
          eventId: "older",
          body: "Completed the deployment checklist.",
          timestamp: new Date("2026-04-06T09:00:00.000Z"),
        },
        {
          eventId: "newer",
          body: "Investigated the latest error rate spike.",
          timestamp: new Date("2026-04-06T10:00:00.000Z"),
        },
      ],
      "what happened today",
      5,
    );

    expect(results.map((result) => result.canonicalId)).toEqual(["newer", "older"]);
  });
});
