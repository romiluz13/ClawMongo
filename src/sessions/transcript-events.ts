import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: AgentMessage;
  messageId?: string;
};

type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }
      : {
          sessionFile: update.sessionFile,
          sessionKey: update.sessionKey,
          message: update.message,
          messageId: update.messageId,
        };
  const trimmed = normalized.sessionFile.trim();
  if (!trimmed) {
    return;
  }
  const nextUpdate = { ...normalized, sessionFile: trimmed };
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
