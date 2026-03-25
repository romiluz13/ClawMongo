import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MongoDB-backed runtime memory, which may include bridge notes synced from memory/*.md; then use memory_get to pull only the needed lines from a specific note or file when appropriate. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MongoDB-backed runtime memory, which may include bridge notes synced from memory/*.md, and answer from the matching results. If low confidence after search, say you checked.";
  } else {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
  }

  const lines = ["## Memory Recall", toolGuidance];
  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "Mongo-canonical runtime memory tools and CLI",
  kind: "memory",
  register(api) {
    api.registerMemoryPromptSection(buildPromptSection);

    api.registerTool(
      (ctx) =>
        api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_search"] },
    );

    api.registerTool(
      (ctx) =>
        api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_get"] },
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
