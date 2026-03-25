import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

type MemoryToolRuntime = typeof import("./memory-tool.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("../../memory/index.js"))["getMemorySearchManager"]>
>;

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;

async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./memory-tool.runtime.js");
  return await memoryToolRuntimePromise;
}

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
      "Mandatory recall step: search MongoDB-backed runtime memory before answering questions about prior work, decisions, dates, people, preferences, or todos. Results may include bridge notes synced from memory/*.md plus active structured and KB-backed recall, and the runtime search order is cache -> searchV2 -> legacy fallback. Returns top snippets with reopenable locators and line ranges when available. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user. Example: use memory_search for runtime recall about prior work, then kb_search if you specifically need reference material.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
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
          const rawResults = await memory.manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
          });
          const status = memory.manager.status();
          const decorated = decorateCitations(rawResults, includeCitations);
          const resolved = resolveMemoryBackendConfig({ cfg, agentId });
          const results =
            (status as { backend: string }).backend === "qmd"
              ? clampResultsByInjectedChars(
                  decorated,
                  (
                    resolved as Record<string, unknown> & {
                      qmd?: { limits: { maxInjectedChars?: number } };
                    }
                  ).qmd?.limits.maxInjectedChars,
                )
              : decorated;
          const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          const feedbackHint = computeFeedbackHint(rawResults, status.backend);
          return jsonResult({
            results,
            provider: status.provider,
            model: status.model,
            fallback: (status as Record<string, unknown>).fallback,
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
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if ((resolved as { backend: string }).backend === "builtin") {
          try {
            const result = await readAgentMemoryFile({
              cfg,
              agentId,
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            });
            return jsonResult(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult(buildMemoryReadUnavailableResult(relPath, message));
          }
        }
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
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults") ?? 5;
        const category = readStringParam(params, "category");
        const source = readStringParam(params, "source");
        const tags =
          params && typeof params === "object" && "tags" in params
            ? ((params as Record<string, unknown>).tags as string[] | undefined)
            : undefined;

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
      async (_toolCallId, params) => {
        const type = readStringParam(params, "type", { required: true });
        const key = readStringParam(params, "key", { required: true });
        const value = readStringParam(params, "value", { required: true });
        const context = readStringParam(params, "context");
        const confidence = readNumberParam(params, "confidence");
        const tags =
          params && typeof params === "object" && "tags" in params
            ? ((params as Record<string, unknown>).tags as string[] | undefined)
            : undefined;
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

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
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
