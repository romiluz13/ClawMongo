import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd" | "mongodb";

export type MemoryMongoDBDeploymentProfile =
  | "atlas-default"
  | "atlas-m0"
  | "community-mongot"
  | "community-bare";

export type MemoryMongoDBEmbeddingMode = "automated" | "managed";

export type MemoryMongoDBFusionMethod = "scoreFusion" | "rankFusion" | "js-merge";

export type MemoryMongoDBConfig = {
  /** MongoDB connection string. Env fallback: OPENCLAW_MONGODB_URI */
  uri?: string;
  /** Database name. Default: "openclaw" */
  database?: string;
  /** Collection prefix. Default: "openclaw_" */
  collectionPrefix?: string;
  /** Deployment profile. Default: "atlas-default" */
  deploymentProfile?: MemoryMongoDBDeploymentProfile;
  /** Embedding mode. Default: "automated" (MongoDB Voyage AI autoEmbed) */
  embeddingMode?: MemoryMongoDBEmbeddingMode;
  /** Hybrid search fusion method. Default: "scoreFusion" */
  fusionMethod?: MemoryMongoDBFusionMethod;
  /** Vector quantization. Default: "none" */
  quantization?: "none" | "scalar" | "binary";
  /** File watcher debounce in milliseconds. Default: 500 */
  watchDebounceMs?: number;
  /** Number of dimensions for vector embeddings. Default: 1024 (Voyage-4-large) */
  numDimensions?: number;
  /** Max connection pool size. Default: 10 */
  maxPoolSize?: number;
  /** TTL for cached embeddings in days. Default: 30. Set 0 to disable. */
  embeddingCacheTtlDays?: number;
  /** TTL for memory files in days. Default: 0 (disabled). WARNING: expired files are auto-deleted. */
  memoryTtlDays?: number;
  /** Enable Change Streams for real-time cross-instance sync. Default: false. Requires replica set. */
  enableChangeStreams?: boolean;
  /** Debounce for batching change stream events in ms. Default: 1000 */
  changeStreamDebounceMs?: number;
};
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  mongodb?: MemoryMongoDBConfig;
};

export type MemoryQmdConfig = {
  command?: string;
  searchMode?: MemoryQmdSearchMode;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
