import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode, MemoryScope } from "../../config/types.memory.js";
import type {
  MemoryDiscoveryProjectionKind,
  MemorySearchMode,
  MemorySearchRequest,
  MemorySearchResponse,
  MemorySearchResult,
  MemorySearchSourcePreference,
  MemorySearchTimeRangePreset,
} from "../../memory/types.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

type MemoryToolRuntime = typeof import("./memory-tool.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("../../memory/index.js"))["getMemorySearchManager"]>
>;

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;

async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./memory-tool.runtime.js");
  return await memoryToolRuntimePromise;
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  return typeof raw === "boolean" ? raw : undefined;
}

function readObjectParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function readStringArrayFromObject(
  params: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  if (!params) {
    return undefined;
  }
  const raw = readSnakeCaseParamRaw(params, key);
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function readValidatedEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  const value = readStringParam(params, key);
  if (!value) {
    return undefined;
  }
  if (!allowed.has(value as T)) {
    throw new ToolInputError(`invalid ${key}`);
  }
  return value as T;
}

function readValidatedEnumArray<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  const values = readStringArrayParam(params, key);
  if (!values) {
    return undefined;
  }
  for (const value of values) {
    if (!allowed.has(value as T)) {
      throw new ToolInputError(`invalid ${key}`);
    }
  }
  return values as T[];
}

function readTimeRangeParam(
  params: Record<string, unknown>,
  key: string,
): MemorySearchRequest["timeRange"] | undefined {
  const timeRangeRaw = readObjectParam(params, key);
  if (!timeRangeRaw) {
    return undefined;
  }
  const preset = readValidatedEnum<MemorySearchTimeRangePreset>(
    timeRangeRaw,
    "preset",
    new Set(MEMORY_SEARCH_TIME_RANGE_PRESET_VALUES),
  );
  const start = readStringParam(timeRangeRaw, "start");
  const end = readStringParam(timeRangeRaw, "end");
  if (!preset && !start && !end) {
    return undefined;
  }
  return {
    ...(preset ? { preset } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

function readMemoryScopeParam(
  params: Record<string, unknown>,
  key: string,
): MemoryScope | undefined {
  return readValidatedEnum<MemoryScope>(params, key, new Set(MEMORY_SCOPE_VALUES));
}

function readMemoryDiscoveryRequest(params: Record<string, unknown>) {
  const kind = readValidatedEnum<MemoryDiscoveryProjectionKind>(
    params,
    "kind",
    new Set(MEMORY_DISCOVERY_KIND_VALUES),
  );
  return {
    kind: kind ?? "topic-brief",
    query: readStringParam(params, "query"),
    scope: readMemoryScopeParam(params, "scope"),
    scopeRef: readStringParam(params, "scopeRef"),
    maxItems: readNumberParam(params, "maxItems", { integer: true }),
    timeRange: readTimeRangeParam(params, "timeRange"),
  };
}

function readMemoryContextBundleRequest(params: Record<string, unknown>) {
  const includeDiscoveryProjection =
    readBooleanParam(params, "includeDiscoveryProjection") ??
    readBooleanParam(params, "includeDiscovery");
  return {
    query: readStringParam(params, "query"),
    scope: readMemoryScopeParam(params, "scope"),
    scopeRef: readStringParam(params, "scopeRef"),
    sessionId: readStringParam(params, "sessionId"),
    tokenBudget: readNumberParam(params, "tokenBudget", { integer: true }),
    maxActiveItems: readNumberParam(params, "maxActiveItems", { integer: true }),
    maxRecentEvents: readNumberParam(params, "maxRecentEvents", { integer: true }),
    maxEvidenceItems: readNumberParam(params, "maxEvidenceItems", { integer: true }),
    ...(includeDiscoveryProjection !== undefined ? { includeDiscoveryProjection } : {}),
    includeProfile: readBooleanParam(params, "includeProfile"),
    discoveryKind: readValidatedEnum<MemoryDiscoveryProjectionKind>(
      params,
      "discoveryKind",
      new Set(MEMORY_DISCOVERY_KIND_VALUES),
    ),
    timeRange: readTimeRangeParam(params, "timeRange"),
  };
}

function readMemorySearchRequest(
  params: Record<string, unknown>,
  sessionKey?: string,
): MemorySearchRequest {
  const query = readStringParam(params, "query", { required: true });
  const maxResults = readNumberParam(params, "maxResults");
  const minScore = readNumberParam(params, "minScore");
  const searchMode = readValidatedEnum<MemorySearchMode>(
    params,
    "searchMode",
    new Set(MEMORY_SEARCH_MODE_VALUES),
  );
  const sourcePreference = readValidatedEnumArray<MemorySearchSourcePreference>(
    params,
    "sourcePreference",
    new Set(MEMORY_SEARCH_SOURCE_VALUES),
  );
  const timeRange = readTimeRangeParam(params, "timeRange");
  const conversationScopeRaw = readObjectParam(params, "conversationScope");
  const structuredScopeRaw = readObjectParam(params, "structuredScope");
  const referenceScopeRaw = readObjectParam(params, "referenceScope");
  const proceduralScopeRaw = readObjectParam(params, "proceduralScope");
  const explicitSessionKey = conversationScopeRaw
    ? readStringParam(conversationScopeRaw, "sessionKey")
    : undefined;
  const needExactEvidence = readBooleanParam(params, "needExactEvidence");
  const returnPlan = readBooleanParam(params, "returnPlan");
  const maxPasses = readNumberParam(params, "maxPasses", { integer: true });

  return {
    query,
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
    ...(searchMode ? { searchMode } : {}),
    ...(sourcePreference ? { sourcePreference } : {}),
    ...(timeRange ? { timeRange } : {}),
    ...(needExactEvidence !== undefined ? { needExactEvidence } : {}),
    ...(maxPasses !== undefined ? { maxPasses } : {}),
    ...(returnPlan !== undefined ? { returnPlan } : {}),
    ...(explicitSessionKey || sessionKey
      ? { conversationScope: { sessionKey: explicitSessionKey ?? sessionKey } }
      : {}),
    ...(structuredScopeRaw
      ? {
          structuredScope: {
            ...(readStringParam(structuredScopeRaw, "type")
              ? { type: readStringParam(structuredScopeRaw, "type") }
              : {}),
            ...(readStringArrayFromObject(structuredScopeRaw, "state")
              ? { state: readStringArrayFromObject(structuredScopeRaw, "state") }
              : {}),
            ...(readStringArrayFromObject(structuredScopeRaw, "salience")
              ? { salience: readStringArrayFromObject(structuredScopeRaw, "salience") }
              : {}),
          },
        }
      : {}),
    ...(referenceScopeRaw
      ? {
          referenceScope: {
            ...(readStringParam(referenceScopeRaw, "source")
              ? { source: readStringParam(referenceScopeRaw, "source") }
              : {}),
            ...(readStringParam(referenceScopeRaw, "category")
              ? { category: readStringParam(referenceScopeRaw, "category") }
              : {}),
            ...(readStringArrayFromObject(referenceScopeRaw, "tags")
              ? { tags: readStringArrayFromObject(referenceScopeRaw, "tags") }
              : {}),
          },
        }
      : {}),
    ...(proceduralScopeRaw
      ? {
          proceduralScope: {
            ...(readStringParam(proceduralScopeRaw, "state")
              ? { state: readStringParam(proceduralScopeRaw, "state") }
              : {}),
            ...(readStringArrayFromObject(proceduralScopeRaw, "intentTags")
              ? { intentTags: readStringArrayFromObject(proceduralScopeRaw, "intentTags") }
              : {}),
          },
        }
      : {}),
  };
}

function buildFallbackDetailedResponse(
  request: MemorySearchRequest,
  results: MemorySearchResult[],
): MemorySearchResponse {
  return {
    results,
    metadata: {
      mode: request.searchMode ?? "auto",
      classification: "direct",
      sourceOrder: request.sourcePreference ?? ["conversation", "reference", "structured"],
      passes: [
        {
          pass: 1,
          query: request.query,
          reason: "compatibility fallback",
          pathsExecuted: [],
          resultCount: results.length,
          queryRewritten: false,
          reranked: false,
        },
      ],
      queriesTried: [request.query],
      constraintsApplied: [],
      resultsRejected: [],
      evidenceCoverage: results.length > 0 ? "direct" : "none",
      pathsExecuted: [],
      resultsByPath: {},
      queryRewritten: false,
      reranked: false,
      contradictionSummary: {
        status: "clear",
        conflictedResults: 0,
        invalidatedResults: 0,
        lowTrustResults: 0,
        exactResolutionAvailable: false,
        topResultConflicted: false,
      },
      abstained: results.length === 0,
      ...(results.length === 0
        ? { abstainReason: "No memory evidence satisfied the request." }
        : {}),
    },
  };
}

const MEMORY_SEARCH_MODE_VALUES = ["auto", "direct", "agentic"] as const;
const MEMORY_SCOPE_VALUES = ["session", "user", "agent", "workspace", "tenant", "global"] as const;
const MEMORY_SEARCH_SOURCE_VALUES = [
  "conversation",
  "reference",
  "structured",
  "procedural",
  "episodic",
  "graph",
] as const;
const MEMORY_DISCOVERY_KIND_VALUES = [
  "entity-brief",
  "topic-brief",
  "what-changed",
  "contradiction-report",
] as const;
const MEMORY_SEARCH_TIME_RANGE_PRESET_VALUES = [
  "today",
  "yesterday",
  "last-24h",
  "last-7d",
  "this-week",
  "last-30d",
  "this-month",
] as const;

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  searchMode: optionalStringEnum(MEMORY_SEARCH_MODE_VALUES),
  sourcePreference: Type.Optional(Type.Array(stringEnum(MEMORY_SEARCH_SOURCE_VALUES))),
  timeRange: Type.Optional(
    Type.Object({
      preset: optionalStringEnum(MEMORY_SEARCH_TIME_RANGE_PRESET_VALUES),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
    }),
  ),
  needExactEvidence: Type.Optional(Type.Boolean()),
  maxPasses: Type.Optional(Type.Number()),
  returnPlan: Type.Optional(Type.Boolean()),
  conversationScope: Type.Optional(
    Type.Object({
      sessionKey: Type.Optional(Type.String()),
    }),
  ),
  structuredScope: Type.Optional(
    Type.Object({
      type: Type.Optional(Type.String()),
      state: Type.Optional(Type.Array(Type.String())),
      salience: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  referenceScope: Type.Optional(
    Type.Object({
      source: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  proceduralScope: Type.Optional(
    Type.Object({
      state: Type.Optional(Type.String()),
      intentTags: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const MemoryActiveSlateSchema = Type.Object({
  scope: Type.Optional(stringEnum(MEMORY_SCOPE_VALUES)),
  scopeRef: Type.Optional(Type.String()),
  maxItems: Type.Optional(Type.Number()),
});

const MemoryDiscoveryProjectionSchema = Type.Object({
  kind: Type.Optional(stringEnum(MEMORY_DISCOVERY_KIND_VALUES)),
  query: Type.Optional(Type.String()),
  scope: Type.Optional(stringEnum(MEMORY_SCOPE_VALUES)),
  scopeRef: Type.Optional(Type.String()),
  maxItems: Type.Optional(Type.Number()),
  timeRange: Type.Optional(
    Type.Object({
      preset: optionalStringEnum(MEMORY_SEARCH_TIME_RANGE_PRESET_VALUES),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
    }),
  ),
});

const MemoryContextBundleSchema = Type.Object({
  query: Type.Optional(Type.String()),
  scope: Type.Optional(stringEnum(MEMORY_SCOPE_VALUES)),
  scopeRef: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  tokenBudget: Type.Optional(Type.Number()),
  maxActiveItems: Type.Optional(Type.Number()),
  maxRecentEvents: Type.Optional(Type.Number()),
  maxEvidenceItems: Type.Optional(Type.Number()),
  includeDiscoveryProjection: Type.Optional(Type.Boolean()),
  includeDiscovery: Type.Optional(Type.Boolean()),
  includeProfile: Type.Optional(Type.Boolean()),
  discoveryKind: Type.Optional(stringEnum(MEMORY_DISCOVERY_KIND_VALUES)),
  timeRange: Type.Optional(
    Type.Object({
      preset: optionalStringEnum(MEMORY_SEARCH_TIME_RANGE_PRESET_VALUES),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
    }),
  ),
});

const KBSearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
  category: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
});

const MemoryWriteSchema = Type.Object({
  type: Type.Union([
    Type.Literal("decision"),
    Type.Literal("preference"),
    Type.Literal("person"),
    Type.Literal("todo"),
    Type.Literal("fact"),
    Type.Literal("project"),
    Type.Literal("architecture"),
    Type.Literal("custom"),
  ]),
  key: Type.String(),
  value: Type.String(),
  context: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
});

const MemoryReasoningChainSchema = Type.Object({
  fact_id: Type.String({
    description: "The ID of the fact to trace (e.g., structured memory key, entity ID)",
  }),
  collection: Type.String({
    description: "Source collection: structured_mem, entities, relations, procedures, entity_links",
  }),
  max_depth: Type.Optional(Type.Number({ description: "Maximum traversal depth (default 10)" })),
});

const MemoryNoveltyScanSchema = Type.Object({
  limit: Type.Optional(
    Type.Number({ description: "Number of most novel events to return (default 10)" }),
  ),
  scope: Type.Optional(Type.String({ description: "Memory scope filter" })),
});

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

async function getMemoryManagerContext(params: { cfg: OpenClawConfig; agentId: string }): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  return await getMemoryManagerContextWithPurpose({ ...params, purpose: undefined });
}

async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
  return manager ? { manager } : { error };
}

function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: AnyAgentTool["parameters"];
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: search MongoDB-backed runtime memory before answering questions about prior work, decisions, dates, people, preferences, or todos. Results come from MongoDB event, structured, graph, episodic, procedural, and KB recall paths. Supports direct or bounded agentic recall controls, returns planner-visible metadata, and preserves reopenable MongoDB locators when available. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user. Example: use memory_search for runtime recall about prior work, then kb_search if you specifically need reference material.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const request = readMemorySearchRequest(params, options.agentSessionKey);
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const detailed = memory.manager.searchDetailed
            ? await memory.manager.searchDetailed(request)
            : buildFallbackDetailedResponse(
                request,
                await memory.manager.search(request.query, {
                  maxResults: request.maxResults,
                  minScore: request.minScore,
                  sessionKey: request.conversationScope?.sessionKey ?? options.agentSessionKey,
                }),
              );
          const rawResults = detailed.results;
          const status = memory.manager.status();
          const decorated = decorateCitations(rawResults, includeCitations);
          resolveMemoryBackendConfig({ cfg, agentId });
          const results = decorated;
          const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          const feedbackHint = computeFeedbackHint(rawResults, status.backend);
          return jsonResult({
            results,
            metadata: detailed.metadata,
            provider: status.provider,
            model: status.model,
            fallback: (status as Record<string, unknown>).fallback,
            citations: citationsMode,
            mode: detailed.metadata.mode ?? searchMode,
            ...(feedbackHint ? { feedbackHint } : {}),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe MongoDB memory locator read with optional from/lines; use after memory_search to pull only the needed canonical event, structured memory, procedure, or KB excerpt and keep context small.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        resolveMemoryBackendConfig({ cfg, agentId });
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult(buildMemoryReadUnavailableResult(relPath, memory.error));
        }
        try {
          const result = await memory.manager.readFile({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
          });
          return jsonResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult(buildMemoryReadUnavailableResult(relPath, message));
        }
      },
  });
}

export function createMemoryActiveSlateTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Active Slate",
    name: "memory_active_slate",
    description:
      "Return the highest-signal active runtime memory for the current situation, blockers, constraints, and ongoing work. Use this before answering questions about what matters now.",
    parameters: MemoryActiveSlateSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const request = {
          scope: readMemoryScopeParam(params, "scope"),
          scopeRef: readStringParam(params, "scopeRef"),
          maxItems: readNumberParam(params, "maxItems", { integer: true }),
        };
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ items: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.hydrateActiveSlate) {
          return jsonResult({
            items: [],
            disabled: true,
            error: "active slate is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(await memory.manager.hydrateActiveSlate(request));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ items: [], disabled: true, error: message });
        }
      },
  });
}

export function createMemoryDiscoveryProjectionTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Discovery Projection",
    name: "memory_discovery_projection",
    description:
      "Project changes, contradictions, entity briefs, or topic briefs from MongoDB runtime memory. Use this when the user asks what changed, what conflicts, or for a compact brief on a topic or entity.",
    parameters: MemoryDiscoveryProjectionSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const request = readMemoryDiscoveryRequest(params);
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ sections: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.buildDiscoveryProjection) {
          return jsonResult({
            sections: [],
            disabled: true,
            error: "discovery projection is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(await memory.manager.buildDiscoveryProjection(request));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ sections: [], disabled: true, error: message });
        }
      },
  });
}

export function createMemoryContextBundleTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Context Bundle",
    name: "memory_context_bundle",
    description:
      "Assemble a prompt-ready, token-bounded context bundle from active slate, evidence, summaries, and recent events. Use this for handoffs, compact briefs, or context packing before answering.",
    parameters: MemoryContextBundleSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const request = readMemoryContextBundleRequest(params);
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ sections: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.buildContextBundle) {
          return jsonResult({
            sections: [],
            disabled: true,
            error: "context bundle is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(await memory.manager.buildContextBundle(request));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ sections: [], disabled: true, error: message });
        }
      },
  });
}

export function createKBSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "KB Search",
    name: "kb_search",
    description:
      'Search the knowledge base for imported documents, FAQs, architecture specs, and reference materials. Returns matching snippets with source and relevance score. Optional filters: tags, category, source. Use for documentation/reference lookups when the target is explicit reference material rather than general runtime recall. Example: kb_search({query: "API rate limiting policy", tags: ["docs"]})',
    parameters: KBSearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults") ?? 5;
        const category = readStringParam(params, "category");
        const source = readStringParam(params, "source");
        const tags = "tags" in params ? (params.tags as string[] | undefined) : undefined;

        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ results: [], disabled: true, error: memory.error });
        }

        try {
          const manager = memory.manager as typeof memory.manager & {
            searchKB?: (
              query: string,
              opts?: {
                maxResults?: number;
                minScore?: number;
                filter?: { tags?: string[]; category?: string; source?: string };
              },
            ) => Promise<MemorySearchResult[]>;
          };
          if (manager.searchKB) {
            const results = await manager.searchKB(query, {
              maxResults,
              filter: {
                ...(Array.isArray(tags) ? { tags } : {}),
                ...(category ? { category } : {}),
                ...(source ? { source } : {}),
              },
            });
            return jsonResult({ results });
          }
          const results = await memory.manager.search(query, { maxResults });
          return jsonResult({
            results: results.filter((entry) => entry.source === "reference"),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ results: [], disabled: true, error: message });
        }
      },
  });
}

export function createMemoryWriteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Write",
    name: "memory_write",
    description:
      'Store a structured observation in persistent memory. Types: decision, preference, fact, person, todo, project, architecture, or custom. Type+key is the dedup key inside the active memory namespace. Use for important runtime knowledge and structured observations; do not write runtime memory to workspace files. Example: memory_write({type: "decision", key: "auth-method", value: "OAuth2 with PKCE"})',
    parameters: MemoryWriteSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const type = readStringParam(params, "type", { required: true });
        const key = readStringParam(params, "key", { required: true });
        const value = readStringParam(params, "value", { required: true });
        const context = readStringParam(params, "context");
        const confidence = readNumberParam(params, "confidence");
        const tags = "tags" in params ? (params.tags as string[] | undefined) : undefined;
        const { hasWriteCapability } = await loadMemoryToolRuntime();
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({
            success: false,
            error: memory.error ?? "memory manager unavailable",
          });
        }
        if (!hasWriteCapability(memory.manager)) {
          return jsonResult({ success: false, error: "write not supported on this backend" });
        }
        try {
          const result = await memory.manager.writeStructuredMemory({
            type: type as import("../../memory/mongodb-structured-memory.js").StructuredMemoryType,
            key,
            value,
            context: context ?? undefined,
            confidence: confidence ?? 0.8,
            source: "agent",
            agentId,
            tags: tags ?? undefined,
          });
          return jsonResult({ success: true, upserted: result.upserted, id: result.id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ success: false, error: message });
        }
      },
  });
}

export function createMemoryReasoningChainTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Reasoning Chain",
    name: "memory_reasoning_chain",
    description:
      "Trace the provenance of any stored fact back to the original conversation events that produced it. Returns an ordered chain from root cause to derived fact. Use when you need to understand WHY a memory exists or verify its source.",
    parameters: MemoryReasoningChainSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const factId = readStringParam(params, "factId", { required: true });
        const collection = readStringParam(params, "collection", { required: true });
        const maxDepth = readNumberParam(params, "maxDepth", { integer: true });
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ nodes: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.traceReasoningChain) {
          return jsonResult({
            nodes: [],
            disabled: true,
            error: "reasoning chain is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(
            await memory.manager.traceReasoningChain({
              factId,
              collection,
              options: maxDepth !== undefined ? { maxDepth } : undefined,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ nodes: [], disabled: true, error: message });
        }
      },
  });
}

export function createMemoryNoveltyScanTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Novelty Scan",
    name: "memory_novelty_scan",
    description:
      "Find the most novel and surprising observations stored in memory. Returns events ranked by how unusual they are compared to everything else stored. Use when looking for anomalies, new patterns, or unexpected information.",
    parameters: MemoryNoveltyScanSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params: Record<string, unknown>) => {
        const limit = readNumberParam(params, "limit", { integer: true });
        const scope = readMemoryScopeParam(params, "scope");
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult({ events: [], disabled: true, error: memory.error });
        }
        if (!memory.manager.scanNovelty) {
          return jsonResult({
            events: [],
            disabled: true,
            error: "novelty scan is not supported on this memory backend",
          });
        }
        try {
          return jsonResult(
            await memory.manager.scanNovelty({
              ...(limit !== undefined ? { limit } : {}),
              ...(scope ? { scope } : {}),
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ events: [], disabled: true, error: message });
        }
      },
  });
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function buildMemoryReadUnavailableResult(path: string, error: string | undefined) {
  return {
    path,
    locator: path,
    text: "",
    error,
    disabled: true,
  };
}

const FEEDBACK_MIN_RESULTS = 2;
const FEEDBACK_MAX_SCORE = 0.3;

export function computeFeedbackHint(
  results: MemorySearchResult[],
  backend: string | undefined,
): string | undefined {
  if (backend !== "mongodb") {
    return undefined;
  }
  if (results.length >= FEEDBACK_MIN_RESULTS) {
    return undefined;
  }
  const allLowScore = results.every((result) => (result.score ?? 0) < FEEDBACK_MAX_SCORE);
  if (!allLowScore) {
    return undefined;
  }
  return "Low confidence results. Consider rephrasing your query or checking kb_search for reference documents.";
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
