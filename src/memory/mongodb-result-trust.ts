import type { MemorySearchResult, MemorySearchTrust } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXACT_LOCATOR_PREFIXES = ["events/", "structured:", "procedure:", "episode:", "relation:"];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(6))));
}

function normalizeCount(
  value: number | undefined,
  saturationPoint: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return clamp01(value / saturationPoint);
}

function normalizeRetrievalScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  if (score <= 1) {
    return score;
  }
  return clamp01(score / (score + 1));
}

function resolveRecencyAnchor(result: MemorySearchResult): Date | undefined {
  return result.signals?.lastConfirmedAt ?? result.signals?.updatedAt ?? result.timestamp;
}

function computeExactness(result: MemorySearchResult): number {
  const locator = result.path.trim();
  if (EXACT_LOCATOR_PREFIXES.some((prefix) => locator.startsWith(prefix))) {
    return 1;
  }
  if (result.canonicalId?.trim()) {
    return 0.92;
  }
  if (locator && (result.startLine > 0 || result.endLine > 0)) {
    return 0.82;
  }
  if (locator) {
    return 0.72;
  }
  return 0.55;
}

function computeRecency(result: MemorySearchResult, now: Date): number {
  const anchor = resolveRecencyAnchor(result);
  if (!(anchor instanceof Date)) {
    return 0.65;
  }

  const temporalScope = result.signals?.temporalScope;
  const horizonMs =
    temporalScope === "ongoing" || temporalScope === "transient"
      ? 45 * DAY_MS
      : temporalScope === "bounded"
        ? 120 * DAY_MS
        : 365 * DAY_MS;
  const ageMs = Math.max(0, now.getTime() - anchor.getTime());
  return clamp01(0.1 + 0.9 * Math.max(0, 1 - ageMs / horizonMs));
}

function computeFreshness(result: MemorySearchResult, recency: number, now: Date): number {
  const signals = result.signals;
  let freshness =
    signals?.temporalScope === "permanent"
      ? 0.82
      : signals?.temporalScope === "bounded"
        ? 0.75
        : 0.7;

  if (signals?.state === "invalidated") {
    freshness = 0.08;
  } else if (signals?.state === "conflicted") {
    freshness = 0.35;
  }

  if (signals?.validTo instanceof Date && signals.validTo.getTime() < now.getTime()) {
    freshness *= 0.5;
  }
  if (signals?.reviewAt instanceof Date && signals.reviewAt.getTime() < now.getTime()) {
    freshness *= 0.7;
  }
  if (signals?.temporalScope === "ongoing" && recency < 0.5) {
    freshness *= 0.75;
  }

  return clamp01((freshness + recency) / 2);
}

function computeProvenance(result: MemorySearchResult): number {
  const signals = result.signals;
  const reliability = clamp01(signals?.sourceReliability ?? signals?.confidence ?? 0.65);
  const eventSupport = normalizeCount(signals?.sourceEventCount, 3, 0.55);
  const reinforcement = normalizeCount(signals?.reinforcementCount, 5, 0.5);
  return clamp01(reliability * 0.45 + eventSupport * 0.35 + reinforcement * 0.2);
}

function computeContradiction(result: MemorySearchResult): number {
  const signals = result.signals;
  if (signals?.state === "invalidated") {
    return 0.05;
  }
  if (signals?.state === "conflicted") {
    return 0.25;
  }
  if (typeof signals?.conflictCount === "number" && signals.conflictCount > 0) {
    return clamp01(Math.max(0.3, 0.7 - signals.conflictCount * 0.12));
  }
  return 1;
}

export function hasOverdueReview(result: MemorySearchResult, now = new Date()): boolean {
  return Boolean(
    result.signals?.reviewAt instanceof Date && result.signals.reviewAt.getTime() < now.getTime(),
  );
}

export function computeResultTrust(
  result: MemorySearchResult,
  now = new Date(),
): MemorySearchTrust {
  const exactness = computeExactness(result);
  const recency = computeRecency(result, now);
  const freshness = computeFreshness(result, recency, now);
  const provenance = computeProvenance(result);
  const contradiction = computeContradiction(result);

  return {
    score: clamp01(
      exactness * 0.24 +
        freshness * 0.22 +
        provenance * 0.22 +
        contradiction * 0.18 +
        recency * 0.14,
    ),
    freshness,
    provenance,
    exactness,
    contradiction,
    recency,
  };
}

export function applyTrustAwareReranking(
  results: MemorySearchResult[],
  params?: {
    diversityWeight?: number;
    episodeBoost?: number;
    trustWeight?: number;
    invalidatedPenalty?: number;
    conflictedPenalty?: number;
    overduePenalty?: number;
    now?: Date;
  },
): MemorySearchResult[] {
  if (results.length === 0) {
    return [];
  }

  const diversityWeight = params?.diversityWeight ?? 0.15;
  const episodeBoost = params?.episodeBoost ?? 0.12;
  const trustWeight = params?.trustWeight ?? 0.28;
  const invalidatedPenalty = params?.invalidatedPenalty ?? 0.55;
  const conflictedPenalty = params?.conflictedPenalty ?? 0.78;
  const overduePenalty = params?.overduePenalty ?? 0.92;
  const now = params?.now ?? new Date();

  const scored = results.map((result) => {
    let adjustedScore = normalizeRetrievalScore(result.score);
    if (result.path.startsWith("episode:")) {
      adjustedScore += episodeBoost;
    }

    const trust = computeResultTrust(result, now);
    adjustedScore = adjustedScore * (1 - trustWeight) + trust.score * trustWeight;

    if (result.signals?.state === "invalidated") {
      adjustedScore *= invalidatedPenalty;
    } else if (result.signals?.state === "conflicted") {
      adjustedScore *= conflictedPenalty;
    }
    if (hasOverdueReview(result, now)) {
      adjustedScore *= overduePenalty;
    }

    return {
      result,
      trust,
      adjustedScore: clamp01(adjustedScore),
    };
  });

  scored.sort((left, right) => right.adjustedScore - left.adjustedScore);

  const sourceCounts = new Map<string, number>();
  for (const entry of scored) {
    const source = entry.result.source;
    const count = (sourceCounts.get(source) ?? 0) + 1;
    sourceCounts.set(source, count);
    if (count > 2) {
      entry.adjustedScore = clamp01(entry.adjustedScore - diversityWeight * (count - 2));
    }
  }

  scored.sort((left, right) => right.adjustedScore - left.adjustedScore);

  return scored.map(({ result, trust, adjustedScore }) => ({
    ...result,
    score: adjustedScore,
    trust,
  }));
}
