import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedMongoDBConfig } from "./backend-config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import type { MemorySearchManager } from "./types.js";

const log = createSubsystemLogger("memory");
const MONGODB_MANAGER_CACHE = new Map<string, MemorySearchManager>();

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  let resolved;
  try {
    resolved = resolveMemoryBackendConfig(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`memory backend resolution failed: ${message}`);
    return { manager: null, error: message };
  }

  if (!resolved.mongodb) {
    return { manager: null, error: "mongodb memory config missing" };
  }

  const cacheKey = buildMongoDBCacheKey(params.agentId, resolved.mongodb);
  const cached = MONGODB_MANAGER_CACHE.get(cacheKey);
  if (cached) {
    return { manager: cached };
  }

  try {
    const { MongoDBMemoryManager } = await import("./mongodb-manager.js");
    const manager = await MongoDBMemoryManager.create({
      cfg: params.cfg,
      agentId: params.agentId,
      resolved,
    });
    if (!manager) {
      const error = "mongodb memory manager initialization returned null";
      log.warn(error);
      return { manager: null, error };
    }
    MONGODB_MANAGER_CACHE.set(cacheKey, manager);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = `mongodb memory unavailable: ${message}`;
    log.warn(error);
    return { manager: null, error };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const managers = Array.from(MONGODB_MANAGER_CACHE.values());
  MONGODB_MANAGER_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close mongodb memory manager: ${String(err)}`);
    }
  }
}

function buildMongoDBCacheKey(agentId: string, config: ResolvedMongoDBConfig): string {
  return `${agentId}:${stableSerialize(config)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}
