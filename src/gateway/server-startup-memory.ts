import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (resolved.backend !== "qmd" && resolved.backend !== "mongodb") {
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `${resolved.backend} memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    if (resolved.backend === "mongodb" && manager.sync) {
      try {
        await manager.sync({ reason: "startup" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        params.log.warn(`mongodb memory startup sync failed for agent "${agentId}": ${message}`);
      }
    }
    params.log.info?.(
      `${resolved.backend} memory startup initialization armed for agent "${agentId}"`,
    );
  }
}
