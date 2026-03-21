import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test/helpers/extensions/plugin-runtime-mock.js";
import plugin, { buildPromptSection } from "./index.js";

function createApi() {
  const runtime = createPluginRuntimeMock();
  const registerTool = vi.fn();
  const registerCli = vi.fn();
  const api = {
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

    plugin.register(api as never);

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

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toEqual([]);
  });

  it("returns Memory Recall section when memory_search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("returns Memory Recall section when memory_get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });
});
