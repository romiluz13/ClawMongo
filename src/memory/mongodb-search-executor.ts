import {
  applyTrustAwareReranking,
  computeResultTrust,
  hasOverdueReview,
} from "./mongodb-result-trust.js";
import type { RetrievalPath } from "./mongodb-retrieval-planner.js";
import {
  classifyRetrievalQuery,
  hasActiveCriticalSignal,
  resolveTimeRangePreset,
} from "./mongodb-retrieval-planner.js";
import { sortObject } from "./search-utils.js";
import type { MemorySearchResult } from "./types.js";
import type {
  EvidenceCoverage,
  MemorySearchClassification,
  MemorySearchContradictionSummary,
  MemorySearchMetadata,
  MemorySearchMode,
  MemorySearchPass,
  MemorySearchRequest,
  MemorySearchResponse,
  MemorySearchSourcePreference,
  RejectedResultSummary,
} from "./types.js";

export type MemorySearchExecutorTimeRange = {
  start: Date;
  end: Date;
};

export type MemorySearchExecutorRequest = MemorySearchRequest & {
  searchMode: MemorySearchMode;
  maxPasses: number;
  sourcePreference: MemorySearchSourcePreference[];
};

export type MemorySearchExecutorPlanPass = {
  pass: number;
  query: string;
  reason: string;
  variant: "original" | "rewrite" | "family-expansion" | "decomposition";
};

function sourcePreferencePaths(source: MemorySearchSourcePreference): RetrievalPath[] {
  switch (source) {
    case "conversation":
      return ["hybrid", "raw-window"];
    case "reference":
      return ["kb"];
    case "structured":
      return ["active-critical", "structured"];
    case "procedural":
      return ["procedural"];
    case "episodic":
      return ["episodic"];
    case "graph":
      return ["graph"];
    default:
      // Legacy sources ("memory", "sessions") map to conversation paths
      return ["hybrid", "raw-window"];
  }
}

function selectPassPaths(params: {
  availablePaths: Set<RetrievalPath>;
  sourcePreference: MemorySearchSourcePreference[];
  pass: number;
  timeRange?: MemorySearchExecutorTimeRange;
}): Set<RetrievalPath> {
  const allowed = new Set(params.availablePaths);
  if (params.timeRange) {
    for (const path of allowed) {
      if (!["raw-window", "hybrid", "episodic"].includes(path)) {
        allowed.delete(path);
      }
    }
  }
  if (params.sourcePreference.length === 0) {
    return allowed;
  }
  const preferredAllowed = new Set(
    params.sourcePreference.flatMap((source) => sourcePreferencePaths(source)),
  );
  const scopedAllowed = new Set(Array.from(allowed).filter((path) => preferredAllowed.has(path)));
  const preferredSource =
    params.sourcePreference[Math.min(params.pass - 1, params.sourcePreference.length - 1)];
  const preferredPaths = sourcePreferencePaths(preferredSource).filter((path) =>
    scopedAllowed.has(path),
  );
  if (preferredPaths.length === 0 || params.pass > params.sourcePreference.length) {
    return scopedAllowed;
  }
  return new Set(preferredPaths);
}

export function buildMemorySearchRequestSignature(request: MemorySearchRequest): string {
  return JSON.stringify(
    sortObject({
      query: request.query,
      maxResults: request.maxResults,
      minScore: request.minScore,
      searchMode: request.searchMode,
      sourcePreference: request.sourcePreference,
      timeRange: request.timeRange,
      needExactEvidence: request.needExactEvidence,
      maxPasses: request.maxPasses,
      conversationScope: request.conversationScope,
      structuredScope: request.structuredScope,
      referenceScope: request.referenceScope,
      proceduralScope: request.proceduralScope,
    }),
  );
}

export function normalizeMemorySearchRequest(
  request: MemorySearchRequest,
): MemorySearchExecutorRequest {
  const requestedMode = request.searchMode ?? "auto";
  const maxPassDefaults: Record<MemorySearchMode, number> = {
    direct: 1,
    auto: 2,
    agentic: 3,
  };
  const maxPasses = Math.max(
    1,
    Math.min(3, Math.trunc(request.maxPasses ?? maxPassDefaults[requestedMode])),
  );
  return {
    ...request,
    searchMode: requestedMode,
    maxPasses,
    // Only apply source ordering when the caller explicitly requested it.
    // Otherwise the planner's ranked paths should stay in charge.
    sourcePreference: request.sourcePreference ?? [],
  };
}

export function resolveExecutorTimeRange(
  request: MemorySearchRequest,
): MemorySearchExecutorTimeRange | undefined {
  const raw = request.timeRange;
  if (!raw) {
    return undefined;
  }
  if (raw.preset) {
    return resolveTimeRangePreset(raw.preset);
  }
  const start = raw.start ? new Date(raw.start) : undefined;
  const end = raw.end ? new Date(raw.end) : undefined;
  if (
    (start && Number.isNaN(start.getTime())) ||
    (end && Number.isNaN(end.getTime())) ||
    !start ||
    !end
  ) {
    return undefined;
  }
  return { start, end };
}

export function classifyExecutorSearch(request: MemorySearchRequest): MemorySearchClassification {
  return classifyRetrievalQuery({
    query: request.query,
    hasTimeRange: Boolean(request.timeRange),
    hasScopes: Boolean(
      request.conversationScope ||
      request.structuredScope ||
      request.referenceScope ||
      request.proceduralScope,
    ),
  });
}

function uniqueQueries(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(trimmed);
  }
  return ordered;
}

function normalizeFollowUpQuery(query: string): string {
  return query.replace(/[?!]+/g, " ").replace(/\s+/g, " ").trim();
}

const CLAUSE_VERB_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "before",
  "by",
  "can",
  "could",
  "define",
  "defined",
  "did",
  "do",
  "does",
  "for",
  "he",
  "how",
  "i",
  "in",
  "is",
  "it",
  "lead",
  "led",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "those",
  "to",
  "used",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "worked",
]);

function extractAnchorTerms(clause: string, maxTerms = 5): string {
  const tokens = normalizeFollowUpQuery(clause)
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .filter((token) => !CLAUSE_VERB_STOPWORDS.has(token.toLowerCase()));
  return tokens.slice(-maxTerms).join(" ");
}

function simplifyClauseForSearch(clause: string, anchor: string): string {
  const normalized = normalizeFollowUpQuery(clause);
  if (!normalized) {
    return "";
  }

  const hadPronounReference = /\b(?:it|they|them|that|those|these|he|she)\b/i.test(normalized);
  const simplified = normalized
    .replace(/^(?:who|what|which|where|when|why|how)\b\s*/i, "")
    .replace(
      /\b(?:did|does|do|is|are|was|were|can|could|should|would|will|it|they|them|that|those|these|he|she|define|defined|used)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (anchor && hadPronounReference) {
    return normalizeFollowUpQuery(`${anchor} ${simplified}`);
  }
  return simplified || normalized;
}

function buildComparisonExpansionQueries(query: string): string[] {
  const normalized = normalizeFollowUpQuery(query);
  const directVsMatch = normalized.match(/\bcompare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+)$/i);
  const betweenMatch = normalized.match(
    /\b(?:difference|differences) between\s+(.+?)\s+and\s+(.+)$/i,
  );
  const bareVsMatch = normalized.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i);
  const match = directVsMatch ?? betweenMatch ?? bareVsMatch;
  if (!match) {
    return [`${normalized} differences`, `${normalized} tradeoffs`];
  }

  const left = normalizeFollowUpQuery(match[1] ?? "");
  const right = normalizeFollowUpQuery(match[2] ?? "");
  if (!left || !right) {
    return [`${normalized} differences`, `${normalized} tradeoffs`];
  }

  return [`${left} overview`, `${right} overview`, `${left} vs ${right} tradeoffs`];
}

function buildMultiHopExpansionQueries(query: string): string[] {
  const normalized = normalizeFollowUpQuery(query);
  const rawClauses = normalized
    .split(/\b(?:and then|followed by|after that|before that|then|and)\b/i)
    .map((clause) => normalizeFollowUpQuery(clause))
    .filter(Boolean);

  const clauses =
    rawClauses.length >= 2
      ? rawClauses
      : normalized
          .split(/\b(?:lead to|leads to|caused?|because)\b/i)
          .map(normalizeFollowUpQuery)
          .filter(Boolean);

  if (clauses.length < 2) {
    return [`${normalized} cause`, `${normalized} consequence`];
  }

  const anchor = extractAnchorTerms(clauses[0] ?? "");
  const expansions = [clauses[0] ?? ""];
  for (const clause of clauses.slice(1, 3)) {
    expansions.push(simplifyClauseForSearch(clause, anchor));
  }
  return expansions;
}

export function buildExecutorPasses(
  request: MemorySearchExecutorRequest,
  classification: MemorySearchClassification,
): MemorySearchExecutorPlanPass[] {
  const passes: MemorySearchExecutorPlanPass[] = [
    { pass: 1, query: request.query, reason: "original query", variant: "original" },
  ];
  const currentStateSignal = hasActiveCriticalSignal(request.query);
  const allowAgentic =
    request.searchMode === "agentic" ||
    (request.searchMode === "auto" &&
      (classification !== "direct" || request.needExactEvidence || currentStateSignal));
  if (!allowAgentic || request.maxPasses <= 1) {
    return passes;
  }

  const expansionQueries: string[] = [];
  switch (classification) {
    case "family":
      expansionQueries.push(`${request.query} alternatives`);
      expansionQueries.push(`${request.query} related tools`);
      break;
    case "comparison":
      expansionQueries.push(...buildComparisonExpansionQueries(request.query));
      break;
    case "temporal":
      expansionQueries.push(`${request.query} exact evidence`);
      break;
    case "scoped":
      expansionQueries.push(`${request.query} exact match`);
      break;
    case "multi-hop":
      expansionQueries.push(...buildMultiHopExpansionQueries(request.query));
      break;
    case "direct":
      if (currentStateSignal) {
        expansionQueries.push(`${request.query} latest status`);
        if (request.needExactEvidence || request.searchMode === "agentic") {
          expansionQueries.push(`${request.query} exact evidence`);
        }
      } else if (request.needExactEvidence) {
        expansionQueries.push(`${request.query} exact evidence`);
      }
      break;
  }

  const deduped = uniqueQueries(expansionQueries);
  for (const query of deduped.slice(0, Math.max(0, request.maxPasses - 1))) {
    const decompositionVariant = classification === "multi-hop" || classification === "comparison";
    passes.push({
      pass: passes.length + 1,
      query,
      reason:
        classification === "family"
          ? "family expansion"
          : decompositionVariant
            ? `${classification} decomposition`
            : "agentic follow-up",
      variant: decompositionVariant ? "decomposition" : "family-expansion",
    });
  }

  return passes;
}

export function resultHasExactEvidence(result: MemorySearchResult): boolean {
  if (result.canonicalId?.trim()) {
    return true;
  }
  if (result.path.trim()) {
    return true;
  }
  return false;
}

function searchResultIdentity(result: MemorySearchResult): string {
  return result.canonicalId ?? `${result.path}:${result.startLine}:${result.endLine}`;
}

export function computeEvidenceCoverage(results: MemorySearchResult[]): EvidenceCoverage {
  if (results.length === 0) {
    return "none";
  }
  const exactCount = results.filter(resultHasExactEvidence).length;
  if (exactCount === results.length) {
    return "direct";
  }
  if (exactCount > 0) {
    return "partial";
  }
  return "indirect";
}

function hasFreshCurrentStateSupport(results: MemorySearchResult[], now = new Date()): boolean {
  return results.some((result) => {
    if (result.signals?.state === "invalidated" || result.signals?.state === "conflicted") {
      return false;
    }

    const trust = result.trust ?? computeResultTrust(result, now);
    if (trust.freshness < 0.58 || trust.score < 0.62) {
      return false;
    }

    if (hasOverdueReview(result, now) && trust.recency < 0.75) {
      return false;
    }

    return true;
  });
}

function buildClearContradictionSummary(): MemorySearchContradictionSummary {
  return {
    status: "clear",
    conflictedResults: 0,
    invalidatedResults: 0,
    lowTrustResults: 0,
    exactResolutionAvailable: false,
    topResultConflicted: false,
  };
}

function hasConflictSignal(result: MemorySearchResult, now = new Date()): boolean {
  if (result.signals?.state === "conflicted") {
    return true;
  }
  if (typeof result.signals?.conflictCount === "number" && result.signals.conflictCount > 0) {
    return true;
  }

  const trust = result.trust ?? computeResultTrust(result, now);
  return trust.contradiction < 0.62;
}

function hasExactConflictResolutionSupport(
  results: MemorySearchResult[],
  now = new Date(),
): boolean {
  return results.some((result) => {
    if (!resultHasExactEvidence(result)) {
      return false;
    }
    if (result.signals?.state === "invalidated" || result.signals?.state === "conflicted") {
      return false;
    }

    const trust = result.trust ?? computeResultTrust(result, now);
    if (trust.freshness < 0.58 || hasOverdueReview(result, now)) {
      return false;
    }

    return trust.contradiction >= 0.72 && trust.score >= 0.62;
  });
}

export function analyzeContradictionCorrection(params: {
  query: string;
  accepted: MemorySearchResult[];
  passCount: number;
  maxPasses: number;
  needExactEvidence?: boolean;
  now?: Date;
}): { needed: boolean; correction?: string; reason?: string } {
  if (params.passCount >= params.maxPasses) {
    return { needed: false };
  }
  if (!hasActiveCriticalSignal(params.query) && !params.needExactEvidence) {
    return { needed: false };
  }
  if (params.accepted.length === 0) {
    return { needed: false };
  }

  const leading = params.accepted.slice(0, Math.min(params.accepted.length, 3));
  if (!leading.some((result) => hasConflictSignal(result, params.now))) {
    return { needed: false };
  }
  if (hasExactConflictResolutionSupport(leading, params.now)) {
    return { needed: false };
  }

  return {
    needed: true,
    correction: "conflict-evidence-required",
    reason: "current-state results were conflicted or contradictory",
  };
}

export function summarizeContradictionState(
  results: MemorySearchResult[],
  now = new Date(),
): MemorySearchContradictionSummary {
  if (results.length === 0) {
    return buildClearContradictionSummary();
  }

  let conflictedResults = 0;
  let invalidatedResults = 0;
  let lowTrustResults = 0;

  for (const result of results) {
    if (result.signals?.state === "conflicted") {
      conflictedResults++;
    }
    if (result.signals?.state === "invalidated") {
      invalidatedResults++;
    }
    const trust = result.trust ?? computeResultTrust(result, now);
    if (trust.contradiction < 0.62) {
      lowTrustResults++;
    }
  }

  const exactResolutionAvailable = hasExactConflictResolutionSupport(results, now);
  const leading = results.slice(0, Math.min(results.length, 3));
  const topResultConflicted = hasConflictSignal(results[0], now);
  const unresolved =
    leading.some((result) => hasConflictSignal(result, now)) && !exactResolutionAvailable;
  const detected = conflictedResults > 0 || invalidatedResults > 0 || lowTrustResults > 0;

  return {
    status: !detected ? "clear" : unresolved ? "unresolved" : "detected",
    conflictedResults,
    invalidatedResults,
    lowTrustResults,
    exactResolutionAvailable,
    topResultConflicted,
  };
}

export function analyzeFreshnessCorrection(params: {
  query: string;
  accepted: MemorySearchResult[];
  passCount: number;
  maxPasses: number;
  now?: Date;
}): { needed: boolean; correction?: string; reason?: string } {
  if (params.passCount >= params.maxPasses) {
    return { needed: false };
  }
  if (!hasActiveCriticalSignal(params.query)) {
    return { needed: false };
  }
  if (params.accepted.length === 0) {
    return { needed: false };
  }
  if (hasFreshCurrentStateSupport(params.accepted, params.now)) {
    return { needed: false };
  }
  return {
    needed: true,
    correction: "freshness-rebalanced",
    reason: "current-state results were stale or weak",
  };
}

export function applyHardConstraintRejections(params: {
  results: MemorySearchResult[];
  request: MemorySearchRequest;
  timeRange?: MemorySearchExecutorTimeRange;
}): { accepted: MemorySearchResult[]; rejected: RejectedResultSummary[] } {
  const accepted: MemorySearchResult[] = [];
  const rejected: RejectedResultSummary[] = [];

  for (const result of params.results) {
    if (params.timeRange) {
      if (!(result.timestamp instanceof Date)) {
        rejected.push({
          canonicalId: result.canonicalId,
          path: result.path,
          source: result.source,
          reason: "missing timestamp for requested time range",
        });
        continue;
      }
      const ts = result.timestamp.getTime();
      if (ts < params.timeRange.start.getTime() || ts > params.timeRange.end.getTime()) {
        rejected.push({
          canonicalId: result.canonicalId,
          path: result.path,
          source: result.source,
          reason: "outside requested time range",
        });
        continue;
      }
    }
    if (params.request.needExactEvidence && !resultHasExactEvidence(result)) {
      rejected.push({
        canonicalId: result.canonicalId,
        path: result.path,
        source: result.source,
        reason: "missing exact evidence locator",
      });
      continue;
    }
    accepted.push(result);
  }

  return { accepted, rejected };
}

function shouldStopAfterPass(params: {
  classification: MemorySearchClassification;
  request: MemorySearchExecutorRequest;
  acceptedResults: MemorySearchResult[];
  pass: number;
  now?: Date;
}): boolean {
  const { acceptedResults, classification, request } = params;
  if (acceptedResults.length === 0) {
    return false;
  }

  const evidenceCoverage = computeEvidenceCoverage(acceptedResults);
  const freshnessSatisfied =
    !hasActiveCriticalSignal(request.query) ||
    hasFreshCurrentStateSupport(acceptedResults, params.now);
  const contradictionSatisfied = !analyzeContradictionCorrection({
    query: request.query,
    accepted: acceptedResults,
    passCount: params.pass,
    maxPasses: request.maxPasses,
    needExactEvidence: request.needExactEvidence,
    now: params.now,
  }).needed;

  if (classification === "family" || classification === "comparison") {
    return (
      contradictionSatisfied &&
      freshnessSatisfied &&
      acceptedResults.length >= Math.min(request.maxResults ?? 10, 3)
    );
  }

  if (classification === "multi-hop") {
    if (params.pass < Math.min(request.maxPasses, 2)) {
      return (
        contradictionSatisfied &&
        freshnessSatisfied &&
        acceptedResults.length >= Math.min(request.maxResults ?? 10, 2) &&
        evidenceCoverage !== "none"
      );
    }
    return contradictionSatisfied && freshnessSatisfied && evidenceCoverage !== "none";
  }

  if (request.needExactEvidence) {
    return (
      contradictionSatisfied &&
      freshnessSatisfied &&
      (evidenceCoverage === "direct" || evidenceCoverage === "partial")
    );
  }

  return contradictionSatisfied && freshnessSatisfied;
}

export function canUseLegacyFallback(request: MemorySearchRequest): boolean {
  return !(
    request.needExactEvidence ||
    request.timeRange ||
    request.conversationScope ||
    request.structuredScope ||
    request.referenceScope ||
    request.proceduralScope
  );
}

export function requestHasHardConstraints(request: MemorySearchRequest): boolean {
  return !canUseLegacyFallback(request);
}

export function buildConstraintSummaries(request: MemorySearchRequest): string[] {
  const applied: string[] = [];
  if (request.timeRange) {
    if (request.timeRange.preset) {
      applied.push(`timeRange:${request.timeRange.preset}`);
    } else if (request.timeRange.start && request.timeRange.end) {
      applied.push(`timeRange:${request.timeRange.start}..${request.timeRange.end}`);
    }
  }
  if (request.needExactEvidence) {
    applied.push("needExactEvidence");
  }
  if (request.conversationScope?.sessionKey) {
    applied.push(`conversationScope.sessionKey:${request.conversationScope.sessionKey}`);
  }
  if (request.structuredScope?.type) {
    applied.push(`structuredScope.type:${request.structuredScope.type}`);
  }
  if (request.referenceScope?.category) {
    applied.push(`referenceScope.category:${request.referenceScope.category}`);
  }
  if (request.referenceScope?.source) {
    applied.push(`referenceScope.source:${request.referenceScope.source}`);
  }
  if (request.proceduralScope?.state) {
    applied.push(`proceduralScope.state:${request.proceduralScope.state}`);
  }
  return applied;
}

export function mergeMetadata(params: {
  request: MemorySearchExecutorRequest;
  classification: MemorySearchClassification;
  passes: Array<
    MemorySearchPass & {
      metadata: Pick<
        MemorySearchMetadata,
        "pathsExecuted" | "resultsByPath" | "queryRewritten" | "reranked" | "trustApplied" | "plan"
      >;
    }
  >;
  resultsRejected: RejectedResultSummary[];
  results: MemorySearchResult[];
  noDirectEvidenceReason?: string;
  constraintRelaxations?: Array<{ constraint: string; action: string }>;
  mmrApplied?: boolean;
  mmrLambda?: number;
}): MemorySearchMetadata {
  const pathsExecuted = Array.from(
    new Set(params.passes.flatMap((pass) => pass.metadata.pathsExecuted)),
  );
  const resultsByPath = params.passes.reduce<Record<string, number>>((acc, pass) => {
    for (const [path, count] of Object.entries(pass.metadata.resultsByPath)) {
      acc[path] = (acc[path] ?? 0) + count;
    }
    return acc;
  }, {});
  const contradictionSummary = summarizeContradictionState(params.results);
  const abstained = params.results.length === 0;
  const abstainReason = abstained
    ? (params.noDirectEvidenceReason ?? "No memory evidence satisfied the request.")
    : undefined;
  return {
    mode: params.request.searchMode,
    classification: params.classification,
    sourceOrder: params.request.sourcePreference,
    passes: params.passes.map(({ metadata: _metadata, ...pass }) => pass),
    queriesTried: params.passes.map((pass) => pass.query),
    constraintsApplied: buildConstraintSummaries(params.request),
    resultsRejected: params.resultsRejected,
    evidenceCoverage: computeEvidenceCoverage(params.results),
    pathsExecuted,
    resultsByPath,
    queryRewritten: params.passes.some((pass) => pass.metadata.queryRewritten),
    reranked: params.passes.some((pass) => pass.metadata.reranked),
    trustApplied: params.passes.some((pass) => pass.metadata.trustApplied === true),
    contradictionSummary,
    abstained,
    ...(abstainReason ? { abstainReason } : {}),
    ...(params.noDirectEvidenceReason
      ? { noDirectEvidenceReason: params.noDirectEvidenceReason }
      : {}),
    ...(params.constraintRelaxations?.length
      ? { constraintRelaxations: params.constraintRelaxations }
      : {}),
    ...(params.mmrApplied != null ? { mmrApplied: params.mmrApplied } : {}),
    ...(params.mmrLambda != null ? { mmrLambda: params.mmrLambda } : {}),
    ...(params.request.returnPlan && params.passes[0]?.metadata.plan
      ? { plan: params.passes[0].metadata.plan }
      : {}),
  };
}

export function buildNoDirectEvidenceResponse(params: {
  request: MemorySearchExecutorRequest;
  classification: MemorySearchClassification;
  passes: Array<
    MemorySearchPass & {
      metadata: Pick<
        MemorySearchMetadata,
        "pathsExecuted" | "resultsByPath" | "queryRewritten" | "reranked" | "trustApplied" | "plan"
      >;
    }
  >;
  resultsRejected: RejectedResultSummary[];
  reason: string;
}): MemorySearchResponse {
  return {
    results: [],
    metadata: mergeMetadata({
      request: params.request,
      classification: params.classification,
      passes: params.passes,
      resultsRejected: params.resultsRejected,
      results: [],
      noDirectEvidenceReason: params.reason,
    }),
  };
}

// ---------------------------------------------------------------------------
// CRAG-style corrective retrieval analysis (pure function, no LLM)
// ---------------------------------------------------------------------------

export function analyzeCorrectionNeeded(params: {
  evidenceCoverage: EvidenceCoverage;
  rejected: RejectedResultSummary[];
  passCount: number;
  maxPasses: number;
}): { needed: boolean; correction?: string; reason?: string } {
  if (params.passCount >= params.maxPasses) {
    return { needed: false };
  }
  if (params.evidenceCoverage !== "none" && params.evidenceCoverage !== "indirect") {
    return { needed: false };
  }
  if (params.rejected.length === 0) {
    return { needed: false };
  }
  const reasonCounts = new Map<string, number>();
  for (const r of params.rejected) {
    reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
  }
  let dominantReason = "";
  let maxCount = 0;
  for (const [reason, count] of reasonCounts) {
    if (count > maxCount) {
      dominantReason = reason;
      maxCount = count;
    }
  }
  if (dominantReason === "outside requested time range") {
    return { needed: true, correction: "time-range-widened-2x", reason: dominantReason };
  }
  if (dominantReason === "missing exact evidence locator") {
    return { needed: true, correction: "hybrid-evidence-relaxed", reason: dominantReason };
  }
  if (dominantReason === "missing timestamp for requested time range") {
    return { needed: true, correction: "time-range-widened-2x", reason: dominantReason };
  }
  return { needed: false };
}

// ---------------------------------------------------------------------------
// Constraint relaxation fallback (pure function)
// ---------------------------------------------------------------------------

export function identifyRelaxableConstraint(
  rejected: RejectedResultSummary[],
): { constraint: string; action: string } | null {
  if (rejected.length === 0) {
    return null;
  }
  const reasonCounts = new Map<string, number>();
  for (const r of rejected) {
    reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
  }
  let dominantReason = "";
  let maxCount = 0;
  for (const [reason, count] of reasonCounts) {
    if (count > maxCount) {
      dominantReason = reason;
      maxCount = count;
    }
  }
  if (
    dominantReason === "outside requested time range" ||
    dominantReason === "missing timestamp for requested time range"
  ) {
    return { constraint: "timeRange", action: "removed-time-range" };
  }
  if (dominantReason === "missing exact evidence locator") {
    return { constraint: "needExactEvidence", action: "disabled-exact-evidence" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MMR diversity scoring (pure function, uses Jaccard similarity on snippets)
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function applyMMRReranking(params: {
  results: MemorySearchResult[];
  classification: MemorySearchClassification;
}): { results: MemorySearchResult[]; mmrApplied: boolean; mmrLambda: number } {
  const lambdaByClassification: Record<MemorySearchClassification, number> = {
    family: 0.3,
    comparison: 0.4,
    direct: 0.7,
    temporal: 0.7,
    scoped: 0.7,
    "multi-hop": 0.7,
  };
  const lambda = lambdaByClassification[params.classification] ?? 0.5;

  if (params.results.length < 3) {
    return { results: params.results, mmrApplied: false, mmrLambda: lambda };
  }

  const scores = params.results.map((r) => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const scoreRange = maxScore - minScore || 1;

  const tokenSets = params.results.map((r) => tokenize(r.snippet));

  const selected: MemorySearchResult[] = [params.results[0]];
  const selectedTokens: Set<string>[] = [tokenSets[0]];
  const remaining = new Set(params.results.slice(1).map((_, i) => i + 1));

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      const normalizedRelevance = (params.results[idx].score - minScore) / scoreRange;
      let maxSimilarity = 0;
      for (const selTokens of selectedTokens) {
        const sim = jaccardSimilarity(tokenSets[idx], selTokens);
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
        }
      }
      const mmrScore = lambda * normalizedRelevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(params.results[bestIdx]);
      selectedTokens.push(tokenSets[bestIdx]);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }

  return { results: selected, mmrApplied: true, mmrLambda: lambda };
}

export async function executeMongoSearchPlan(params: {
  request: MemorySearchRequest;
  availablePaths: Set<
    | "active-critical"
    | "structured"
    | "raw-window"
    | "graph"
    | "hybrid"
    | "kb"
    | "episodic"
    | "procedural"
  >;
  executePass: (input: {
    pass: number;
    query: string;
    availablePaths: Set<
      | "active-critical"
      | "structured"
      | "raw-window"
      | "graph"
      | "hybrid"
      | "kb"
      | "episodic"
      | "procedural"
    >;
    sourcePreference?: MemorySearchSourcePreference[];
    timeRange?: MemorySearchExecutorTimeRange;
  }) => Promise<{
    results: MemorySearchResult[];
    metadata: {
      plan: {
        paths: string[];
        confidence: "high" | "medium" | "low";
        reasoning: string;
        constraints?: Record<string, unknown>;
      };
      pathsExecuted: string[];
      resultsByPath: Record<string, number>;
      reranked?: boolean;
      queryRewritten?: boolean;
      trustApplied?: boolean;
    };
  }>;
}): Promise<MemorySearchResponse> {
  const normalized = normalizeMemorySearchRequest(params.request);
  const classification = classifyExecutorSearch(normalized);
  const timeRange = resolveExecutorTimeRange(normalized);
  const now = new Date();
  const passPlans = buildExecutorPasses(normalized, classification);
  const passes: Array<
    MemorySearchPass & {
      metadata: Pick<
        MemorySearchMetadata,
        "pathsExecuted" | "resultsByPath" | "queryRewritten" | "reranked" | "trustApplied" | "plan"
      >;
    }
  > = [];
  const allRejected: RejectedResultSummary[] = [];
  const acceptedById = new Map<string, MemorySearchResult>();

  for (const passPlan of passPlans) {
    const passPaths = selectPassPaths({
      availablePaths: params.availablePaths,
      sourcePreference: normalized.sourcePreference,
      pass: passPlan.pass,
      ...(timeRange ? { timeRange } : {}),
    });
    const executed = await params.executePass({
      pass: passPlan.pass,
      query: passPlan.query,
      availablePaths: passPaths,
      sourcePreference: normalized.sourcePreference,
      ...(timeRange ? { timeRange } : {}),
    });
    const filtered = applyHardConstraintRejections({
      results: executed.results,
      request: normalized,
      ...(timeRange ? { timeRange } : {}),
    });
    allRejected.push(...filtered.rejected);
    for (const result of filtered.accepted) {
      acceptedById.set(searchResultIdentity(result), result);
    }
    passes.push({
      pass: passPlan.pass,
      query: passPlan.query,
      reason: passPlan.reason,
      pathsExecuted: executed.metadata.pathsExecuted,
      resultCount: filtered.accepted.length,
      queryRewritten: executed.metadata.queryRewritten === true,
      reranked: executed.metadata.reranked === true,
      metadata: {
        pathsExecuted: executed.metadata.pathsExecuted,
        resultsByPath: executed.metadata.resultsByPath,
        queryRewritten: executed.metadata.queryRewritten === true,
        reranked: executed.metadata.reranked === true,
        trustApplied: executed.metadata.trustApplied === true,
        plan: {
          paths: executed.metadata.plan.paths,
          confidence: executed.metadata.plan.confidence,
          reasoning: executed.metadata.plan.reasoning,
          ...(executed.metadata.plan.constraints
            ? { constraints: executed.metadata.plan.constraints }
            : {}),
        },
      },
    });

    const acceptedResults = Array.from(acceptedById.values());
    if (
      shouldStopAfterPass({
        classification,
        request: normalized,
        acceptedResults,
        pass: passPlan.pass,
        now,
      })
    ) {
      break;
    }
  }

  let acceptedResults = Array.from(acceptedById.values());

  // --- CRAG corrective retrieval: if coverage is poor, try a corrective pass ---
  const contradictionCorrection = analyzeContradictionCorrection({
    query: normalized.query,
    accepted: acceptedResults,
    passCount: passes.length,
    maxPasses: normalized.maxPasses,
    needExactEvidence: normalized.needExactEvidence,
    now,
  });
  const freshnessCorrection = contradictionCorrection.needed
    ? { needed: false as const }
    : analyzeFreshnessCorrection({
        query: normalized.query,
        accepted: acceptedResults,
        passCount: passes.length,
        maxPasses: normalized.maxPasses,
        now,
      });
  const correction = contradictionCorrection.needed
    ? contradictionCorrection
    : freshnessCorrection.needed
      ? freshnessCorrection
      : analyzeCorrectionNeeded({
          evidenceCoverage: computeEvidenceCoverage(acceptedResults),
          rejected: allRejected,
          passCount: passes.length,
          maxPasses: normalized.maxPasses,
        });
  if (correction.needed && correction.correction) {
    let correctiveTimeRange = timeRange;
    let correctiveRequest = normalized;
    let correctiveSourcePreference = normalized.sourcePreference;
    if (correction.correction === "time-range-widened-2x" && timeRange) {
      const duration = timeRange.end.getTime() - timeRange.start.getTime();
      correctiveTimeRange = {
        start: new Date(timeRange.start.getTime() - duration),
        end: new Date(timeRange.end.getTime() + duration),
      };
    }
    if (correction.correction === "hybrid-evidence-relaxed") {
      correctiveRequest = { ...normalized, needExactEvidence: false };
    } else if (correction.correction === "conflict-evidence-required") {
      correctiveRequest = { ...normalized, needExactEvidence: true };
      // Conflict recovery should prioritize fresh canonical conversation evidence
      // and graph relations ahead of already-conflicted structured memory.
      correctiveSourcePreference = ["conversation", "graph", "structured"];
    }
    const correctivePaths =
      correction.correction === "hybrid-evidence-relaxed"
        ? new Set(["hybrid" as const, ...params.availablePaths])
        : correction.correction === "freshness-rebalanced"
          ? (() => {
              const focused = new Set(
                (
                  ["active-critical", "structured", "raw-window", "hybrid"] as RetrievalPath[]
                ).filter((path) => params.availablePaths.has(path)),
              );
              return focused.size > 0 ? focused : params.availablePaths;
            })()
          : correction.correction === "conflict-evidence-required"
            ? (() => {
                const focused = new Set(
                  (
                    [
                      "active-critical",
                      "structured",
                      "raw-window",
                      "hybrid",
                      "graph",
                    ] as RetrievalPath[]
                  ).filter((path) => params.availablePaths.has(path)),
                );
                return focused.size > 0 ? focused : params.availablePaths;
              })()
            : params.availablePaths;
    if (correction.correction === "freshness-rebalanced") {
      // Freshness recovery should favor recent conversation evidence before
      // re-reading the same structured lane that already looked stale.
      correctiveSourcePreference = ["conversation", "structured"];
    }
    const corrExec = await params.executePass({
      pass: passes.length + 1,
      query: normalized.query,
      availablePaths: correctivePaths,
      sourcePreference: correctiveSourcePreference,
      ...(correctiveTimeRange ? { timeRange: correctiveTimeRange } : {}),
    });
    const corrFiltered = applyHardConstraintRejections({
      results: corrExec.results,
      request: correctiveRequest,
      ...(correctiveTimeRange ? { timeRange: correctiveTimeRange } : {}),
    });
    allRejected.push(...corrFiltered.rejected);
    for (const result of corrFiltered.accepted) {
      acceptedById.set(searchResultIdentity(result), result);
    }
    passes.push({
      pass: passes.length + 1,
      query: normalized.query,
      reason: `corrective: ${correction.correction}`,
      pathsExecuted: corrExec.metadata.pathsExecuted,
      resultCount: corrFiltered.accepted.length,
      queryRewritten: corrExec.metadata.queryRewritten === true,
      reranked: corrExec.metadata.reranked === true,
      correctionApplied: correction.correction,
      metadata: {
        pathsExecuted: corrExec.metadata.pathsExecuted,
        resultsByPath: corrExec.metadata.resultsByPath,
        queryRewritten: corrExec.metadata.queryRewritten === true,
        reranked: corrExec.metadata.reranked === true,
        trustApplied: corrExec.metadata.trustApplied === true,
        plan: corrExec.metadata.plan,
      },
    });
    acceptedResults = Array.from(acceptedById.values());
  }

  // --- Constraint relaxation: if still empty after all passes, relax the dominant constraint ---
  let constraintRelaxations: Array<{ constraint: string; action: string }> | undefined;
  if (acceptedResults.length === 0 && allRejected.length > 0) {
    const relaxation = identifyRelaxableConstraint(allRejected);
    if (relaxation) {
      let relaxedRequest = normalized;
      let relaxedTimeRange = timeRange;
      if (relaxation.action === "removed-time-range") {
        relaxedTimeRange = undefined;
      }
      if (relaxation.action === "disabled-exact-evidence") {
        relaxedRequest = { ...normalized, needExactEvidence: false };
      }
      const relaxExec = await params.executePass({
        pass: passes.length + 1,
        query: normalized.query,
        availablePaths: params.availablePaths,
        ...(relaxedTimeRange ? { timeRange: relaxedTimeRange } : {}),
      });
      const relaxFiltered = applyHardConstraintRejections({
        results: relaxExec.results,
        request: relaxedRequest,
        ...(relaxedTimeRange ? { timeRange: relaxedTimeRange } : {}),
      });
      for (const result of relaxFiltered.accepted) {
        acceptedById.set(searchResultIdentity(result), result);
      }
      passes.push({
        pass: passes.length + 1,
        query: normalized.query,
        reason: `relaxation: ${relaxation.action}`,
        pathsExecuted: relaxExec.metadata.pathsExecuted,
        resultCount: relaxFiltered.accepted.length,
        queryRewritten: relaxExec.metadata.queryRewritten === true,
        reranked: relaxExec.metadata.reranked === true,
        correctionApplied: `relaxation:${relaxation.action}`,
        metadata: {
          pathsExecuted: relaxExec.metadata.pathsExecuted,
          resultsByPath: relaxExec.metadata.resultsByPath,
          queryRewritten: relaxExec.metadata.queryRewritten === true,
          reranked: relaxExec.metadata.reranked === true,
          trustApplied: relaxExec.metadata.trustApplied === true,
          plan: relaxExec.metadata.plan,
        },
      });
      constraintRelaxations = [relaxation];
      acceptedResults = Array.from(acceptedById.values());
    }
  }

  if (normalized.needExactEvidence && acceptedResults.length === 0) {
    return buildNoDirectEvidenceResponse({
      request: normalized,
      classification,
      passes,
      resultsRejected: allRejected,
      reason: "No exact-evidence results survived the active constraints.",
    });
  }

  const rerankedResults = applyTrustAwareReranking(acceptedResults, { now });

  // --- MMR diversity scoring: reorder results for content diversity ---
  const mmr = applyMMRReranking({ results: rerankedResults, classification });

  return {
    results: mmr.results,
    metadata: mergeMetadata({
      request: normalized,
      classification,
      passes,
      resultsRejected: allRejected,
      results: mmr.results,
      constraintRelaxations,
      mmrApplied: mmr.mmrApplied,
      mmrLambda: mmr.mmrLambda,
    }),
  };
}
