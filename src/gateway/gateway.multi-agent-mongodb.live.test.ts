import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  unregisterApiProviders,
} from "@mariozechner/pi-ai";
import { MongoClient, type Db, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { ensureRuntimePluginsLoaded } from "../agents/runtime-plugins.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { closeAllMemorySearchManagers } from "../memory/index.js";
import {
  chunksCollection,
  eventsCollection,
  structuredMemCollection,
} from "../memory/mongodb-schema.js";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { stripInlineDirectiveTagsForDelivery } from "../utils/directive-tags.js";
import { GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import type { EventFrame } from "./protocol/index.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";
import { startGatewayServer } from "./server.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";

const TEST_URI = process.env.MONGODB_TEST_URI ?? "mongodb://localhost:27017/?directConnection=true";
const LIVE_OPENAI_COMPAT_BASE_URL =
  process.env.OPENCLAW_LIVE_OPENAI_COMPAT_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "";
const LIVE_OPENAI_COMPAT_API_KEY =
  process.env.OPENCLAW_LIVE_OPENAI_COMPAT_API_KEY ??
  process.env.OPENAI_API_KEY ??
  process.env.API_KEY ??
  "";
const LIVE_OPENAI_COMPAT_HEADER_NAME =
  process.env.OPENCLAW_LIVE_OPENAI_COMPAT_HEADER_NAME ?? "authorization";
const LIVE_OPENAI_COMPAT_AUTH_SCHEME =
  process.env.OPENCLAW_LIVE_OPENAI_COMPAT_AUTH_SCHEME ?? "Bearer";
const LIVE_OPENAI_COMPAT_MODEL = process.env.OPENCLAW_LIVE_OPENAI_COMPAT_MODEL ?? "gpt-5.4";
const LIVE_PROVIDER_ID = "openai_compat";
const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_MULTI_AGENT_MONGODB", "OPENCLAW_LIVE_OPENAI_COMPAT"]) &&
  Boolean(TEST_URI && LIVE_OPENAI_COMPAT_BASE_URL && LIVE_OPENAI_COMPAT_API_KEY);
const describeLive = LIVE ? describe : describe.skip;
const LIVE_OPENAI_COMPAT_OVERRIDE_SOURCE = "openclaw-openai-compat-live-test";
const LIVE_OPENAI_COMPAT_DEBUG_LOG = "/tmp/openclaw-openai-compat-live-debug.log";

type OpenAIChatMessage =
  | { role: "system" | "developer" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

type ChatCompletionResponse = {
  id?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string } | string> | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: {
    message?: string;
    code?: string | number;
  };
};

function resolveCompatAuthHeaderValue(apiKey: string): string {
  const scheme = LIVE_OPENAI_COMPAT_AUTH_SCHEME.trim();
  return scheme ? `${scheme} ${apiKey}` : apiKey;
}

async function appendLiveProviderDebug(message: string): Promise<void> {
  await fs
    .appendFile(LIVE_OPENAI_COMPAT_DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
    .catch(() => {});
}

function createAssistantOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function mapFinishReason(reason: string | null | undefined): {
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
} {
  if (reason === null || reason === undefined || reason === "stop" || reason === "end") {
    return { stopReason: "stop" };
  }
  if (reason === "length") {
    return { stopReason: "length" };
  }
  if (reason === "tool_calls" || reason === "function_call") {
    return { stopReason: "toolUse" };
  }
  if (reason === "content_filter") {
    return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
  }
  if (reason === "network_error") {
    return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
  }
  return {
    stopReason: "error",
    errorMessage: `Provider finish_reason: ${reason}`,
  };
}

function parseUsage(response: ChatCompletionResponse): AssistantMessage["usage"] {
  const rawUsage = response.usage;
  const cachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = rawUsage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const input = Math.max(0, (rawUsage?.prompt_tokens ?? 0) - cachedTokens);
  const output = Math.max(0, (rawUsage?.completion_tokens ?? 0) + reasoningTokens);
  return {
    input,
    output,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: rawUsage?.total_tokens ?? input + output + cachedTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function messageTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if ((block as { type?: unknown }).type !== "text") {
        return "";
      }
      return typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "";
    })
    .join("");
}

function isTextContentBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function convertMessagesToChat(model: Model<Api>, context: Context): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({
      role: model.reasoning ? "developer" : "system",
      content: context.systemPrompt.trim(),
    });
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content.trim()
          : messageTextContent(msg.content).trim();
      if (!content) {
        continue;
      }
      messages.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const textContent = msg.content
        .filter(isTextContentBlock)
        .filter((block) => block.text.trim().length > 0)
        .map((block) => block.text)
        .join("");
      const toolCalls = msg.content
        .filter((block): block is ToolCall => block.type === "toolCall")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.arguments ?? {}),
          },
        }));
      if (!textContent && toolCalls.length === 0) {
        continue;
      }
      messages.push({
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const toolText = msg.content
      .filter(isTextContentBlock)
      .filter((block) => block.text.trim().length > 0)
      .map((block) => block.text)
      .join("\n")
      .trim();
    messages.push({
      role: "tool",
      content: toolText || (msg.isError ? "[tool error] (no tool output)" : "(no tool output)"),
      tool_call_id: msg.toolCallId,
      name: msg.toolName || undefined,
    });
  }

  return messages;
}

function convertToolsToChat(tools: Tool[]): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    strict: false;
  };
}> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    },
  }));
}

function emitAssistantMessageEvents(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
): void {
  stream.push({ type: "start", partial: message });
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex: index, partial: message });
      if (block.text.length > 0) {
        stream.push({
          type: "text_delta",
          contentIndex: index,
          delta: block.text,
          partial: message,
        });
      }
      stream.push({
        type: "text_end",
        contentIndex: index,
        content: block.text,
        partial: message,
      });
      continue;
    }
    if (block.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex: index, partial: message });
      if (block.thinking.length > 0) {
        stream.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: block.thinking,
          partial: message,
        });
      }
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: message,
      });
      continue;
    }

    const argsJson = JSON.stringify(block.arguments ?? {});
    stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
    if (argsJson.length > 0) {
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: argsJson,
        partial: message,
      });
    }
    stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: block,
      partial: message,
    });
  }
}

async function callOpenAICompatChatCompletions(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  await appendLiveProviderDebug(
    `request model=${model.id} messages=${context.messages.length} tools=${context.tools?.length ?? 0} systemPrompt=${context.systemPrompt ? "yes" : "no"}`,
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [LIVE_OPENAI_COMPAT_HEADER_NAME]: resolveCompatAuthHeaderValue(
      options?.apiKey ?? LIVE_OPENAI_COMPAT_API_KEY,
    ),
    ...model.headers,
    ...options?.headers,
  };

  const body: Record<string, unknown> = {
    model: model.id,
    messages: convertMessagesToChat(model, context),
    stream: false,
  };

  if (typeof options?.temperature === "number") {
    body.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number" && options.maxTokens > 0) {
    body.max_completion_tokens = options.maxTokens;
  }
  if (context.tools?.length) {
    body.tools = convertToolsToChat(context.tools);
  }

  const url = `${model.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const curlArgs = [
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--max-time",
    "90",
    "-X",
    "POST",
    url,
  ];
  for (const [key, value] of Object.entries(headers)) {
    curlArgs.push("-H", `${key}: ${value}`);
  }
  curlArgs.push("-d", JSON.stringify(body));

  const rawText = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "curl",
      curlArgs,
      {
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errorMessage =
            stderr || (error instanceof Error ? error.message : "unknown curl error");
          reject(new Error(`openai-compatible chat completion failed: ${errorMessage}`));
          return;
        }
        resolve(stdout);
      },
    );
    const abort = () => {
      child.kill("SIGTERM");
      reject(new Error("Request was aborted"));
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
      child.on("close", () => {
        options.signal?.removeEventListener("abort", abort);
      });
    }
  });

  let parsed: ChatCompletionResponse | undefined;
  try {
    parsed = rawText ? (JSON.parse(rawText) as ChatCompletionResponse) : undefined;
  } catch {
    parsed = undefined;
  }

  const completion = parsed ?? {};
  const choice = completion.choices?.[0];
  const result = createAssistantOutput(model);
  result.responseId = completion.id;
  result.usage = parseUsage(completion);

  const stop = mapFinishReason(choice?.finish_reason);
  result.stopReason = stop.stopReason;
  result.errorMessage = stop.errorMessage;

  const message = choice?.message;
  const text = extractTextContent(message?.content).trim();
  if (text.length > 0) {
    result.content.push({ type: "text", text });
  }

  for (const [index, toolCall] of (message?.tool_calls ?? []).entries()) {
    const name = toolCall.function?.name?.trim();
    if (!name) {
      continue;
    }
    let args: Record<string, unknown> = {};
    const rawArgs = toolCall.function?.arguments?.trim();
    if (rawArgs) {
      try {
        const parsedArgs = JSON.parse(rawArgs) as unknown;
        if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
          args = parsedArgs as Record<string, unknown>;
        }
      } catch {
        throw new Error(`Provider returned invalid tool arguments for ${name}: ${rawArgs}`);
      }
    }
    result.content.push({
      type: "toolCall",
      id: toolCall.id?.trim() || `live-tool-${index}`,
      name,
      arguments: args,
    });
  }

  await appendLiveProviderDebug(
    `response id=${result.responseId ?? "none"} stop=${result.stopReason} contentBlocks=${result.content.length} text=${JSON.stringify(
      result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    )}`,
  );

  return result;
}

function createOpenAICompatLiveStreamFn() {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        await appendLiveProviderDebug(`stream start model=${model.id}`);
        const message = await callOpenAICompatChatCompletions(model, context, options);
        emitAssistantMessageEvents(stream, message);
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          await appendLiveProviderDebug(
            `stream error-stop model=${model.id} stop=${message.stopReason}`,
          );
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          await appendLiveProviderDebug(`stream done model=${model.id} stop=${message.stopReason}`);
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : message.stopReason,
            message,
          });
        }
      } catch (error) {
        const failure = createAssistantOutput(model);
        failure.stopReason = options?.signal?.aborted ? "aborted" : "error";
        failure.errorMessage = error instanceof Error ? error.message : String(error);
        await appendLiveProviderDebug(
          `stream exception model=${model.id} stop=${failure.stopReason} error=${JSON.stringify(failure.errorMessage)}`,
        );
        stream.push({
          type: "error",
          reason: failure.stopReason === "aborted" ? "aborted" : "error",
          error: failure,
        });
      } finally {
        stream.end();
      }
    })();
    return stream;
  };
}

const originalOpenAICompletionsProvider = getApiProvider("openai-completions" as Api);

function installOpenAICompatCompletionsOverride(): void {
  const streamFn = createOpenAICompatLiveStreamFn();
  registerApiProvider(
    {
      api: "openai-completions" as Api,
      stream: streamFn,
      streamSimple: streamFn,
    },
    LIVE_OPENAI_COMPAT_OVERRIDE_SOURCE,
  );
}

function restoreOpenAICompletionsProvider(): void {
  unregisterApiProviders(LIVE_OPENAI_COMPAT_OVERRIDE_SOURCE);
  if (originalOpenAICompletionsProvider) {
    registerApiProvider(
      {
        api: "openai-completions" as Api,
        stream: originalOpenAICompletionsProvider.stream,
        streamSimple: originalOpenAICompletionsProvider.streamSimple,
      },
      "openclaw-openai-compat-live-test-restore",
    );
  }
}

async function runOpenAICompletionsOverrideProbe(): Promise<string> {
  installOpenAICompatCompletionsOverride();
  const provider = getApiProvider("openai-completions" as Api);
  if (!provider) {
    throw new Error("openai-completions provider missing after live override install");
  }

  const model: Model<Api> = {
    id: LIVE_OPENAI_COMPAT_MODEL,
    name: `OpenAI Compat ${LIVE_OPENAI_COMPAT_MODEL}`,
    api: "openai-completions",
    provider: LIVE_PROVIDER_ID,
    baseUrl: LIVE_OPENAI_COMPAT_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    headers: {
      "accept-encoding": "identity",
      [LIVE_OPENAI_COMPAT_HEADER_NAME]: resolveCompatAuthHeaderValue(LIVE_OPENAI_COMPAT_API_KEY),
    },
  };
  const stream = provider.streamSimple(
    model,
    {
      messages: [
        { role: "user", content: "Reply with exactly PROVIDER_PROBE_OK.", timestamp: Date.now() },
      ],
    },
    {
      apiKey: LIVE_OPENAI_COMPAT_API_KEY,
      maxTokens: 64,
      headers: {
        "accept-encoding": "identity",
        [LIVE_OPENAI_COMPAT_HEADER_NAME]: resolveCompatAuthHeaderValue(LIVE_OPENAI_COMPAT_API_KEY),
      },
    },
  );
  const message = await stream.result();
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text;
}

function randomToken(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function getFreeGatewayPort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 41_000,
  });
}

async function connectClient(params: {
  url: string;
  token: string;
  timeoutMs?: number;
  onEvent?: (evt: EventFrame) => void;
}) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };

    const failWithClose = (code: number, reason: string) =>
      finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) });

    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: "test",
      onEvent: params.onEvent,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: failWithClose,
    });

    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      params.timeoutMs ?? 10_000,
    );
    connectTimeout.unref?.();
    client.start();
  });
}

type GatewayAgentEventPayload = {
  runId?: unknown;
  stream?: unknown;
  data?: {
    text?: unknown;
    delta?: unknown;
    phase?: unknown;
    error?: unknown;
  };
};

function extractAssistantTextFromEvents(events: EventFrame[], runId: string): string {
  let combined = "";
  let sawAssistantEvent = false;
  for (const evt of events) {
    if (evt.event !== "agent") {
      continue;
    }
    const payload = evt.payload as GatewayAgentEventPayload | undefined;
    if (payload?.runId !== runId || payload.stream !== "assistant") {
      continue;
    }
    sawAssistantEvent = true;
    const delta = payload.data?.delta;
    if (typeof delta === "string" && delta.length > 0) {
      combined += delta;
      continue;
    }
    const text = payload.data?.text;
    if (typeof text === "string" && text.length > 0) {
      combined = text;
    }
  }
  return sawAssistantEvent ? normalizeAssistantText(combined) : "";
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const intervalMs = opts?.intervalMs ?? 500;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readAssistantTextsForSessionKey(sessionKey: string): string[] {
  const loaded = loadSessionEntry(sessionKey);
  if (!loaded.entry?.sessionId) {
    return [];
  }
  return readSessionMessages(loaded.entry.sessionId, loaded.storePath, loaded.entry.sessionFile)
    .filter(
      (message) =>
        message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "assistant",
    )
    .map((message) => extractTranscriptText(message))
    .filter((text) => text.length > 0);
}

function readLatestAssistantTextForSessionKey(
  sessionKey: string,
  baselineAssistantCount: number,
): string | null {
  const texts = readAssistantTextsForSessionKey(sessionKey)
    .slice(baselineAssistantCount)
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return texts.at(-1) ?? null;
}

async function requestGatewayAgentText(params: {
  client: GatewayClient;
  events: EventFrame[];
  sessionKey: string;
  idempotencyKey: string;
  message: string;
  timeoutMs?: number;
}): Promise<{ runId: string; text: string }> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const baselineAssistantCount = readAssistantTextsForSessionKey(params.sessionKey).length;
  const accepted = await params.client.request<{ runId?: unknown; status?: unknown }>("agent", {
    sessionKey: params.sessionKey,
    idempotencyKey: params.idempotencyKey,
    message: params.message,
    deliver: false,
  });
  if (accepted?.status !== "accepted") {
    throw new Error(`agent status=${String(accepted?.status)}`);
  }
  const runId =
    typeof accepted.runId === "string" && accepted.runId.trim() ? accepted.runId.trim() : "";
  if (!runId) {
    throw new Error(`agent did not return a runId for ${params.sessionKey}`);
  }
  const runPromise = params.client.request<{
    runId?: string;
    status?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
  }>(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      // Keep a transport cushion beyond the server-side wait budget so a slow
      // live run cannot finish just after the client gives up.
      timeoutMs: timeoutMs + 30_000,
    },
  );
  const runResult = await runPromise;
  if (runResult?.status !== "ok") {
    throw new Error(
      `agent.wait failed for ${params.sessionKey} run=${runId}: status=${String(runResult?.status)} error=${runResult?.error ?? ""}`,
    );
  }

  // Real multi-step runs can emit interim NO_REPLY or partial assistant text
  // before the final answer is persisted. After completion, read the newest
  // deliverable text instead of latching onto the first assistant payload.
  const finalText = await waitFor(
    `final assistant output for ${params.sessionKey}`,
    async () => {
      const transcriptText = readLatestAssistantTextForSessionKey(
        params.sessionKey,
        baselineAssistantCount,
      );
      if (transcriptText && !isSilentReplyText(transcriptText)) {
        return transcriptText;
      }
      const eventText = extractAssistantTextFromEvents(params.events, runId);
      if (eventText && !isSilentReplyText(eventText)) {
        return eventText;
      }
      return null;
    },
    { timeoutMs: 15_000, intervalMs: 250 },
  ).catch(() => null);
  if (finalText) {
    return { runId, text: finalText };
  }

  const transcriptText = readLatestAssistantTextForSessionKey(
    params.sessionKey,
    baselineAssistantCount,
  );
  if (transcriptText) {
    return { runId, text: transcriptText };
  }
  const eventText = extractAssistantTextFromEvents(params.events, runId);
  if (eventText) {
    return { runId, text: eventText };
  }

  const assistantTexts = readAssistantTextsForSessionKey(params.sessionKey)
    .slice(baselineAssistantCount)
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  throw new Error(
    `agent run completed without readable assistant output for ${params.sessionKey} run=${runId}; replies=${assistantTexts.length}`,
  );
}

function buildWorkspaceInstructions(): string {
  return `# Live Canary Instructions

When the user message contains TEAM_CANARY:
- You must call sessions_spawn exactly twice: one child for alpha and one child for beta.
- Wait for both child completion messages before your final answer.
- After both children finish, call memory_write exactly once with the provided memory key.
- Your final answer must be JSON only with keys alpha, beta, memoryKey.

When the user message contains MEMORY_CANARY_RECALL:
- You must call memory_search before answering.
- Your final answer must be JSON only with keys alpha, beta, memoryKey.
`;
}

function buildConfig(params: {
  workspaceDir: string;
  sessionStorePath: string;
  collectionPrefix: string;
}): OpenClawConfig {
  const modelKey = `${LIVE_PROVIDER_ID}/${LIVE_OPENAI_COMPAT_MODEL}`;
  return {
    session: {
      scope: "per-sender",
      mainKey: "main",
      store: params.sessionStorePath,
    },
    tools: {
      allow: ["memory_search", "memory_write", "sessions_spawn"],
    },
    models: {
      providers: {
        [LIVE_PROVIDER_ID]: {
          baseUrl: LIVE_OPENAI_COMPAT_BASE_URL,
          api: "openai-completions",
          apiKey: LIVE_OPENAI_COMPAT_API_KEY,
          headers: {
            "accept-encoding": "identity",
            [LIVE_OPENAI_COMPAT_HEADER_NAME]: resolveCompatAuthHeaderValue(
              LIVE_OPENAI_COMPAT_API_KEY,
            ),
          },
          models: [
            {
              id: LIVE_OPENAI_COMPAT_MODEL,
              name: `OpenAI Compat ${LIVE_OPENAI_COMPAT_MODEL}`,
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: modelKey },
        models: {
          [modelKey]: {
            streaming: false,
          },
        },
        timeoutSeconds: 420,
        subagents: {
          maxSpawnDepth: 2,
          runTimeoutSeconds: 180,
          model: { primary: modelKey },
        },
        memorySearch: {
          enabled: true,
          sources: ["memory"],
          sync: {
            onSearch: true,
            onSessionStart: false,
            watch: false,
          },
        },
      },
      list: [
        {
          id: "main",
          skills: [],
        },
      ],
    },
    memory: {
      backend: "mongodb",
      citations: "off",
      mongodb: {
        uri: TEST_URI,
        database: "openclaw_live",
        collectionPrefix: params.collectionPrefix,
        deploymentProfile: "community-mongot",
        embeddingMode: "automated",
        enableChangeStreams: false,
      },
    },
  };
}

async function armMongoMemoryBackend(cfg: OpenClawConfig): Promise<void> {
  const warnings: string[] = [];
  await startGatewayMemoryBackend({
    cfg,
    log: {
      info: () => {},
      warn: (msg) => {
        warnings.push(msg);
      },
    },
  });
  if (warnings.length > 0) {
    throw new Error(`mongodb memory startup warnings: ${warnings.join(" | ")}`);
  }
}

async function prewarmLiveAgentRuntime(cfg: OpenClawConfig): Promise<void> {
  ensureRuntimePluginsLoaded({
    config: cfg,
    workspaceDir: cfg.agents?.defaults?.workspace,
    allowGatewaySubagentBinding: true,
  });
  await loadModelCatalog({ config: cfg });
}

function extractJsonObject(text: string): Record<string, string> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`Could not find JSON object in response: ${text}`);
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, string>;
}

function extractTranscriptText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as {
    text?: unknown;
    content?: unknown;
  };
  if (typeof record.text === "string" && record.text.trim()) {
    return normalizeAssistantText(record.text);
  }
  const content = record.content;
  if (typeof content === "string") {
    return normalizeAssistantText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return normalizeAssistantText(
    content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        return typeof (part as { text?: unknown }).text === "string"
          ? ((part as { text: string }).text ?? "").trim()
          : "";
      })
      .filter(Boolean)
      .join(" ")
      .trim(),
  );
}

function normalizeAssistantText(text: string): string {
  return stripInlineDirectiveTagsForDelivery(text).text.trim();
}

async function waitForStructuredMemory(
  db: Db,
  prefix: string,
  memoryKey: string,
): Promise<Document> {
  return await waitFor(
    `structured memory ${memoryKey}`,
    async () =>
      await structuredMemCollection(db, prefix).findOne({
        key: memoryKey,
        state: "active",
      }),
    { timeoutMs: 120_000, intervalMs: 1_000 },
  );
}

describeLive("gateway live multi-agent MongoDB canary", () => {
  it("runs a real parent-child team task and recalls the result from MongoDB in a fresh session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-multi-agent-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionStorePath = path.join(tempDir, "sessions", "sessions.json");
    const configPath = path.join(tempDir, "openclaw.json");
    const agentDir = path.join(tempDir, "agents", "main", "agent");
    const collectionPrefix = `live_team_${randomUUID().replaceAll("-", "").slice(0, 12)}_`;
    const token = `test-${randomUUID()}`;
    const previous = {
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
      agentDir: process.env.OPENCLAW_AGENT_DIR,
      piCodingAgentDir: process.env.PI_CODING_AGENT_DIR,
      skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
      skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
      skipCron: process.env.OPENCLAW_SKIP_CRON,
      skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    };

    const parentSessionKey = `agent:main:team-canary-${randomUUID().slice(0, 8)}`;
    const baselineSessionKey = `agent:main:baseline-${randomUUID().slice(0, 8)}`;
    const recallSessionKey = `agent:main:team-recall-${randomUUID().slice(0, 8)}`;
    const memoryKey = `team-canary-${randomUUID().slice(0, 8)}`;
    const baselineToken = randomToken("BASELINE");
    const alphaToken = randomToken("ALPHA");
    const betaToken = randomToken("BETA");

    const mongoClient = new MongoClient(TEST_URI, {
      maxPoolSize: 5,
      minPoolSize: 1,
      connectTimeoutMS: 10_000,
    });
    const gatewayEvents: EventFrame[] = [];

    let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
    let client: GatewayClient | null = null;

    try {
      installOpenAICompatCompletionsOverride();
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), buildWorkspaceInstructions());
      const cfg = buildConfig({
        workspaceDir,
        sessionStorePath,
        collectionPrefix,
      });
      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);

      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      clearRuntimeConfigSnapshot();

      const providerProbeText = await runOpenAICompletionsOverrideProbe();
      expect(providerProbeText).toBe("PROVIDER_PROBE_OK");

      await mongoClient.connect();
      const db = mongoClient.db("openclaw_live");

      // Real MongoDB bootstrapping can take time because it creates validators,
      // standard indexes, and Search/Vector Search indexes. Warm it fully before
      // the first live agent turn so the canary measures runtime behavior, not
      // startup races.
      await armMongoMemoryBackend(cfg);
      await prewarmLiveAgentRuntime(cfg);

      const port = await getFreeGatewayPort();
      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await armMongoMemoryBackend(cfg);
      installOpenAICompatCompletionsOverride();
      client = await connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        timeoutMs: 15_000,
        onEvent: (evt) => {
          gatewayEvents.push(evt);
        },
      });

      installOpenAICompatCompletionsOverride();
      const baselineRun = await requestGatewayAgentText({
        client,
        events: gatewayEvents,
        sessionKey: baselineSessionKey,
        idempotencyKey: `idem-baseline-${randomUUID()}`,
        message: `Reply with exactly ${baselineToken}.`,
        timeoutMs: 120_000,
      });
      expect(baselineRun.text.trim()).toBe(baselineToken);

      const parentPrompt = [
        "TEAM_CANARY.",
        "Use sessions_spawn exactly twice and no fewer.",
        `Spawn one alpha child whose entire final answer is exactly ${alphaToken}.`,
        `Spawn one beta child whose entire final answer is exactly ${betaToken}.`,
        `After both child completion events arrive, call memory_write with type=project, key=${memoryKey}, value=${JSON.stringify(
          JSON.stringify({
            alpha: alphaToken,
            beta: betaToken,
            scenario: "TEAM_CANARY",
          }),
        )}.`,
        `Your own final answer must be exactly ${JSON.stringify({
          alpha: alphaToken,
          beta: betaToken,
          memoryKey,
        })}.`,
      ].join(" ");

      const parentRun = await requestGatewayAgentText({
        client,
        events: gatewayEvents,
        sessionKey: parentSessionKey,
        idempotencyKey: `idem-parent-${randomUUID()}`,
        message: parentPrompt,
        timeoutMs: 420_000,
      });

      const parentResult = extractJsonObject(parentRun.text);
      expect(parentResult).toEqual({
        alpha: alphaToken,
        beta: betaToken,
        memoryKey,
      });
      const distinctSessionIds = await waitFor(
        `distinct session ids for ${parentSessionKey}`,
        async () => {
          const sessionIds = await eventsCollection(db, collectionPrefix).distinct("sessionId");
          return sessionIds.length >= 4 ? sessionIds : null;
        },
        { timeoutMs: 120_000, intervalMs: 1_000 },
      );
      expect(distinctSessionIds.length).toBeGreaterThanOrEqual(4);

      const persistedStructuredMemory = await waitForStructuredMemory(
        db,
        collectionPrefix,
        memoryKey,
      );
      expect(persistedStructuredMemory).toMatchObject({
        key: memoryKey,
        type: "project",
        state: "active",
      });
      expect(String(persistedStructuredMemory.value)).toContain(alphaToken);
      expect(String(persistedStructuredMemory.value)).toContain(betaToken);

      const parentSession = await waitFor(
        `parent session entry ${parentSessionKey}`,
        async () => {
          const loaded = loadSessionEntry(parentSessionKey);
          return loaded.entry?.sessionId ? loaded : null;
        },
        { timeoutMs: 60_000, intervalMs: 500 },
      );

      await waitFor(
        `parent events for ${parentSessionKey}`,
        async () => {
          const count = await eventsCollection(db, collectionPrefix).countDocuments({
            sessionId: parentSession.entry?.sessionId,
          });
          return count >= 2 ? count : null;
        },
        { timeoutMs: 60_000, intervalMs: 1_000 },
      );

      await waitFor(
        `projected chunks for ${parentSessionKey}`,
        async () => {
          const count = await chunksCollection(db, collectionPrefix).countDocuments({
            sessionId: parentSession.entry?.sessionId,
          });
          return count >= 1 ? count : null;
        },
        { timeoutMs: 90_000, intervalMs: 1_000 },
      );

      const recallPrompt = [
        "MEMORY_CANARY_RECALL.",
        "Use memory_search first.",
        `Recover the saved alpha and beta values for memory key ${memoryKey}.`,
        `Reply with exactly ${JSON.stringify({
          alpha: alphaToken,
          beta: betaToken,
          memoryKey,
        })}.`,
      ].join(" ");

      const recallRun = await requestGatewayAgentText({
        client,
        events: gatewayEvents,
        sessionKey: recallSessionKey,
        idempotencyKey: `idem-recall-${randomUUID()}`,
        message: recallPrompt,
        timeoutMs: 240_000,
      });

      const recallResult = extractJsonObject(recallRun.text);
      expect(recallResult).toEqual({
        alpha: alphaToken,
        beta: betaToken,
        memoryKey,
      });
    } finally {
      restoreOpenAICompletionsProvider();
      clearRuntimeConfigSnapshot();
      await closeAllMemorySearchManagers();
      await client?.stopAndWait({ timeoutMs: 5_000 }).catch(() => {
        client?.stop();
      });
      await server?.close();
      await mongoClient.close().catch(() => undefined);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);

      if (previous.configPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
      }
      if (previous.gatewayToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous.gatewayToken;
      }
      if (previous.agentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previous.agentDir;
      }
      if (previous.piCodingAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous.piCodingAgentDir;
      }
      if (previous.skipChannels === undefined) {
        delete process.env.OPENCLAW_SKIP_CHANNELS;
      } else {
        process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
      }
      if (previous.skipGmail === undefined) {
        delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
      } else {
        process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
      }
      if (previous.skipCron === undefined) {
        delete process.env.OPENCLAW_SKIP_CRON;
      } else {
        process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
      }
      if (previous.skipCanvas === undefined) {
        delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
      } else {
        process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
      }
    }
  }, 600_000);
});
