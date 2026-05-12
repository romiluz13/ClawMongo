import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMemorySearchManager } from "./search-manager.js";
import { extractSessionText } from "./session-files.js";

const log = createSubsystemLogger("memory:runtime-write");

type PersistedMessageMeta = {
  toolCallId?: string;
  toolName?: string;
  isSynthetic?: boolean;
};

type ConversationEventPayload = {
  role: "user" | "assistant" | "system" | "tool";
  body: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
};

function normalizeConversationText(content: unknown): string | null {
  const text = extractSessionText(content);
  if (!text) {
    return null;
  }
  const safe = redactSensitiveText(text, { mode: "tools" });
  return safe.trim() || null;
}

function buildConversationEventPayload(params: {
  message: AgentMessage;
  meta?: PersistedMessageMeta;
}): ConversationEventPayload | null {
  const role = (params.message as { role?: unknown }).role;
  const timestampValue = (params.message as { timestamp?: unknown }).timestamp;
  const timestamp =
    typeof timestampValue === "number" && Number.isFinite(timestampValue)
      ? new Date(timestampValue)
      : undefined;

  if (role === "toolResult") {
    if (params.meta?.isSynthetic) {
      return null;
    }
    const body = normalizeConversationText((params.message as { content?: unknown }).content);
    if (!body) {
      return null;
    }
    const toolResult = params.message as {
      isError?: boolean;
      toolCallId?: string;
      toolUseId?: string;
    };
    return {
      role: "tool",
      body,
      timestamp,
      metadata: {
        ...(params.meta?.toolName ? { toolName: params.meta.toolName } : {}),
        ...(params.meta?.toolCallId ? { toolCallId: params.meta.toolCallId } : {}),
        ...(toolResult.toolUseId ? { toolUseId: toolResult.toolUseId } : {}),
        ...(toolResult.isError === true ? { isError: true } : {}),
      },
    };
  }

  if (role !== "user" && role !== "assistant" && role !== "system") {
    return null;
  }

  const body = normalizeConversationText((params.message as { content?: unknown }).content);
  if (!body) {
    return null;
  }

  const message = params.message as {
    api?: unknown;
    provider?: unknown;
    model?: unknown;
    stopReason?: unknown;
  };
  const metadata: Record<string, unknown> = {};
  if (typeof message.api === "string" && message.api.trim()) {
    metadata.api = message.api;
  }
  if (typeof message.provider === "string" && message.provider.trim()) {
    metadata.provider = message.provider;
  }
  if (typeof message.model === "string" && message.model.trim()) {
    metadata.model = message.model;
  }
  if (typeof message.stopReason === "string" && message.stopReason.trim()) {
    metadata.stopReason = message.stopReason;
  }

  return {
    role,
    body,
    timestamp,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

export async function persistConversationMessageToMongo(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId?: string;
  message: AgentMessage;
  meta?: PersistedMessageMeta;
}): Promise<void> {
  const event = buildConversationEventPayload({
    message: params.message,
    meta: params.meta,
  });
  if (!event) {
    return;
  }

  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!manager) {
    if (error) {
      log.debug(`skipping runtime memory write: ${error}`);
    }
    return;
  }

  const writer = manager as {
    writeConversationEvent?: (
      event: ConversationEventPayload & { sessionId?: string },
    ) => Promise<unknown>;
  };
  if (typeof writer.writeConversationEvent !== "function") {
    return;
  }

  try {
    await writer.writeConversationEvent({
      ...event,
      sessionId: params.sessionId,
    });
  } catch (err) {
    log.warn(`runtime memory write failed: ${String(err)}`);
  }
}
