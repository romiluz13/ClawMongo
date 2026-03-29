import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "../memory/index.js";
import type { MemorySearchManager } from "../memory/types.js";
import {
  registerMemoryRuntime,
  type RegisteredMemorySearchManager,
} from "../plugins/memory-state.js";

/**
 * Thin adapter: our MemorySearchManager already implements every method
 * RegisteredMemorySearchManager requires (status, probeEmbedding/Vector,
 * sync, close). TypeScript structural typing makes the shapes compatible;
 * this wrapper only bridges the nominal type boundary.
 */
function wrapForPluginBridge(manager: MemorySearchManager): RegisteredMemorySearchManager {
  return manager as unknown as RegisteredMemorySearchManager;
}

/**
 * Register MongoDB as the plugin runtime so upstream callers of
 * getActiveMemorySearchManager() get our MongoDB manager.
 *
 * Called inside startGatewayMemoryBackend() (AFTER plugin loading)
 * so our registration is the last-write and always wins, even if
 * memory-core somehow loaded.
 */
function registerMongoDBPluginRuntime(): void {
  registerMemoryRuntime({
    async getMemorySearchManager(params) {
      const result = await getMemorySearchManager(params);
      if (!result.manager) {
        return { manager: null, error: result.error ?? "MongoDB manager not initialized" };
      }
      return { manager: wrapForPluginBridge(result.manager), error: undefined };
    },
    resolveMemoryBackendConfig(_params) {
      // INTENTIONAL: returns "builtin" to satisfy upstream's MemoryBackend
      // type union ("builtin" | "qmd"). The actual runtime backend is always
      // MongoDB — MongoDBMemoryManager.status() reports backend: "mongodb".
      // This adapter field is only read by upstream plugin metadata paths
      // (e.g. doctor diagnostics), never by our MongoDB retrieval pipeline.
      return { backend: "builtin" as const, qmd: undefined };
    },
    async closeAllMemorySearchManagers() {
      await closeAllMemorySearchManagers();
    },
  });
}

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  // Register MongoDB into the plugin bridge AFTER plugins have loaded,
  // so our registration is always the last-write (defense-in-depth).
  registerMongoDBPluginRuntime();

  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    try {
      resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.log.warn(
        `mongodb memory startup initialization failed for agent "${agentId}": ${message}`,
      );
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `mongodb memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    if (manager.sync) {
      try {
        await manager.sync({ reason: "startup" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        params.log.warn(`mongodb memory startup sync failed for agent "${agentId}": ${message}`);
      }
    }
    params.log.info?.(`mongodb memory startup initialization armed for agent "${agentId}"`);
  }
}
