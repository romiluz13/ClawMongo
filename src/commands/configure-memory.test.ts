import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const mockNote = vi.hoisted(() => vi.fn());
vi.mock("../terminal/note.js", () => ({ note: mockNote }));

const mockResolvePackageName = vi.hoisted(() => vi.fn(async () => "openclaw"));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageName: mockResolvePackageName,
}));

const mockSelect = vi.hoisted(() => vi.fn());
const mockText = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn());
vi.mock("./configure.shared.js", () => ({
  select: mockSelect,
  text: mockText,
  confirm: mockConfirm,
}));

vi.mock("./onboard-helpers.js", () => ({
  guardCancel: (value: unknown) => value,
}));

const mockAttemptAutoSetup = vi.hoisted(() =>
  vi.fn(async () => ({ success: false as const, reason: "Auto-setup unavailable" })),
);
vi.mock("../wizard/mongodb-auto-setup.js", () => ({
  attemptAutoSetup: mockAttemptAutoSetup,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("configureMemorySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePackageName.mockResolvedValue("openclaw");
    mockAttemptAutoSetup.mockResolvedValue({ success: false, reason: "Auto-setup unavailable" });
  });

  it("pins ClawMongo to community-mongot with automated embeddings", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    mockSelect.mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb://localhost:27017/openclaw");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    const result = await configureMemorySection({}, createRuntime());

    expect(result.memory?.backend).toBeUndefined();
    expect(result.memory?.mongodb?.deploymentProfile).toBe("community-mongot");
    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("pinned to MongoDB Community + mongot with automatic embeddings"),
      "Memory",
    );
  });

  it("disables change streams by default on standalone community setup", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    mockSelect.mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb://localhost:27017/openclaw");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    const result = await configureMemorySection({}, createRuntime());

    expect(result.memory?.backend).toBeUndefined();
    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
  });

  it("preserves existing explicit change-stream setting", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    const config: OpenClawConfig = {
      memory: {
        backend: "mongodb",
        mongodb: { enableChangeStreams: false },
      },
    };
    mockSelect.mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb://localhost:27017/openclaw");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    const result = await configureMemorySection(config, createRuntime());

    expect(result.memory?.mongodb?.enableChangeStreams).toBe(false);
  });

  it("shows no-docker local hint when auto-setup fails due docker absence", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
    mockAttemptAutoSetup.mockResolvedValueOnce({
      success: false,
      reason: "Docker is not installed. Enter a MongoDB URI manually.",
    });
    mockSelect.mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb://localhost:27017/openclaw");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    await configureMemorySection({}, createRuntime());

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("Docker is optional. Local MongoDB works without Docker."),
      "Local MongoDB (No Docker)",
    );
  });

  it("normalizes explicit backend config to MongoDB-only memory settings", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    mockSelect.mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb://localhost:27017/openclaw");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await configureMemorySection(
      {
        memory: {
          backend: "mongodb",
          citations: "on",
          mongodb: { enableChangeStreams: true },
        },
      },
      createRuntime(),
    );

    expect(result.memory?.citations).toBe("on");
    expect(result.memory?.backend).toBeUndefined();
    expect(result.memory?.mongodb?.uri).toBe("mongodb://localhost:27017/openclaw");
  });
});
