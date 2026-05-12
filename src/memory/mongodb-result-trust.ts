import type {
  MemorySearchResult,
  MemorySearchTrust,
  MemorySearchTrustBand,
  MemorySearchTrustSummary,
} from "./types.js";

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
  return result.signals?.reviewAt instanceof Date && result.signals.reviewAt.getTime() < now.getTime();
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

/**
 * Compute time-decayed effective importance.
 * importance * 0.5^(daysSinceCreation / recencyHalfLifeDays)
 * @param importance - raw importance score (0-1)
 * @param createdAt - when the document was created
 * @param now - current time
 * @param recencyHalfLifeDays - half-life in days (default 7)
 */
export function computeImportanceDecay(
  importance: number | undefined,
  createdAt: Date | undefined,
  now: Date = new Date(),
  recencyHalfLifeDays: number = 7,
  temporalScope?: string,
): number {
  const raw =
    typeof importance === "number" && Number.isFinite(importance) ? clamp01(importance) : 0.5;
  // Permanent and ongoing memories NEVER decay — preferences, facts, etc.
  if (temporalScope === "permanent" || temporalScope === "ongoing") {
    return raw;
  }
  if (!(createdAt instanceof Date)) {
    return raw;
  }
  const daysSinceCreation = Math.max(0, (now.getTime() - createdAt.getTime()) / DAY_MS);
  return clamp01(raw * 0.5 ** (daysSinceCreation / recencyHalfLifeDays));
}

export function applyTrustAwareReranking(
  results: MemorySearchResult[],
  params?: {
    diversityWeight?: number;
    episodeBoost?: number;
    trustWeight?: number;
    importanceWeight?: number;
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
  const importanceWeight = params?.importanceWeight ?? 0.1;
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

    // Importance decay: time-weighted importance as additive scoring component
    const importanceDecay = computeImportanceDecay(
      (result as Record<string, unknown>).importance as number | undefined,
      result.timestamp ?? result.signals?.updatedAt,
      now,
    );
    adjustedScore += importanceDecay * importanceWeight;

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

  return scored.map(({ result, trust, adjustedScore }) =>
    Object.assign({}, result, {
      score: adjustedScore,
      trust,
    }),
  );
}

function classifyTrustBand(score: number): MemorySearchTrustBand {
  if (score >= 0.8) {
    return "high";
  }
  if (score >= 0.55) {
    return "medium";
  }
  return "low";
}

export function summarizeResultTrust(results: MemorySearchResult[]): MemorySearchTrustSummary {
  if (results.length === 0) {
    return {
      topScore: null,
      averageScore: null,
      topBand: null,
      distribution: { high: 0, medium: 0, low: 0 },
      contradictionCount: 0,
      staleCount: 0,
      exactCount: 0,
      sourceDiversity: "none",
    };
  }

  const trusts = results
    .map((result) => result.trust ?? computeResultTrust(result))
    .filter((trust): trust is MemorySearchTrust => Boolean(trust));
  if (trusts.length === 0) {
    return {
      topScore: null,
      averageScore: null,
      topBand: null,
      distribution: { high: 0, medium: 0, low: 0 },
      contradictionCount: 0,
      staleCount: 0,
      exactCount: 0,
      sourceDiversity: "none",
    };
  }

  const distribution: Record<MemorySearchTrustBand, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  let topScore = 0;
  let totalScore = 0;
  let contradictionCount = 0;
  let staleCount = 0;
  let exactCount = 0;

  for (const trust of trusts) {
    totalScore += trust.score;
    topScore = Math.max(topScore, trust.score);
    distribution[classifyTrustBand(trust.score)] += 1;
    if (trust.contradiction < 0.5) {
      contradictionCount += 1;
    }
    if (trust.freshness < 0.4) {
      staleCount += 1;
    }
    if (trust.exactness >= 0.9) {
      exactCount += 1;
    }
  }

  const sourceKinds = new Set(results.map((result) => result.source));
  return {
    topScore: clamp01(topScore),
    averageScore: clamp01(totalScore / trusts.length),
    topBand: classifyTrustBand(topScore),
    distribution,
    contradictionCount,
    staleCount,
    exactCount,
    sourceDiversity: sourceKinds.size === 0 ? "none" : sourceKinds.size === 1 ? "single" : "multi",
  };
}
