import { SessionManager } from "@mariozechner/pi-coding-agent";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import type { OpenClawConfig } from "../../config/config.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

export type GatewayInjectedAbortMeta = {
  aborted: true;
  origin: "rpc" | "stop-command";
  runId: string;
};

export type GatewayInjectedTranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

export function appendInjectedAssistantMessageToTranscript(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  transcriptPath: string;
  message: string;
  label?: string;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  now?: number;
}): GatewayInjectedTranscriptAppendResult {
  const now = params.now ?? Date.now();
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const messageBody: AppendMessageArg & Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    // Pi stopReason is a strict enum; this is not model output, but we still store it as a
    // normal assistant message so it participates in the session parentId chain.
    stopReason: "stop",
    usage,
    // Make these explicit so downstream tooling never treats this as model output.
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.abortMeta
      ? {
          openclawAbort: {
            aborted: true,
            origin: params.abortMeta.origin,
            runId: params.abortMeta.runId,
          },
        }
      : {}),
  };

  try {
    // IMPORTANT: Use SessionManager so the entry is attached to the current leaf via parentId.
    // Raw jsonl appends break the parent chain and can hide compaction summaries from context.
    const sessionManager = guardSessionManager(SessionManager.open(params.transcriptPath), {
      cfg: params.cfg,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    const messageId = sessionManager.appendMessage(messageBody);
    void sessionManager.flushPendingPersistedWrites?.();
    emitSessionTranscriptUpdate({
      sessionFile: params.transcriptPath,
      sessionKey: params.sessionKey,
      message: messageBody,
      messageId,
    });
    return { ok: true, messageId, message: messageBody };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
