import {
  createKBSearchTool,
  createMemoryGetTool,
  createMemorySearchTool,
  createMemoryWriteTool,
} from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
export function createRuntimeTools() {
  return {
    createKBSearchTool,
    createMemoryGetTool,
    createMemorySearchTool,
    createMemoryWriteTool,
    registerMemoryCli,
  };
}
