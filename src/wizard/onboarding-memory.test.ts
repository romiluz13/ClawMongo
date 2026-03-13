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
      expect.stringContaining("Docker is optional. Local MongoDB works without Docker."),
      "Local MongoDB (No Docker)",
    );
  });
});
