import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { hasWriteCapability } from "../../memory/mongodb-manager.js";
import type { MemoryReadResult, MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
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
      manager: NonNullable<Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
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
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
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

function resolveMongoMemoryToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): { cfg: OpenClawConfig; agentId: string; error?: string } | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  try {
    resolveMemoryBackendConfig(ctx);
    return ctx;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...ctx, error: message };
  }
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
      'Mandatory runtime recall step: search MongoDB-backed memory for prior work, decisions, dates, people, preferences, todos, and recent history. Results may include other active recall sources, but reference-document lookups should prefer kb_search. Returns top snippets with source, path, and relevance score. Example: memory_search({query: "what auth approach did we decide on?"}) If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.',
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
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
          const rawResults = await memory.manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
          });
          const status = memory.manager.status();
          const decorated = decorateCitations(rawResults, includeCitations);
          const results = decorated;
          const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          const feedbackHint = computeFeedbackHint(rawResults, status.backend);
          return jsonResult({
            results,
            provider: status.provider,
            model: status.model,
            citations: citationsMode,
            mode: searchMode,
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
      "Read an exact Mongo-backed locator returned by memory_search or kb_search. Supports conversation/event-backed recall items, episode summary locators, reference documents, and structured memory records.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const memory = await getMemoryManagerContext({ cfg, agentId });
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

function buildMemoryReadUnavailableResult(
  path: string,
  error: string | undefined,
): MemoryReadResult {
  return {
    path,
    locator: path,
    text: "",
    error,
    disabled: true,
  };
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

// ---------------------------------------------------------------------------
// Feedback loop: low-confidence hint for memory_search results
// ---------------------------------------------------------------------------

const FEEDBACK_MIN_RESULTS = 2;
const FEEDBACK_MAX_SCORE = 0.3;

/**
 * Compute a feedback hint when memory_search returns low-confidence results.
 * Triggers when: results.length < 2 AND all scores < 0.3 (MongoDB backend only).
 * Returns undefined when results are confident enough or backend is not MongoDB.
 */
export function computeFeedbackHint(
  results: MemorySearchResult[],
  backend: string | undefined,
): string | undefined {
  if (backend !== "mongodb") {
    return undefined;
  }
  // Low confidence: fewer than 2 results AND all scores below threshold
  if (results.length >= FEEDBACK_MIN_RESULTS) {
    return undefined;
  }
  const allLowScore = results.every((r) => (r.score ?? 0) < FEEDBACK_MAX_SCORE);
  if (!allLowScore) {
    return undefined;
  }
  return "Low confidence results. Consider rephrasing your query or checking kb_search for reference documents.";
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

// ---------------------------------------------------------------------------
// KB Search Tool (MongoDB-only, registered when MongoDB backend is active)
// ---------------------------------------------------------------------------

const KBSearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
  category: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
});

export function createKBSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMongoMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId, error: configError } = ctx;

  return {
    label: "KB Search",
    name: "kb_search",
    description:
      'Search the knowledge base for imported documents, FAQs, architecture specs, and other reference materials. Returns matching snippets with source and relevance score. Optional filters: tags, category, source. Use for documentation/reference lookups when the target is explicit reference material rather than general runtime recall. Example: kb_search({query: "API rate limiting policy", tags: ["docs"]})',
    parameters: KBSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 5;
      const category = readStringParam(params, "category");
      const source = readStringParam(params, "source");
      const tags =
        params && typeof params === "object" && "tags" in params
          ? ((params as Record<string, unknown>).tags as string[] | undefined)
          : undefined;

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error: configError ?? error });
      }

      try {
        // Prefer direct searchKB() when available (MongoDB backend optimization)
        // Falls back to search() + filter for other backends
        let kbResults;
        if (manager.searchKB) {
          kbResults = await manager.searchKB(query, {
            maxResults,
            filter: {
              ...(Array.isArray(tags) ? { tags } : {}),
              ...(category ? { category } : {}),
              ...(source ? { source } : {}),
            },
          });
        } else {
          const results = await manager.search(query, { maxResults });
          kbResults = results.filter((r) => {
            const sourceTag = (r as { source?: string }).source;
            return sourceTag === "reference" || sourceTag === "kb";
          });
        }
        return jsonResult({ results: kbResults });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], disabled: true, error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memory Write Tool (MongoDB-only, registered when MongoDB backend is active)
// ---------------------------------------------------------------------------

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

export function createMemoryWriteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMongoMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId, error: configError } = ctx;

  return {
    label: "Memory Write",
    name: "memory_write",
    description:
      'Store a structured observation in persistent memory. Types: decision (choices made), preference (user likes/dislikes), fact (objective info), person (people info), todo (action items), project (project-level context), architecture (technical decisions), custom (anything else). Type+key is the dedup key inside the active memory namespace. Set confidence 0.0-1.0 to express certainty. Use for important runtime knowledge; treat MEMORY.md as a human-authored bridge note, not the runtime memory store. Example: memory_write({type: "decision", key: "auth-method", value: "OAuth2 with PKCE"})',
    parameters: MemoryWriteSchema,
    execute: async (_toolCallId, params) => {
      const type = readStringParam(params, "type", { required: true });
      const key = readStringParam(params, "key", { required: true });
      const value = readStringParam(params, "value", { required: true });
      const context = readStringParam(params, "context");
      const confidence = readNumberParam(params, "confidence");
      const tags =
        params && typeof params === "object" && "tags" in params
          ? ((params as Record<string, unknown>).tags as string[] | undefined)
          : undefined;

      try {
        // Reuse the manager's existing connection pool (not per-call MongoClient)
        const { manager, error } = await getMemorySearchManager({ cfg, agentId });
        if (!manager) {
          return jsonResult({
            success: false,
            error: configError ?? error ?? "memory manager unavailable",
          });
        }
        if (!hasWriteCapability(manager)) {
          return jsonResult({ success: false, error: "write not supported on this backend" });
        }

        const result = await manager.writeStructuredMemory({
          type: type as import("../../memory/mongodb-structured-memory.js").StructuredMemoryType,
          key,
          value,
          context: context ?? undefined,
          confidence: confidence ?? 0.8,
          source: "agent",
          agentId,
          tags: tags ?? undefined,
        });

        return jsonResult({
          success: true,
          upserted: result.upserted,
          id: result.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}
