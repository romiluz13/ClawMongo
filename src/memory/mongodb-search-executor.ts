import { classifyRetrievalQuery, resolveTimeRangePreset } from "./mongodb-retrieval-planner.js";
import type { MemorySearchResult } from "./types.js";
import type {
  EvidenceCoverage,
  MemorySearchClassification,
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

type RetrievalPath =
  | "active-critical"
  | "structured"
  | "raw-window"
  | "graph"
  | "hybrid"
  | "kb"
  | "episodic"
  | "procedural";

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
  const effectiveAllowed = scopedAllowed;
  const preferredSource =
    params.sourcePreference[Math.min(params.pass - 1, params.sourcePreference.length - 1)];
  const preferredPaths = sourcePreferencePaths(preferredSource).filter((path) =>
    effectiveAllowed.has(path),
  );
  if (preferredPaths.length === 0 || params.pass > params.sourcePreference.length) {
    return effectiveAllowed;
  }
  return new Set(preferredPaths);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObject(entry)]),
  );
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
    sourcePreference: request.sourcePreference ?? [
      "conversation",
      "structured",
      "procedural",
      "reference",
      "episodic",
      "graph",
    ],
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

export function buildExecutorPasses(
  request: MemorySearchExecutorRequest,
  classification: MemorySearchClassification,
): MemorySearchExecutorPlanPass[] {
  const passes: MemorySearchExecutorPlanPass[] = [
    { pass: 1, query: request.query, reason: "original query", variant: "original" },
  ];
  const allowAgentic =
    request.searchMode === "agentic" ||
    (request.searchMode === "auto" && classification !== "direct");
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
      expansionQueries.push(`${request.query} differences`);
      expansionQueries.push(`${request.query} tradeoffs`);
      break;
    case "temporal":
      expansionQueries.push(`${request.query} exact evidence`);
      break;
    case "scoped":
      expansionQueries.push(`${request.query} exact match`);
      break;
    case "multi-hop":
      expansionQueries.push(`${request.query} cause`);
      expansionQueries.push(`${request.query} consequence`);
      break;
    case "direct":
      if (request.needExactEvidence) {
        expansionQueries.push(`${request.query} exact evidence`);
      }
      break;
  }

  const deduped = uniqueQueries(expansionQueries);
  for (const query of deduped.slice(0, Math.max(0, request.maxPasses - 1))) {
    passes.push({
      pass: passes.length + 1,
      query,
      reason: classification === "family" ? "family expansion" : "agentic follow-up",
      variant: classification === "multi-hop" ? "decomposition" : "family-expansion",
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
        "pathsExecuted" | "resultsByPath" | "queryRewritten" | "reranked" | "plan"
      >;
    }
  >;
  resultsRejected: RejectedResultSummary[];
  results: MemorySearchResult[];
  noDirectEvidenceReason?: string;
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
    ...(params.noDirectEvidenceReason
      ? { noDirectEvidenceReason: params.noDirectEvidenceReason }
      : {}),
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
        "pathsExecuted" | "resultsByPath" | "queryRewritten" | "reranked" | "plan"
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
    };
  }>;
}): Promise<MemorySearchResponse> {
  const normalized = normalizeMemorySearchRequest(params.request);
  const classification = classifyExecutorSearch(normalized);
  const timeRange = resolveExecutorTimeRange(normalized);
  const passPlans = buildExecutorPasses(normalized, classification);
  const passes: Array<
    MemorySearchPass & {
      metadata: Pick<
        MemorySearchMetadata,
        "pathsExecuted" | "resultsByPath" | "queryRewritten" | "reranked" | "plan"
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
    const evidenceCoverage = computeEvidenceCoverage(acceptedResults);
    const shouldStop =
      acceptedResults.length > 0 &&
      (classification === "direct"
        ? !normalized.needExactEvidence ||
          evidenceCoverage === "direct" ||
          evidenceCoverage === "partial"
        : classification === "family" || classification === "comparison"
          ? acceptedResults.length >= Math.min(normalized.maxResults ?? 10, 3)
          : !normalized.needExactEvidence ||
            evidenceCoverage === "direct" ||
            evidenceCoverage === "partial");
    if (shouldStop) {
      break;
    }
  }

  const acceptedResults = Array.from(acceptedById.values());

  if (normalized.needExactEvidence && acceptedResults.length === 0) {
    return buildNoDirectEvidenceResponse({
      request: normalized,
      classification,
      passes,
      resultsRejected: allRejected,
      reason: "No exact-evidence results survived the active constraints.",
    });
  }

  return {
    results: acceptedResults,
    metadata: mergeMetadata({
      request: normalized,
      classification,
      passes,
      resultsRejected: allRejected,
      results: acceptedResults,
    }),
  };
}
