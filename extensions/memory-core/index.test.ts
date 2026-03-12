import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../test-utils/plugin-runtime-mock.js";
import plugin from "./index.js";

function createApi() {
  const runtime = createPluginRuntimeMock();
  const registerTool = vi.fn();
  const registerCli = vi.fn();
  const api: OpenClawPluginApi = {
    id: "memory-core",
    name: "Memory (Core)",
    description: "Memory (Core)",
    source: "test",
    config: {},
    runtime,
    logger: { info() {}, warn() {}, error() {} },
    registerTool,
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli,
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  };
  return { api, runtime, registerTool, registerCli };
}

describe("memory-core plugin", () => {
  it("registers all Mongo runtime memory tools", () => {
    const { api, runtime, registerTool } = createApi();
    const memorySearchTool = { name: "memory_search" };
    const memoryGetTool = { name: "memory_get" };
    const kbSearchTool = { name: "kb_search" };
    const memoryWriteTool = { name: "memory_write" };
    vi.mocked(runtime.tools.createMemorySearchTool).mockReturnValue(memorySearchTool as never);
    vi.mocked(runtime.tools.createMemoryGetTool).mockReturnValue(memoryGetTool as never);
    vi.mocked(runtime.tools.createKBSearchTool).mockReturnValue(kbSearchTool as never);
    vi.mocked(runtime.tools.createMemoryWriteTool).mockReturnValue(memoryWriteTool as never);

    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(3);
    const [searchFactory, kbFactory, writeFactory] = registerTool.mock.calls.map(
      (call) => call[0] as (ctx: { config: unknown; sessionKey?: string }) => unknown,
    );
    expect(searchFactory({ config: {}, sessionKey: "agent:main:test" })).toEqual([
      memorySearchTool,
      memoryGetTool,
    ]);
    expect(kbFactory({ config: {}, sessionKey: "agent:main:test" })).toBe(kbSearchTool);
    expect(writeFactory({ config: {}, sessionKey: "agent:main:test" })).toBe(memoryWriteTool);
    expect(runtime.tools.createKBSearchTool).toHaveBeenCalledWith({
      config: {},
      agentSessionKey: "agent:main:test",
    });
    expect(runtime.tools.createMemoryWriteTool).toHaveBeenCalledWith({
      config: {},
    });
  });
});
