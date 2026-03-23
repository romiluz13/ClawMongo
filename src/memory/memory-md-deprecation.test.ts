/**
 * MEMORY.md Deprecation Verification Test
 *
 * Validates that MEMORY.md has been fully removed from the ClawMongo runtime:
 * - No MEMORY.md constants exported from workspace.ts
 * - System prompt contains zero MEMORY.md mentions
 * - Memory flush prompts contain zero MEMORY.md mentions
 * - internal.ts isMemoryPath rejects MEMORY.md root files
 * - internal.ts listMemoryFiles skips MEMORY.md root files
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import * as workspace from "../agents/workspace.js";
import {
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
} from "../auto-reply/reply/memory-flush.js";
import { isMemoryPath, listMemoryFiles } from "./internal.js";

describe("MEMORY.md deprecation", () => {
  // --- Workspace constants ---
  it("does not export DEFAULT_MEMORY_FILENAME from workspace", () => {
    expect("DEFAULT_MEMORY_FILENAME" in workspace).toBe(false);
  });

  it("does not export DEFAULT_MEMORY_ALT_FILENAME from workspace", () => {
    expect("DEFAULT_MEMORY_ALT_FILENAME" in workspace).toBe(false);
  });

  // --- System prompt ---
  it("system prompt (mongodb backend) does not mention MEMORY.md", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get", "kb_search", "memory_write"],
      memoryBackend: "mongodb",
    });
    expect(prompt).not.toContain("MEMORY.md");
  });

  // --- Memory flush prompts ---
  it("DEFAULT_MEMORY_FLUSH_PROMPT does not mention MEMORY.md", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).not.toContain("MEMORY.md");
  });

  it("DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT does not mention MEMORY.md", () => {
    expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).not.toContain("MEMORY.md");
  });

  // --- isMemoryPath ---
  it("isMemoryPath rejects MEMORY.md root file", () => {
    expect(isMemoryPath("MEMORY.md")).toBe(false);
  });

  it("isMemoryPath rejects memory.md root file", () => {
    expect(isMemoryPath("memory.md")).toBe(false);
  });

  it("isMemoryPath still accepts memory/ subdirectory files", () => {
    expect(isMemoryPath("memory/2026-03-01.md")).toBe(true);
  });

  // --- listMemoryFiles ---
  describe("listMemoryFiles skips root MEMORY.md", () => {
    let tmpDir = "";
    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-md-deprecation-"));
    });
    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("does not include root MEMORY.md even when file exists", async () => {
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# bridge note");
      await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "memory", "2026-03-01.md"), "# daily");

      const files = await listMemoryFiles(tmpDir);
      const basenames = files.map((f) => path.basename(f));
      expect(basenames).not.toContain("MEMORY.md");
      expect(basenames).toContain("2026-03-01.md");
    });
  });
});
