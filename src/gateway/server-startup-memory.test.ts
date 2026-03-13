import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getMemorySearchManagerMock, resolveMemoryBackendConfigMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
  resolveMemoryBackendConfigMock: vi.fn(),
}));

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("../memory/backend-config.js", () => ({
  resolveMemoryBackendConfig: resolveMemoryBackendConfigMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

function createMongoConfig(): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
    memory: { mongodb: { uri: "mongodb://localhost:27017/openclaw" } },
  } as OpenClawConfig;
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockReset();
    resolveMemoryBackendConfigMock.mockReset();
    resolveMemoryBackendConfigMock.mockReturnValue({
      backend: "mongodb",
      mongodb: { uri: "mongodb://localhost:27017/openclaw" },
    });
  });

  it("initializes MongoDB memory for each enabled agent", async () => {
    const cfg = createMongoConfig();
    const log = createLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "main" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, { cfg, agentId: "ops" });
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      'mongodb memory startup initialization armed for agent "main"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      'mongodb memory startup initialization armed for agent "ops"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("runs startup sync when the manager exposes sync", async () => {
    const cfg = createMongoConfig();
    const log = createLogMock();
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(sync).toHaveBeenCalledWith({ reason: "startup" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and continues when backend resolution fails", async () => {
    const cfg = createMongoConfig();
    const log = createLogMock();
    resolveMemoryBackendConfigMock.mockImplementationOnce(() => {
      throw new Error('Unsupported memory.backend "custom"');
    });
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'mongodb memory startup initialization failed for agent "main": Unsupported memory.backend "custom"',
    );
    expect(log.info).toHaveBeenCalledWith(
      'mongodb memory startup initialization armed for agent "ops"',
    );
  });

  it("warns when manager creation fails", async () => {
    const cfg = createMongoConfig();
    const log = createLogMock();
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "connection failed" })
      .mockResolvedValueOnce({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'mongodb memory startup initialization failed for agent "main": connection failed',
    );
    expect(log.info).toHaveBeenCalledWith(
      'mongodb memory startup initialization armed for agent "ops"',
    );
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = {
      memory: { mongodb: { uri: "mongodb://localhost:27017/openclaw" } },
      agents: {
        defaults: { memorySearch: { enabled: true } },
        list: [
          { id: "main", default: true },
          { id: "ops", memorySearch: { enabled: false } },
        ],
      },
    } as OpenClawConfig;
    const log = createLogMock();
    getMemorySearchManagerMock.mockResolvedValue({ manager: { search: vi.fn() } });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(log.info).toHaveBeenCalledWith(
      'mongodb memory startup initialization armed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
