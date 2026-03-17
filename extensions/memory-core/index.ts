import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "Mongo-canonical runtime memory tools and CLI",
  kind: "memory",
  register(api) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    api.registerTool(
      (ctx) => {
        const kbSearchTool = api.runtime.tools.createKBSearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!kbSearchTool) {
          return null;
        }
        return kbSearchTool;
      },
      { names: ["kb_search"] },
    );

    api.registerTool(
      (ctx) => {
        const memoryWriteTool = api.runtime.tools.createMemoryWriteTool({
          config: ctx.config,
        });
        if (!memoryWriteTool) {
          return null;
        }
        return memoryWriteTool;
      },
      { names: ["memory_write"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
});
