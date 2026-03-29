import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
  v2?: {
    overall?: string;
    retrieval?: string;
    canonicalIngest?: string;
    diagnostics?: string[];
    retrievalPaths?: string[];
  };
};

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getActiveMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      const detailedStatus =
        "getDetailedStatus" in manager && typeof manager.getDetailedStatus === "function"
          ? await manager.getDetailedStatus().catch(() => undefined)
          : undefined;
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
        ...(detailedStatus &&
        typeof detailedStatus === "object" &&
        "health" in detailedStatus &&
        "retrievalPaths" in detailedStatus
          ? {
              v2: {
                overall:
                  typeof (detailedStatus as { health?: { overall?: unknown } }).health?.overall ===
                  "string"
                    ? (detailedStatus as { health: { overall: string } }).health.overall
                    : undefined,
                retrieval:
                  typeof (detailedStatus as { health?: { retrieval?: unknown } }).health
                    ?.retrieval === "string"
                    ? (detailedStatus as { health: { retrieval: string } }).health.retrieval
                    : undefined,
                canonicalIngest:
                  typeof (detailedStatus as { health?: { canonicalIngest?: unknown } }).health
                    ?.canonicalIngest === "string"
                    ? (detailedStatus as { health: { canonicalIngest: string } }).health
                        .canonicalIngest
                    : undefined,
                diagnostics: Array.isArray(
                  (detailedStatus as { health?: { diagnostics?: unknown } }).health?.diagnostics,
                )
                  ? (detailedStatus as { health: { diagnostics: string[] } }).health.diagnostics
                  : undefined,
                retrievalPaths: Array.isArray(
                  (detailedStatus as { retrievalPaths?: unknown }).retrievalPaths,
                )
                  ? (detailedStatus as { retrievalPaths: string[] }).retrievalPaths
                  : undefined,
              },
            }
          : {}),
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
};
