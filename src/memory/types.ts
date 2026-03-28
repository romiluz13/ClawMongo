export type MemorySource = "reference" | "conversation" | "structured";
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
  backend: "mongodb";
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
  vector?: {
    enabled: boolean;
    available?: boolean;
    loadError?: string;
    dims?: number;
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

export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  searchDetailed?(request: MemorySearchRequest): Promise<MemorySearchResponse>;
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
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
