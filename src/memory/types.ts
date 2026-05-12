import type { MemoryScope } from "../config/types.memory.js";
import type { StructuredMemoryEntry } from "./mongodb-structured-memory.js";

// "memory" | "sessions" are legacy upstream source values preserved for
// extensions/memory-core dead-code compilation. Runtime code uses
// "reference" | "conversation" | "structured".
export type MemorySource = "reference" | "conversation" | "structured" | "memory" | "sessions";
export type LegacyMemorySource = "memory" | "sessions" | "kb" | "structured";
export type InternalMemoryStoredSource = LegacyMemorySource | "conversation";
export type MemorySearchMode = "auto" | "direct" | "agentic";
export type MemorySearchSourcePreference = MemorySource | "procedural" | "episodic" | "graph";
export type MemorySearchClassification =
  | "direct"
  | "family"
  | "comparison"
  | "temporal"
  | "scoped"
  | "multi-hop";
export type EvidenceCoverage = "direct" | "partial" | "indirect" | "none";
export type MemorySearchTimeRangePreset =
  | "today"
  | "yesterday"
  | "last-24h"
  | "last-7d"
  | "this-week"
  | "last-30d"
  | "this-month";

export type MemoryLifecycleState = "active" | "invalidated" | "conflicted";
export type MemoryLifecycleSalience = "critical" | "high" | "normal" | "low";
export type MemoryLifecycleTemporalScope = "ongoing" | "bounded" | "permanent" | "transient";

export type MemorySearchResultSignals = {
  state?: MemoryLifecycleState;
  salience?: MemoryLifecycleSalience;
  temporalScope?: MemoryLifecycleTemporalScope;
  confidence?: number;
  sourceReliability?: number;
  reinforcementCount?: number;
  sourceEventCount?: number;
  reviewAt?: Date;
  lastConfirmedAt?: Date;
  validFrom?: Date;
  validTo?: Date;
  updatedAt?: Date;
  conflictCount?: number;
};

export type MemorySearchTrust = {
  score: number;
  freshness: number;
  provenance: number;
  exactness: number;
  contradiction: number;
  recency: number;
};

export type MemorySearchTrustBand = "high" | "medium" | "low";

export type MemorySearchTrustSummary = {
  topScore: number | null;
  averageScore: number | null;
  topBand: MemorySearchTrustBand | null;
  distribution: Record<MemorySearchTrustBand, number>;
  contradictionCount: number;
  staleCount: number;
  exactCount: number;
  sourceDiversity: "single" | "multi" | "none";
};

export type MemorySearchContradictionStatus = "clear" | "detected" | "unresolved";

export type MemorySearchContradictionSummary = {
  status: MemorySearchContradictionStatus;
  conflictedResults: number;
  invalidatedResults: number;
  lowTrustResults: number;
  exactResolutionAvailable: boolean;
  topResultConflicted: boolean;
};

export type MemorySearchResult = {
  path: string;
  filePath?: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  sourceType?: MemorySource;
  citation?: string;
  canonicalId?: string;
  sessionId?: string; // session the chunk belongs to (for contiguous merge / context expansion)
  timestamp?: Date; // event timestamp (for ordering in merge/expansion)
  scope?: MemoryScope;
  scopeRef?: string;
  state?: string;
  provenance?: Record<string, unknown>;
  sourceEventIds?: string[];
  sourceReliability?: number;
  reinforcementCount?: number;
  validFrom?: Date;
  validTo?: Date;
  reviewAt?: Date;
  lastConfirmedAt?: Date;
  signals?: MemorySearchResultSignals;
  trust?: MemorySearchTrust;
};

export type MemorySearchTimeRange = {
  preset?: MemorySearchTimeRangePreset;
  start?: string;
  end?: string;
};

export type MemoryConversationScope = {
  sessionKey?: string;
};

export type MemoryStructuredScope = {
  type?: string;
  state?: string | string[];
  salience?: string[];
};

export type MemoryReferenceScope = {
  source?: string;
  category?: string;
  tags?: string[];
};

export type MemoryProceduralScope = {
  state?: string;
  intentTags?: string[];
};

export type MemorySearchRequest = {
  query: string;
  maxResults?: number;
  minScore?: number;
  searchMode?: MemorySearchMode;
  sourcePreference?: MemorySearchSourcePreference[];
  timeRange?: MemorySearchTimeRange;
  needExactEvidence?: boolean;
  maxPasses?: number;
  returnPlan?: boolean;
  conversationScope?: MemoryConversationScope;
  structuredScope?: MemoryStructuredScope;
  referenceScope?: MemoryReferenceScope;
  proceduralScope?: MemoryProceduralScope;
};

export type RejectedResultSummary = {
  canonicalId?: string;
  path?: string;
  source?: MemorySearchSourcePreference;
  reason: string;
};

export type MemorySearchPass = {
  pass: number;
  query: string;
  reason: string;
  pathsExecuted: string[];
  resultCount: number;
  queryRewritten: boolean;
  reranked: boolean;
  correctionApplied?: string;
};

export type MemorySearchMetadata = {
  mode: MemorySearchMode;
  classification: MemorySearchClassification;
  sourceOrder: MemorySearchSourcePreference[];
  passes: MemorySearchPass[];
  queriesTried: string[];
  constraintsApplied: string[];
  resultsRejected: RejectedResultSummary[];
  evidenceCoverage: EvidenceCoverage;
  pathsExecuted: string[];
  resultsByPath: Record<string, number>;
  queryRewritten: boolean;
  reranked: boolean;
  trustApplied?: boolean;
  trustSummary?: MemorySearchTrustSummary;
  contradictionSummary?: MemorySearchContradictionSummary;
  abstained?: boolean;
  abstainReason?: string;
  noDirectEvidenceReason?: string;
  constraintRelaxations?: Array<{ constraint: string; action: string }>;
  mmrApplied?: boolean;
  mmrLambda?: number;
  plan?: {
    paths: string[];
    confidence: "high" | "medium" | "low";
    reasoning: string;
  };
};

export type MemorySearchResponse = {
  results: MemorySearchResult[];
  metadata: MemorySearchMetadata;
};

export type MemoryDiscoveryProjectionKind =
  | "entity-brief"
  | "topic-brief"
  | "what-changed"
  | "contradiction-report";

export type MemoryDiscoveryProjectionSource =
  | "graph"
  | "structured"
  | "procedural"
  | "episodic"
  | "conversation";

export type MemoryDiscoveryProjectionEvidence = {
  title: string;
  summary: string;
  path: string;
  source: MemoryDiscoveryProjectionSource;
  canonicalId?: string;
  timestamp?: Date;
  scope?: MemoryScope;
  scopeRef?: string;
  sourceEventIds?: string[];
};

export type MemoryDiscoveryProjectionSection = {
  title: string;
  summary: string;
  evidence: MemoryDiscoveryProjectionEvidence[];
};

export type MemoryDiscoveryProjectionMetadata = {
  partial: boolean;
  evidenceCount: number;
  sourceCounts: Record<string, number>;
  timeRange?: {
    label: string;
    start: Date;
    end: Date;
  };
};

export type MemoryDiscoveryProjection = {
  kind: MemoryDiscoveryProjectionKind;
  query?: string;
  title: string;
  summary: string;
  scope: MemoryScope;
  scopeRef: string;
  sections: MemoryDiscoveryProjectionSection[];
  metadata: MemoryDiscoveryProjectionMetadata;
  builtAt: Date;
};

export type MemoryDiscoveryProjectionRequest = {
  kind: MemoryDiscoveryProjectionKind;
  query?: string;
  scope?: MemoryScope;
  scopeRef?: string;
  maxItems?: number;
  timeRange?: MemorySearchTimeRange;
};

export type MemoryActiveSlateKind =
  | "active-critical"
  | "procedure"
  | "decision"
  | "current-state"
  | "recent-anchor";

export type MemoryActiveSlateSource = "structured" | "procedural" | "conversation";

export type MemoryActiveSlateItem = {
  kind: MemoryActiveSlateKind;
  source: MemoryActiveSlateSource;
  title: string;
  summary: string;
  path: string;
  canonicalId?: string;
  timestamp?: Date;
  scope?: MemoryScope;
  scopeRef?: string;
  state?: string;
  salience?: string;
  provenance?: Record<string, unknown>;
  sourceEventIds?: string[];
};

export type MemoryActiveSlateMetadata = {
  maxItems: number;
  truncated: boolean;
  partial: boolean;
  countsByKind: Record<string, number>;
  sourceCounts: Record<string, number>;
};

export type MemoryActiveSlate = {
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
  items: MemoryActiveSlateItem[];
  metadata: MemoryActiveSlateMetadata;
  hydratedAt: Date;
};

export type MemoryContextBundleSectionKind =
  | "active-slate"
  | "query-evidence"
  | "summary"
  | "recent-events"
  | "discovery-projection"
  | "profile";

export type MemoryContextBundleSectionItem = {
  title: string;
  summary: string;
  path?: string;
  source?: string;
  canonicalId?: string;
  timestamp?: Date;
  scope?: MemoryScope;
  scopeRef?: string;
  sourceEventIds?: string[];
  trust?: MemorySearchTrust;
  metadata?: Record<string, unknown>;
};

export type MemoryContextBundleSection = {
  kind: MemoryContextBundleSectionKind;
  title: string;
  summary?: string;
  items: MemoryContextBundleSectionItem[];
  estimatedTokens: number;
  truncated: boolean;
  partial: boolean;
};

export type MemoryContextBundleMetadata = {
  tokenBudget: number;
  estimatedTokensUsed: number;
  partial: boolean;
  truncated: boolean;
  pathsExecuted: string[];
  trustSummary?: MemorySearchTrustSummary;
  sectionsIncluded: MemoryContextBundleSectionKind[];
};

export type MemoryContextBundle = {
  agentId: string;
  query?: string;
  scope: MemoryScope;
  scopeRef: string;
  sessionId?: string;
  rendered: string;
  sections: MemoryContextBundleSection[];
  metadata: MemoryContextBundleMetadata;
  builtAt: Date;
};

export type MemoryContextBundleRequest = {
  query?: string;
  scope?: MemoryScope;
  scopeRef?: string;
  sessionId?: string;
  tokenBudget?: number;
  maxActiveItems?: number;
  maxEvidenceItems?: number;
  maxRecentEvents?: number;
  includeDiscoveryProjection?: boolean;
  discoveryKind?: MemoryDiscoveryProjectionKind;
  includeProfile?: boolean;
  timeRange?: MemorySearchTimeRange;
};

export type MemoryReadResult = {
  text: string;
  path: string;
  locator?: string;
  source?: MemorySource;
  sourceType?: MemorySource;
  title?: string;
  key?: string;
  type?: string;
  error?: string;
  disabled?: boolean;
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  backend: "mongodb" | "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  /** SQLite store path — dead code in ClawMongo. */
  dbPath?: string;
  /** Extra memory paths — dead code in ClawMongo. */
  extraPaths?: string[];
  /** Fallback provider — dead code in ClawMongo. */
  fallback?: string | { from: string; reason: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    loadError?: string;
    dims?: number;
    extensionPath?: string;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Reasoning Chain types (Phase 1 — Honcho steal)
// ---------------------------------------------------------------------------

export type ReasoningChainNodeType = "event" | "fact" | "gap";

export type ReasoningChainNode = {
  type: ReasoningChainNodeType;
  id: string;
  collection: string;
  body?: string;
  role?: string;
  timestamp?: Date;
  depth: number;
  reason?: string; // for gap nodes: "deleted" | "missing_sourceEventIds"
};

export type ReasoningChain = {
  factId: string;
  collection: string;
  nodes: ReasoningChainNode[];
  chainComplete: boolean;
  maxDepthReached: boolean;
  agentId: string;
};

export type ReasoningChainOptions = {
  maxDepth?: number; // default 10, clamped >= 0
};

// ---------------------------------------------------------------------------
// Novelty Detection types (Phase 2 — Honcho steal)
// ---------------------------------------------------------------------------

export type NoveltyEvent = {
  eventId: string;
  body: string;
  noveltyScore: number; // 0-1, higher = more novel
  timestamp: Date;
  role: string;
  nearestNeighborDistance: number;
};

export type NoveltyReport = {
  events: NoveltyEvent[];
  scannedCount: number;
  error?: string; // "mongot_unavailable" when vector search fails
  agentId: string;
};

export type NoveltyOptions = {
  limit?: number; // default 10 (top-N most novel)
  kNeighbors?: number; // default 5 (K nearest neighbors for scoring)
  scope?: MemoryScope;
  timeRange?: { start: Date; end: Date };
};

// ---------------------------------------------------------------------------
// Access Tracker types (Phase 3 — Honcho steal)
// ---------------------------------------------------------------------------

export type AccessTrackerConfig = {
  /** Flush after this many buffered accesses. Default 10. */
  flushThreshold?: number;
  /** Flush every N ms. Default 60 000. */
  flushIntervalMs?: number;
};

// ---------------------------------------------------------------------------
// Consolidation Agent (Dreamer) types (Phase 6 — Honcho steal)
// ---------------------------------------------------------------------------

export type ConsolidationCandidate = {
  eventId: string;
  body: string;
  timestamp: Date;
  noveltyScore: number;
  importanceDecay: number;
  accessCount: number;
  combinedScore: number;
};

export type ConsolidationResult = {
  runId: string;
  agentId: string;
  eventsProcessed: number;
  factsPromoted: number;
  factsPruned: number;
  conflictsResolved: number;
  durationMs: number;
  candidates: ConsolidationCandidate[];
};

export type ConsolidationOptions = {
  maxEvents?: number; // default 100
  minCombinedScore?: number; // default 0.3
  minIntervalMs?: number; // default 3_600_000 (1 hour)
  noveltyWeight?: number; // default 0.4
  importanceWeight?: number; // default 0.3
  accessWeight?: number; // default 0.3
  scope?: MemoryScope;
};

export type RecallTrace = {
  traceId: string;
  agentId: string;
  query: string;
  timestamp: Date;
  pathsExecuted: string[];
  resultCount: number;
  metadata?: Record<string, unknown>;
};

export type MemoryJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type MemoryJobType =
  | "ingest"
  | "sync"
  | "consolidation"
  | "benchmark"
  | "migration"
  | "custom";

export type MemoryJob = {
  jobId: string;
  agentId: string;
  jobType: MemoryJobType;
  status: MemoryJobStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  inputCount?: number;
  outputCount?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  searchDetailed?(request: MemorySearchRequest): Promise<MemorySearchResponse>;
  buildDiscoveryProjection?(
    request: MemoryDiscoveryProjectionRequest,
  ): Promise<MemoryDiscoveryProjection>;
  hydrateActiveSlate?(params?: {
    scope?: MemoryScope;
    scopeRef?: string;
    maxItems?: number;
  }): Promise<MemoryActiveSlate>;
  buildContextBundle?(request?: MemoryContextBundleRequest): Promise<MemoryContextBundle>;
  /** Direct KB search — optional, only available on MongoDB backend. */
  searchKB?(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      filter?: { tags?: string[]; category?: string; source?: string };
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  traceReasoningChain?(params: {
    factId: string;
    collection: string;
    options?: ReasoningChainOptions;
  }): Promise<ReasoningChain>;
  scanNovelty?(params?: NoveltyOptions): Promise<NoveltyReport>;
  writeStructuredMemory?(entry: StructuredMemoryEntry): Promise<{ upserted: boolean; id: string }>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
