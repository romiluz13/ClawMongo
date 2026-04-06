import type { CanonicalEvent } from "./mongodb-events.js";
import type { MemorySearchResult, MemorySource } from "./types.js";

const RAW_WINDOW_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "now",
  "of",
  "on",
  "or",
  "our",
  "right",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

type RawWindowQueryProfile = {
  tokens: string[];
  anchorTokens: string[];
  phrases: string[];
};

type RankedRawWindowEvent = {
  event: Pick<CanonicalEvent, "eventId" | "body" | "metadata" | "sessionId" | "timestamp">;
  tokenHits: number;
  anchorHits: number;
  phraseHits: number;
  tokenCoverage: number;
  phraseCoverage: number;
};

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  return normalized ? normalized.split(" ") : [];
}

function collectMetadataText(value: unknown, parts: string[]): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMetadataText(item, parts);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectMetadataText(nested, parts);
    }
  }
}

function buildRawWindowSearchableText(
  event: Pick<CanonicalEvent, "body" | "metadata" | "sessionId">,
): string {
  const parts: string[] = [event.body];
  if (event.sessionId) {
    parts.push(event.sessionId);
  }
  if (event.metadata) {
    collectMetadataText(event.metadata, parts);
  }
  return normalizeSearchText(parts.join(" "));
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function buildRawWindowQueryProfile(query: string): RawWindowQueryProfile {
  const orderedTokens = tokenizeSearchText(query).filter(
    (token) => token.length > 1 && !RAW_WINDOW_TOKEN_STOPWORDS.has(token),
  );
  const tokens = dedupePreservingOrder(orderedTokens);
  const anchorTokens = tokens.filter((token) => /[-\d]/.test(token) || token.length >= 12);
  const phrases = new Set<string>();
  for (const size of [3, 2] as const) {
    for (let index = 0; index <= orderedTokens.length - size; index++) {
      const phraseTokens = orderedTokens.slice(index, index + size);
      if (phraseTokens.some((token) => RAW_WINDOW_TOKEN_STOPWORDS.has(token))) {
        continue;
      }
      phrases.add(phraseTokens.join(" "));
    }
  }
  return {
    tokens,
    anchorTokens,
    phrases: [...phrases],
  };
}

function countTokenHits(searchableText: string, tokens: string[]): number {
  if (tokens.length === 0 || !searchableText) {
    return 0;
  }
  const searchableTokens = new Set(searchableText.split(" "));
  let matches = 0;
  for (const token of tokens) {
    if (searchableTokens.has(token)) {
      matches++;
    }
  }
  return matches;
}

function countPhraseHits(searchableText: string, phrases: string[]): number {
  if (phrases.length === 0 || !searchableText) {
    return 0;
  }
  const paddedText = ` ${searchableText} `;
  let matches = 0;
  for (const phrase of phrases) {
    if (paddedText.includes(` ${phrase} `)) {
      matches++;
    }
  }
  return matches;
}

function toConversationResult(
  event: Pick<CanonicalEvent, "eventId" | "body" | "sessionId" | "timestamp">,
  rank: number,
): MemorySearchResult {
  return {
    canonicalId: event.eventId,
    path: `events/${event.eventId}`,
    filePath: `events/${event.eventId}`,
    startLine: 0,
    endLine: 0,
    snippet: event.body,
    score: Math.max(0.01, 1 - rank * 0.01),
    source: "conversation" as MemorySource,
    sourceType: "conversation" as MemorySource,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    timestamp: event.timestamp,
  };
}

export function rankRawWindowEvents(
  events: Array<Pick<CanonicalEvent, "eventId" | "body" | "metadata" | "sessionId" | "timestamp">>,
  query: string,
  maxResults: number,
): MemorySearchResult[] {
  const cappedLimit = Math.max(1, Math.min(50, Math.trunc(maxResults || 50)));
  const recentFirst = [...events].toSorted(
    (left, right) => right.timestamp.getTime() - left.timestamp.getTime(),
  );
  const profile = buildRawWindowQueryProfile(query);

  if (profile.tokens.length === 0) {
    return recentFirst
      .slice(0, cappedLimit)
      .map((event, index) => toConversationResult(event, index));
  }

  const ranked: RankedRawWindowEvent[] = recentFirst.map((event) => {
    const searchableText = buildRawWindowSearchableText(event);
    const tokenHits = countTokenHits(searchableText, profile.tokens);
    const anchorHits = countTokenHits(searchableText, profile.anchorTokens);
    const phraseHits = countPhraseHits(searchableText, profile.phrases);
    return {
      event,
      tokenHits,
      anchorHits,
      phraseHits,
      tokenCoverage: profile.tokens.length > 0 ? tokenHits / profile.tokens.length : 0,
      phraseCoverage: profile.phrases.length > 0 ? phraseHits / profile.phrases.length : 0,
    };
  });

  ranked.sort((left, right) => {
    if (left.anchorHits !== right.anchorHits) {
      return right.anchorHits - left.anchorHits;
    }
    if (left.phraseHits !== right.phraseHits) {
      return right.phraseHits - left.phraseHits;
    }
    if (left.tokenHits !== right.tokenHits) {
      return right.tokenHits - left.tokenHits;
    }
    if (left.phraseCoverage !== right.phraseCoverage) {
      return right.phraseCoverage - left.phraseCoverage;
    }
    if (left.tokenCoverage !== right.tokenCoverage) {
      return right.tokenCoverage - left.tokenCoverage;
    }
    return right.event.timestamp.getTime() - left.event.timestamp.getTime();
  });

  return ranked
    .slice(0, cappedLimit)
    .map((entry, index) => toConversationResult(entry.event, index));
}
