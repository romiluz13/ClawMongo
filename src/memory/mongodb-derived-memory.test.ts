import { describe, expect, it } from "vitest";
import {
  extractProcedureCandidatesFromEvent,
  extractStructuredCandidatesFromEvent,
  heuristicEpisodeSummarizer,
} from "./mongodb-derived-memory.js";

describe("mongodb-derived-memory", () => {
  it("promotes crisis-like user statements into active critical structured facts", () => {
    const candidates = extractStructuredCandidatesFromEvent({
      eventId: "evt-1",
      agentId: "agent-1",
      role: "user",
      body: "Remember this: there is war in Israel right now and it is critical context.",
      timestamp: new Date("2026-03-21T10:00:00Z"),
      scope: "agent",
      scopeRef: "agent:agent-1",
    });

    const activeContext = candidates.find((candidate) => candidate.salience === "critical");
    expect(activeContext).toBeTruthy();
    expect(activeContext?.type).toBe("fact");
    expect(activeContext?.temporalScope).toBe("ongoing");
    expect(activeContext?.sourceEventIds).toEqual(["evt-1"]);
  });

  it("promotes explicit preferences into structured preference memory", () => {
    const candidates = extractStructuredCandidatesFromEvent({
      eventId: "evt-2",
      agentId: "agent-1",
      role: "user",
      body: "I prefer concise answers with direct tradeoffs.",
      timestamp: new Date("2026-03-21T10:00:00Z"),
      scope: "agent",
      scopeRef: "agent:agent-1",
    });

    expect(candidates.some((candidate) => candidate.type === "preference")).toBe(true);
  });

  it("extracts procedures from assistant workflow-style responses", () => {
    const procedures = extractProcedureCandidatesFromEvent({
      eventId: "evt-3",
      agentId: "agent-1",
      role: "assistant",
      body: [
        "For incident response:",
        "1. Check current service status.",
        "2. Notify the team lead.",
        "3. Escalate if customer impact continues.",
      ].join("\n"),
      timestamp: new Date("2026-03-21T10:00:00Z"),
      scope: "agent",
      scopeRef: "agent:agent-1",
    });

    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.name).toBe("incident response");
    expect(procedures[0]?.steps).toEqual([
      "Check current service status.",
      "Notify the team lead.",
      "Escalate if customer impact continues.",
    ]);
  });

  it("extracts procedures from flattened inline numbered assistant responses", () => {
    const procedures = extractProcedureCandidatesFromEvent({
      eventId: "evt-3b",
      agentId: "agent-1",
      role: "assistant",
      body: "For incident response: 1. Check current service status. 2. Notify the team lead. 3. Escalate if customer impact continues.",
      timestamp: new Date("2026-03-21T10:00:00Z"),
      scope: "agent",
      scopeRef: "agent:agent-1",
    });

    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.steps).toEqual([
      "Check current service status.",
      "Notify the team lead.",
      "Escalate if customer impact continues.",
    ]);
  });

  it("does not turn assistant procedures into active critical facts just because they mention incidents", () => {
    const candidates = extractStructuredCandidatesFromEvent({
      eventId: "evt-4",
      agentId: "agent-1",
      role: "assistant",
      body: "For incident response: 1. Check current service status. 2. Notify the team lead.",
      timestamp: new Date("2026-03-21T10:00:00Z"),
      scope: "agent",
      scopeRef: "agent:agent-1",
    });

    expect(candidates.some((candidate) => candidate.salience === "critical")).toBe(false);
  });

  it("builds deterministic heuristic episode summaries", async () => {
    const summary = await heuristicEpisodeSummarizer([
      {
        role: "user",
        body: "We hit a production outage in the billing pipeline.",
        timestamp: new Date("2026-03-21T09:00:00Z"),
      },
      {
        role: "assistant",
        body: "We should check MongoDB status, then notify the billing team.",
        timestamp: new Date("2026-03-21T09:05:00Z"),
      },
    ]);

    expect(summary.title.length).toBeGreaterThan(0);
    expect(summary.summary).toContain("2 messages");
    expect(summary.tags?.length).toBeGreaterThan(0);
  });
});
