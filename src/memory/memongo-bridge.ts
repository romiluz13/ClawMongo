import type { OpenClawConfig } from "../config/config.js";
import type { MemoryScope } from "../config/types.memory.js";
import { getMemorySearchManager } from "./search-manager.js";
import type {
  MemoryContextBundleRequest,
  MemoryDiscoveryProjectionKind,
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchRequest,
  MemorySearchResponse,
} from "./types.js";

type BridgeParams = {
  cfg: OpenClawConfig;
  agentId?: string;
};

type BridgeSearchParams = BridgeParams &
  Omit<MemorySearchRequest, "query"> & {
    query: string;
  };

type BridgeStructuredWriteParams = BridgeParams & {
  type: string;
  key: string;
  value: string;
  context?: string;
  tags?: string[];
  scope?: MemoryScope;
  scopeRef?: string;
  confidence?: number;
  salience?: "critical" | "high" | "normal" | "low";
  source?: { kind: string; id?: string; title?: string };
};

type BridgeContextBundleParams = BridgeParams & MemoryContextBundleRequest;

type BridgeDiscoveryProjectionParams = BridgeParams & {
  kind?: MemoryDiscoveryProjectionKind;
  query?: string;
  scope?: MemoryScope;
  scopeRef?: string;
  maxItems?: number;
};

const DEFAULT_AGENT_ID = "main";

function resolveAgentId(agentId: string | undefined): string {
  const normalized = agentId?.trim();
  return normalized || DEFAULT_AGENT_ID;
}

async function getRequiredManager(params: BridgeParams) {
  const agentId = resolveAgentId(params.agentId);
  const result = await getMemorySearchManager({
    cfg: params.cfg,
    agentId,
  });
  if (!result.manager) {
    throw new Error(result.error ?? "MongoDB memory manager unavailable");
  }
  return { agentId, manager: result.manager };
}

export async function memongoBridgeStatus(params: BridgeParams): Promise<MemoryProviderStatus> {
  const { manager } = await getRequiredManager(params);
  return manager.status();
}

export async function memongoBridgeSearch(
  params: BridgeSearchParams,
): Promise<MemorySearchResponse> {
  const { manager } = await getRequiredManager(params);
  if (manager.searchDetailed) {
    return await manager.searchDetailed(params);
  }
  const results = await manager.search(params.query, {
    maxResults: params.maxResults,
    minScore: params.minScore,
    sessionKey: params.conversationScope?.sessionKey,
  });
  return {
    results,
    metadata: {
      mode: params.searchMode ?? "auto",
      classification: "direct",
      sourceOrder: params.sourcePreference ?? ["conversation", "structured", "reference"],
      passes: [],
      queriesTried: [params.query],
      constraintsApplied: [],
      resultsRejected: [],
      evidenceCoverage: results.length > 0 ? "direct" : "none",
      pathsExecuted: [],
      resultsByPath: {},
      queryRewritten: false,
      reranked: false,
    },
  };
}

export async function memongoBridgeWriteStructuredMemory(
  params: BridgeStructuredWriteParams,
): Promise<unknown> {
  const { agentId, manager } = await getRequiredManager(params);
  if (!manager.writeStructuredMemory) {
    throw new Error("MongoDB memory manager does not support structured writes");
  }
  return await manager.writeStructuredMemory({
    type: params.type as never,
    key: params.key,
    value: params.value,
    agentId,
    context: params.context,
    tags: params.tags,
    scope: params.scope,
    scopeRef: params.scopeRef,
    confidence: params.confidence,
    salience: params.salience,
    source: "agent",
  });
}

export async function memongoBridgeBuildContextBundle(params: BridgeContextBundleParams) {
  const { manager } = await getRequiredManager(params);
  if (!manager.buildContextBundle) {
    throw new Error("MongoDB memory manager does not support context bundles");
  }
  return await manager.buildContextBundle(params);
}

export async function memongoBridgeBuildDiscoveryProjection(
  params: BridgeDiscoveryProjectionParams,
) {
  const { manager } = await getRequiredManager(params);
  if (!manager.buildDiscoveryProjection) {
    throw new Error("MongoDB memory manager does not support discovery projections");
  }
  return await manager.buildDiscoveryProjection({
    kind: params.kind ?? "topic-brief",
    query: params.query,
    scope: params.scope,
    scopeRef: params.scopeRef,
    maxItems: params.maxItems,
  });
}

export async function memongoBridgeScanNovelty(params: BridgeParams & { limit?: number }) {
  const { manager } = await getRequiredManager(params);
  if (!manager.scanNovelty) {
    throw new Error("MongoDB memory manager does not support novelty scans");
  }
  return await manager.scanNovelty({ limit: params.limit });
}

export async function memongoBridgeProbeEmbedding(
  params: BridgeParams,
): Promise<MemoryEmbeddingProbeResult> {
  const { manager } = await getRequiredManager(params);
  if (!manager.probeEmbeddingAvailability) {
    throw new Error("MongoDB memory manager does not support embedding probes");
  }
  return await manager.probeEmbeddingAvailability();
}
