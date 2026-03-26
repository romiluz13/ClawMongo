export type MemoryBackend = "mongodb";

export type MemoryMongoDBDeploymentProfile = "community-mongot";

export type MemoryMongoDBEmbeddingMode = "automated";

export type MemoryMongoDBFusionMethod = "scoreFusion" | "rankFusion" | "js-merge";

export type MemoryScope = "session" | "user" | "agent" | "workspace" | "tenant" | "global";
export type MemorySourceToggleConfig = {
  enabled?: boolean;
};

export type MemoryMongoDBConfig = {
  /** MongoDB connection string. Env fallback: OPENCLAW_MONGODB_URI */
  uri?: string;
  /** Database name. Default: "openclaw" */
  database?: string;
  /** Collection prefix. Default: "openclaw_" */
  collectionPrefix?: string;
  /** Supported ClawMongo deployment profile. Default: "community-mongot" */
  deploymentProfile?: MemoryMongoDBDeploymentProfile;
  /** Supported ClawMongo embedding mode. Default: "automated" */
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
  /** Min connection pool size. Default: 2 */
  minPoolSize?: number;
  /** TTL for cached embeddings in days. Default: 30. Set 0 to disable. */
  embeddingCacheTtlDays?: number;
  /** TTL for memory files in days. Default: 0 (disabled). WARNING: expired files are auto-deleted. */
  memoryTtlDays?: number;
  /** Enable Change Streams for real-time cross-instance sync. Default: false. Requires replica set. */
  enableChangeStreams?: boolean;
  /** Debounce for batching change stream events in ms. Default: 1000 */
  changeStreamDebounceMs?: number;
  /** Connection timeout in milliseconds. Default: 10000 */
  connectTimeoutMs?: number;
  /** Number of candidates for vector search (numCandidates). Default: 200 */
  numCandidates?: number;
  /** Maximum chunks per session file. Default: 50. Keeps last N chunks (most recent). */
  maxSessionChunks?: number;
  /** Knowledge Base configuration (MongoDB-native feature) */
  kb?: {
    /** Enable KB features. Default: true when MongoDB backend */
    enabled?: boolean;
    /** Custom chunking for KB documents */
    chunking?: { tokens?: number; overlap?: number };
    /** Paths to auto-import on startup */
    autoImportPaths?: string[];
    /** Maximum document size in bytes. Default: 10MB */
    maxDocumentSize?: number;
    /** Hours between automatic re-import of autoImportPaths. Default: 24. Set 0 to disable. */
    autoRefreshHours?: number;
  };
  /** Episode materialization config */
  episodes?: {
    /** Enable episode materialization. Default: true */
    enabled?: boolean;
    /** Minimum events to trigger episode. Default: 10 */
    minEventsForEpisode?: number;
  };
  /** Graph projection config */
  graph?: {
    /** Enable graph projection. Default: true */
    enabled?: boolean;
    /** Max depth for $graphLookup. Default: 2 */
    maxGraphDepth?: number;
    /** Entity extraction configuration */
    entityExtraction?: {
      /** Extraction strategy. Default: "regex" */
      method?: "regex" | "llm";
      /** LLM model for extraction (when method="llm"). Uses agent default if omitted */
      model?: string;
      /** Timeout for LLM extraction in ms. Default: 5000 */
      timeoutMs?: number;
    };
  };
  /** Query rewriting configuration */
  queryRewriting?: {
    /** Enable query rewriting before search. Default: false */
    enabled?: boolean;
    /** Rewriting strategy. Only synonym expansion is currently supported. */
    method?: "synonym-expansion";
    /** Maximum rewritten query length in tokens. Default: 128 */
    maxTokens?: number;
  };
  /** Enable contiguous chunk merging in search results. Default: true */
  enableContiguousMerge?: boolean;
  /** Enable context expansion (fetch neighbor chunks). Default: true */
  enableContextExpansion?: boolean;
  /** Enable conversation window chunks (multi-turn). Default: false (opt-in) */
  enableConversationWindows?: boolean;
  /** Window size in turns for conversation windows. Default: 7 */
  conversationWindowSize?: number;
  /** Overlap between adjacent conversation windows in turns. Default: 2 */
  conversationWindowOverlap?: number;
  /** Cross-encoder re-ranking configuration */
  reranking?: {
    /** Enable cross-encoder re-ranking. Default: false */
    enabled?: boolean;
    /** Re-ranking model. Default: "rerank-2.5" */
    model?: "rerank-2.5" | "rerank-2.5-lite";
    /** Maximum documents to send to reranker. Default: 20 */
    topN?: number;
    /** Minimum retrieval score to be eligible for re-ranking. Default: 0.1 */
    minScore?: number;
    /** Voyage API key. Env fallback: VOYAGE_API_KEY */
    voyageApiKey?: string;
    /** Optional instruction prepended to query for rerank-2.5 instruction-following (8-11% accuracy boost). */
    instruction?: string;
  };
  /** Semantic query cache configuration */
  cache?: {
    /** Enable query caching. Default: true */
    enabled?: boolean;
    /** TTL for conversation scope cache entries in seconds. Default: 300 (5 min) */
    conversationTtlSec?: number;
    /** TTL for KB scope cache entries in seconds. Default: 3600 (1 hour) */
    kbTtlSec?: number;
    /** Cosine similarity threshold for semantic cache hits. Default: 0.95 */
    similarityThreshold?: number;
  };
  /** Explain-driven relevance settings */
  relevance?: {
    /** Master switch for relevance diagnostics + telemetry. Default: true */
    enabled?: boolean;
    telemetry?: {
      /** Enable always-on sampling telemetry. Default: true */
      enabled?: boolean;
      /** Base sampling rate for explain telemetry. Default: 0.01 */
      baseSampleRate?: number;
      /** Adaptive controller settings. */
      adaptive?: {
        /** Enable adaptive escalation. Default: true */
        enabled?: boolean;
        /** Max sampling rate during degradation. Default: 0.10 */
        maxSampleRate?: number;
        /** Minimum recent sample count to evaluate degradation. Default: 200 */
        minWindowSize?: number;
      };
      /** Persist raw explain payloads. Default: true */
      persistRawExplain?: boolean;
      /** Query privacy mode. Default: "redacted-hash" */
      queryPrivacyMode?: "redacted-hash" | "raw" | "none";
    };
    retention?: {
      /** TTL in days for relevance runs/artifacts. Default: 14 */
      days?: number;
    };
    benchmark?: {
      /** Enable benchmark commands and regression persistence. Default: true */
      enabled?: boolean;
      /** Dataset path for relevance benchmark. Default: ~/.openclaw/relevance/golden.jsonl */
      datasetPath?: string;
    };
  };
};
export type MemoryCitationsMode = "auto" | "on" | "off";

export type MemoryConfig = {
  /** Optional explicit MongoDB backend marker. */
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  sources?: {
    reference?: MemorySourceToggleConfig;
    conversation?: MemorySourceToggleConfig;
    structured?: MemorySourceToggleConfig;
  };
  mongodb?: MemoryMongoDBConfig;
};
