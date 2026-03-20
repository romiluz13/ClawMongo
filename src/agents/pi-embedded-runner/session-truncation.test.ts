import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { truncateSessionAfterCompaction } from "./session-truncation.js";

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-truncation-test-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeAssistant(text: string, timestamp: number) {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    timestamp,
  });
}

function createSessionWithCompaction(sessionDir: string): string {
  const sessionManager = SessionManager.create(sessionDir, sessionDir);
  sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  sessionManager.appendMessage(makeAssistant("hi there", 2));
  sessionManager.appendMessage({ role: "user", content: "do something", timestamp: 3 });
  sessionManager.appendMessage(makeAssistant("done", 4));

  const branch = sessionManager.getBranch();
  sessionManager.appendCompaction(
    "Summary of conversation so far.",
    branch[branch.length - 1].id,
    5000,
  );

  sessionManager.appendMessage({ role: "user", content: "next task", timestamp: 5 });
  sessionManager.appendMessage(makeAssistant("working on it", 6));
  return sessionManager.getSessionFile()!;
}

describe("truncateSessionAfterCompaction", () => {
  it("removes summarized messages and keeps a valid session transcript", async () => {
    const sessionFile = createSessionWithCompaction(await createTmpDir());

    const before = SessionManager.open(sessionFile);
    const entriesBefore = before.getEntries().length;

    const result = await truncateSessionAfterCompaction({ sessionFile });

    expect(result.truncated).toBe(true);
    expect(result.entriesRemoved).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore!);

    const after = SessionManager.open(sessionFile);
    expect(after.getEntries().length).toBeLessThan(entriesBefore);
    expect(after.getBranch()[0].type).toBe("message");
    expect(after.getBranch()[0].parentId).toBeNull();
    expect(after.getBranch()[1].type).toBe("compaction");
    expect(after.buildSessionContext().messages.length).toBeGreaterThan(0);
  });

  it("is idempotent after the summarized entries are removed", async () => {
    const sessionFile = createSessionWithCompaction(await createTmpDir());

    expect((await truncateSessionAfterCompaction({ sessionFile })).truncated).toBe(true);
    const second = await truncateSessionAfterCompaction({ sessionFile });

    expect(second.truncated).toBe(false);
    expect(second.reason).toBe("no entries to remove");
  });

  it("preserves non-message session state entries", async () => {
    const dir = await createTmpDir();
    const sessionManager = SessionManager.create(dir, dir);

    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendMessage(makeAssistant("hi", 2));
    sessionManager.appendModelChange("anthropic", "claude-sonnet-4-5-20250514");
    sessionManager.appendThinkingLevelChange("high");
    sessionManager.appendCustomEntry("my-extension", { key: "value" });
    sessionManager.appendSessionInfo("my session");
    sessionManager.appendMessage({ role: "user", content: "do task", timestamp: 3 });
    sessionManager.appendMessage(makeAssistant("done", 4));

    const branch = sessionManager.getBranch();
    sessionManager.appendCompaction("Summary.", branch[branch.length - 1].id, 5000);
    sessionManager.appendMessage({ role: "user", content: "next", timestamp: 5 });

    const result = await truncateSessionAfterCompaction({
      sessionFile: sessionManager.getSessionFile()!,
    });

    expect(result.truncated).toBe(true);

    const after = SessionManager.open(sessionManager.getSessionFile()!);
    const types = after.getEntries().map((entry) => entry.type);
    expect(types).toContain("model_change");
    expect(types).toContain("thinking_level_change");
    expect(types).toContain("custom");
    expect(types).toContain("session_info");
    expect(types).toContain("compaction");
    expect(after.buildSessionContext().thinkingLevel).toBe("high");
  });

  it("can archive the pre-truncation transcript", async () => {
    const dir = await createTmpDir();
    const sessionFile = createSessionWithCompaction(dir);
    const archivePath = path.join(dir, "archive", "backup.jsonl");

    const result = await truncateSessionAfterCompaction({ sessionFile, archivePath });

    expect(result.truncated).toBe(true);
    expect(
      await fs
        .stat(archivePath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect((await fs.stat(archivePath)).size).toBeGreaterThan((await fs.stat(sessionFile)).size);
  });
});
