import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt MongoDB decision tree", () => {
  it("includes decision tree when memoryBackend is mongodb and memory tools available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search", "memory_write"],
      memoryBackend: "mongodb",
    });

    // Decision tree for storing information
    expect(prompt).toContain("When storing information:");
    expect(prompt).toContain("memory_write");
    expect(prompt).toContain("MEMORY.md");

    // Decision tree for searching
    expect(prompt).toContain("When searching:");
    expect(prompt).toContain("kb_search");
    expect(prompt).toContain("memory_search");
  });

  it("includes decision tree header section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search", "memory_write"],
      memoryBackend: "mongodb",
    });

    expect(prompt).toContain("### Memory Routing Guide");
  });

  it("does NOT include decision tree when backend is builtin", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get"],
      memoryBackend: "builtin",
    });

    expect(prompt).not.toContain("### Memory Routing Guide");
    expect(prompt).not.toContain("When storing information:");
    expect(prompt).not.toContain("When searching:");
  });

  it("does NOT include decision tree when memoryBackend is undefined", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get"],
    });

    expect(prompt).not.toContain("### Memory Routing Guide");
  });

  it("omits kb_search routing when kb_search tool is not available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "memory_write"],
      memoryBackend: "mongodb",
    });

    // Should still have the section
    expect(prompt).toContain("### Memory Routing Guide");
    // Should NOT mention kb_search in the routing guide searching section
    // (the "When to use each tool" section above also mentions it, but the routing guide should omit it)
    expect(prompt).toContain("When storing information:");
    // kb_search mention in routing should be absent when tool not available
    expect(prompt).not.toContain("Reference docs, imported files, architecture specs -> kb_search");
  });

  it("omits memory_write routing when memory_write tool is not available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search"],
      memoryBackend: "mongodb",
    });

    expect(prompt).toContain("### Memory Routing Guide");
    // Should NOT mention memory_write in the storing section
    expect(prompt).not.toContain("Structured data (decisions, preferences, facts) -> memory_write");
  });

  it("renders all 5 callers consistently: decision tree present with mongodb backend", () => {
    // Verify the decision tree is rendered via the shared buildAgentSystemPrompt function
    // All 5 callers (attempt.ts, compact.ts, helpers.ts, commands-context-report.ts,
    // pi-embedded-runner/system-prompt.ts) use the same function, so this validates them all
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search", "memory_write"],
      memoryBackend: "mongodb",
    });

    // The decision tree is within the Memory Recall section
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("### Memory Routing Guide");
    expect(prompt).toContain("When storing information:");
    expect(prompt).toContain("When searching:");
  });
});

describe("buildAgentSystemPrompt MongoDB bridge section", () => {
  it("renders bridge section AFTER Project Context when memoryBackend=mongodb and isMinimal=false", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search", "memory_write"],
      memoryBackend: "mongodb",
      contextFiles: [
        { path: "AGENTS.md", content: "Write it down to a file." },
        { path: "SOUL.md", content: "These files are your memory." },
      ],
    });

    // Bridge section must be present
    expect(prompt).toContain("## MongoDB Memory Integration");
    expect(prompt).toContain("The MongoDB memory backend is active.");
    expect(prompt).toContain("memory_search FIRST");
    expect(prompt).toContain("memory_write");
    expect(prompt).toContain("kb_search");
    expect(prompt).toContain("MEMORY.md is for informal scratch notes only");

    // Bridge must appear AFTER the context files content (AGENTS.md/SOUL.md)
    const bridgeIndex = prompt.indexOf("## MongoDB Memory Integration");
    const agentsIndex = prompt.indexOf("Write it down to a file.");
    const soulIndex = prompt.indexOf("These files are your memory.");
    expect(bridgeIndex).toBeGreaterThan(agentsIndex);
    expect(bridgeIndex).toBeGreaterThan(soulIndex);

    // Bridge must appear BEFORE the Silent Replies section
    const silentIndex = prompt.indexOf("## Silent Replies");
    expect(bridgeIndex).toBeLessThan(silentIndex);
  });

  it("does NOT render bridge section for builtin backend", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get"],
      memoryBackend: "builtin",
      contextFiles: [{ path: "AGENTS.md", content: "Write it down to a file." }],
    });

    expect(prompt).not.toContain("## MongoDB Memory Integration");
    expect(prompt).not.toContain("The MongoDB memory backend is active.");
  });

  it("does NOT render bridge section when isMinimal=true (subagent mode)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search", "memory_write"],
      memoryBackend: "mongodb",
      promptMode: "minimal",
    });

    expect(prompt).not.toContain("## MongoDB Memory Integration");
    expect(prompt).not.toContain("The MongoDB memory backend is active.");
  });

  it("does NOT render bridge section when memoryBackend is undefined", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get"],
      contextFiles: [{ path: "AGENTS.md", content: "Write it down to a file." }],
    });

    expect(prompt).not.toContain("## MongoDB Memory Integration");
  });

  it("omits memory_write line in bridge when tool not available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search"],
      memoryBackend: "mongodb",
    });

    expect(prompt).toContain("## MongoDB Memory Integration");
    expect(prompt).toContain("memory_search FIRST");
    expect(prompt).toContain("kb_search");
    expect(prompt).not.toContain("use memory_write");
  });

  it("omits kb_search line in bridge when tool not available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "memory_write"],
      memoryBackend: "mongodb",
    });

    expect(prompt).toContain("## MongoDB Memory Integration");
    expect(prompt).toContain("memory_search FIRST");
    expect(prompt).toContain("memory_write");
    expect(prompt).not.toContain("kb_search");
  });
});
