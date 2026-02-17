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

  it("enables change streams by default for atlas profile", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    mockSelect
      .mockResolvedValueOnce("mongodb")
      .mockResolvedValueOnce("atlas-default")
      .mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb+srv://user:pass@cluster.mongodb.net/");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    const result = await configureMemorySection({}, createRuntime());

    expect(result.memory?.backend).toBe("mongodb");
    expect(result.memory?.mongodb?.embeddingMode).toBe("automated");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(true);
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("automated embeddings are enabled by default"),
      "Automated Embeddings",
    );
  });

  it("disables change streams by default for community-bare profile", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    mockSelect
      .mockResolvedValueOnce("mongodb")
      .mockResolvedValueOnce("community-bare")
      .mockResolvedValueOnce("skip");
    // Atlas URI avoids topology probing in this unit test.
    mockText.mockResolvedValueOnce("mongodb+srv://user:pass@cluster.mongodb.net/");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    const result = await configureMemorySection({}, createRuntime());

    expect(result.memory?.backend).toBe("mongodb");
    expect(result.memory?.mongodb?.embeddingMode).toBe("managed");
    expect(result.memory?.mongodb?.enableChangeStreams).toBe(false);
  });

  it("preserves existing explicit change-stream setting", async () => {
    const { configureMemorySection } = await import("./configure-memory.js");
    const config: OpenClawConfig = {
      memory: {
        backend: "mongodb",
        mongodb: { enableChangeStreams: false },
      },
    };
    mockSelect
      .mockResolvedValueOnce("mongodb")
      .mockResolvedValueOnce("atlas-default")
      .mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb+srv://user:pass@cluster.mongodb.net/");
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
    mockSelect
      .mockResolvedValueOnce("mongodb")
      .mockResolvedValueOnce("community-bare")
      .mockResolvedValueOnce("skip");
    mockText.mockResolvedValueOnce("mongodb://localhost:27017/openclaw");
    mockConfirm.mockResolvedValueOnce(false); // skip connection test

    await configureMemorySection({}, createRuntime());

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("Docker is optional. Local MongoDB works without Docker."),
      "Local MongoDB (No Docker)",
    );
  });
});
