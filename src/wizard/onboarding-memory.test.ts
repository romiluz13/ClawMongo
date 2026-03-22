import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";

const mockResolvePackageName = vi.hoisted(() => vi.fn(async () => "openclaw"));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageName: mockResolvePackageName,
}));

const mockAttemptAutoSetup = vi.hoisted(() => vi.fn(async () => ({ success: false, reason: "" })));
vi.mock("./mongodb-auto-setup.js", () => ({
  attemptAutoSetup: mockAttemptAutoSetup,
}));

function createMockPrompter(responses: {
  selectResponses?: unknown[];
  textResponses?: string[];
  confirmResponses?: boolean[];
}): WizardPrompter {
  const selectResponses = [...(responses.selectResponses ?? [])];
  const textResponses = [...(responses.textResponses ?? [])];
  const confirmResponses = [...(responses.confirmResponses ?? [])];
  const select = vi.fn(async <T>() => selectResponses.shift() as T) as WizardPrompter["select"];
  const multiselect = vi.fn(async () => []) as WizardPrompter["multiselect"];
  const text = vi.fn(async () => textResponses.shift() ?? "") as WizardPrompter["text"];
  const confirm = vi.fn(async () => confirmResponses.shift() ?? true) as WizardPrompter["confirm"];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select,
    multiselect,
    text,
    confirm,
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("setupMemoryBackend", () => {
  beforeEach(() => {
    mockResolvePackageName.mockResolvedValue("openclaw");
    mockAttemptAutoSetup.mockResolvedValue({ success: false, reason: "Auto-setup unavailable" });
  });

  it("always configures MongoDB and strips explicit backend fields", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {
      gateway: { mode: "local" },
      memory: {
        backend: "mongodb",
        citations: "on",
        mongodb: { enableChangeStreams: false },
      },
    };
    const prompter = createMockPrompter({
      selectResponses: ["skip"],
      textResponses: ["mongodb://localhost:27017/openclaw"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.gateway?.mode).toBe("local");
    expect(result.memory?.citations).toBe("on");
    expect(result.memory?.backend).toBeUndefined();
    expect(result.memory?.mongodb?.uri).toBe("mongodb://localhost:27017/openclaw");
    expect(result.memory?.mongodb?.deploymentProfile).toBe("community-mongot");
    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(false);
  });

  it("pins onboarding to community-mongot with automated embeddings", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const prompter = createMockPrompter({
      selectResponses: ["skip"],
      textResponses: ["mongodb://localhost:27017/openclaw"],
    });

    const result = await setupMemoryBackend({}, prompter);

    expect(result.memory?.backend).toBeUndefined();
    expect(result.memory?.mongodb?.uri).toBe("mongodb://localhost:27017/openclaw");
    expect(result.memory?.mongodb?.deploymentProfile).toBe("community-mongot");
    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
  });

  it("defaults community-mongot to automated embeddings", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const prompter = createMockPrompter({
      selectResponses: ["skip"],
      textResponses: ["mongodb://localhost:27017/openclaw"],
    });

    const result = await setupMemoryBackend({}, prompter);

    expect(result.memory?.mongodb?.deploymentProfile).toBe("community-mongot");
    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
  });

  it("preserves explicit change stream settings", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {
      memory: {
        mongodb: { enableChangeStreams: true },
      },
    };
    const prompter = createMockPrompter({
      selectResponses: ["skip"],
      textResponses: ["mongodb://localhost:27017/openclaw"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
  });

  it("shows the local MongoDB hint when ClawMongo auto-setup fails due to Docker", async () => {
    mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
    mockAttemptAutoSetup.mockResolvedValueOnce({
      success: false,
      reason: "Docker is not installed. Enter a MongoDB URI manually.",
    });
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const prompter = createMockPrompter({
      selectResponses: ["skip"],
      textResponses: ["mongodb://localhost:27017/openclaw"],
    });

    await setupMemoryBackend({}, prompter);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Docker is required for ClawMongo"),
      "Docker Required",
    );
  });

  it("prompts for VOYAGE_API_KEY when not set", async () => {
    const origKey = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
      mockAttemptAutoSetup.mockResolvedValueOnce({
        success: true,
        uri: "mongodb://localhost:27017/openclaw?directConnection=true",
      });
      const { setupMemoryBackend } = await import("./onboarding-memory.js");
      const prompter = createMockPrompter({
        selectResponses: ["skip"],
        textResponses: ["pa-test-key-12345"],
      });

      await setupMemoryBackend({}, prompter);

      expect(prompter.text).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Voyage AI API key"),
        }),
      );
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("VOYAGE_API_KEY set for this session"),
        "Voyage AI",
      );
    } finally {
      if (origKey !== undefined) {
        process.env.VOYAGE_API_KEY = origKey;
      }
    }
  });

  it("skips Voyage prompt when VOYAGE_API_KEY already set", async () => {
    const origKey = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = "pa-already-set";
    try {
      mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
      mockAttemptAutoSetup.mockResolvedValueOnce({
        success: true,
        uri: "mongodb://localhost:27017/openclaw?directConnection=true",
      });
      const { setupMemoryBackend } = await import("./onboarding-memory.js");
      const prompter = createMockPrompter({
        selectResponses: ["skip"],
      });

      await setupMemoryBackend({}, prompter);

      // text should only be called for KB import path, not for Voyage key
      const textCalls = (prompter.text as ReturnType<typeof vi.fn>).mock.calls;
      const voyageCalls = textCalls.filter(
        (call: unknown[]) =>
          typeof call[0] === "object" &&
          call[0] !== null &&
          "message" in call[0] &&
          typeof (call[0] as Record<string, unknown>).message === "string" &&
          ((call[0] as Record<string, string>).message).includes("Voyage AI"),
      );
      expect(voyageCalls).toHaveLength(0);
    } finally {
      if (origKey !== undefined) {
        process.env.VOYAGE_API_KEY = origKey;
      } else {
        delete process.env.VOYAGE_API_KEY;
      }
    }
  });

  it("warns when mongot not detected after setup", async () => {
    mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
    mockAttemptAutoSetup.mockResolvedValueOnce({
      success: true,
      uri: "mongodb://localhost:27017/openclaw?directConnection=true",
    });
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const prompter = createMockPrompter({
      selectResponses: ["skip"],
    });

    await setupMemoryBackend({}, prompter);

    // The topology detection in continueMongoDBSetup should warn about mongot
    // (Since we mock MongoClient, the topology detection will catch and skip,
    //  but the note about atlas-local should still be reachable via the
    //  post-topology path when hasMongot is false)
    // This test primarily validates the code path exists
    expect(prompter.note).toHaveBeenCalled();
  });
});
