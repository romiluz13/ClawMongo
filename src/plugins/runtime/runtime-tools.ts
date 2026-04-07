import {
  createKBSearchTool,
  createMemoryActiveSlateTool,
  createMemoryContextBundleTool,
  createMemoryDiscoveryProjectionTool,
  createMemoryGetTool,
  createMemoryNoveltyScanTool,
  createMemoryReasoningChainTool,
  createMemorySearchTool,
  createMemoryWriteTool,
} from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
export function createRuntimeTools() {
  return {
    createKBSearchTool,
    createMemoryActiveSlateTool,
    createMemoryContextBundleTool,
    createMemoryDiscoveryProjectionTool,
    createMemoryGetTool,
    createMemoryNoveltyScanTool,
    createMemoryReasoningChainTool,
    createMemorySearchTool,
    createMemoryWriteTool,
    registerMemoryCli,
  };
}
