import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const MONGO_TOOLS = [
  "memory_search",
  "memory_active_slate",
  "memory_discovery_projection",
  "memory_context_bundle",
  "memory_get",
  "kb_search",
  "memory_write",
];

describe("buildAgentSystemPrompt ClawMongo memory guidance", () => {
  it("includes MongoDB memory guidance when memory tools are available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: MONGO_TOOLS,
      memoryBackend: "mongodb",
    });

    expect(prompt).toContain("## ClawMongo Memory");
    expect(prompt).toContain("MongoDB is the durable runtime memory store.");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_write");
    expect(prompt).toContain("memory_context_bundle");
    expect(prompt).toContain("memory_active_slate");
    expect(prompt).toContain("kb_search");
    expect(prompt).toContain("Do not treat workspace files as runtime memory.");
    expect(prompt).not.toContain("MEMORY.md");
  });

  it("omits unavailable memory tool guidance", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get"],
      memoryBackend: "mongodb",
    });

    expect(prompt).toContain("## ClawMongo Memory");
    expect(prompt).toContain("memory_search");
    expect(prompt).not.toContain("memory_write");
    expect(prompt).not.toContain("kb_search");
  });

  it("does not include memory guidance when memory tools are unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read", "write"],
      memoryBackend: "mongodb",
    });

    expect(prompt).not.toContain("## ClawMongo Memory");
  });
});
