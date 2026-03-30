export type {
  EvidenceCoverage,
  MemoryEmbeddingProbeResult,
  MemoryReadResult,
  MemorySearchClassification,
  MemorySearchManager,
  MemorySearchMetadata,
  MemorySearchMode,
  MemorySearchPass,
  MemorySearchRequest,
  MemorySearchResponse,
  MemorySearchResult,
  MemorySearchSourcePreference,
  MemorySearchTimeRange,
  MemorySearchTimeRangePreset,
  MemorySource,
  RejectedResultSummary,
} from "./types.js";
export {
  closeAllMemorySearchManagers,
  getMemorySearchManager,
  type MemorySearchManagerResult,
} from "./search-manager.js";

// v2 modules
export {
  writeEvent,
  getEventsByTimeRange,
  getEventsBySession,
  getUnprojectedEvents,
  markEventsProjected,
  markEventsConsolidated,
  getUnconsolidatedEvents,
  projectChunksFromEvents,
  getSessionEventsWithBound,
  renderEventChunkText,
  type CanonicalEvent,
} from "./mongodb-events.js";
export {
  upsertEntity,
  upsertRelation,
  findEntitiesByName,
  getEntitiesByType,
  expandGraph,
  deleteEntity,
  deleteEntityConservative,
  extractAndUpsertEntities,
  type Entity,
  type EntityType,
  type Relation,
  type RelationType,
  type GraphExpansionResult,
} from "./mongodb-graph.js";
export {
  materializeEpisode,
  getEpisodesByTimeRange,
  getEpisodesByType,
  searchEpisodes,
  checkAutoEpisodeTriggers,
  updateEpisodeStatus,
  getEpisodesByIds,
  type Episode,
  type EpisodeType,
  type EpisodeStatus,
  type EpisodeSummarizer,
  type AutoEpisodeTriggerResult,
} from "./mongodb-episodes.js";
export {
  recordIngestRun,
  recordProjectionRun,
  getRecentIngestRuns,
  getRecentProjectionRuns,
  getProjectionLag,
} from "./mongodb-ops.js";
export {
  planRetrieval,
  type RetrievalPlan,
  type RetrievalPath,
} from "./mongodb-retrieval-planner.js";
export {
  writeProcedure,
  searchProcedures,
  recordProcedureOutcome,
  evolveProcedure,
  type ProcedureEntry,
  type ProcedureState,
} from "./mongodb-procedures.js";
export { backfillEventsFromChunks } from "./mongodb-migration.js";
export { rerankResults, type RerankWeights } from "./mongodb-manager.js";
export {
  queryCacheCollection,
  telemetryCollection,
  mutationsCollection,
  laneCoverageCollection,
} from "./mongodb-schema.js";
export {
  updateLaneCoverage,
  getLaneCoverage,
  emptyLaneCoverage,
  type LaneCoverageDocument,
  type LaneStatus,
} from "./mongodb-lane-coverage.js";
export {
  recordMutation,
  getMutationHistory,
  type MutationRecord,
  type MutationOperation,
} from "./mongodb-mutations.js";
export {
  checkCache,
  writeCache,
  normalizeQuery,
  hashQuery,
  type QueryCacheEntry,
  type QueryCacheConfig,
  type CacheCheckResult,
  DEFAULT_CACHE_CONFIG,
} from "./mongodb-query-cache.js";
export {
  emitTelemetry,
  getLatencyStats,
  getCacheHitRate,
  getOperationDistribution,
  type TelemetryDocument,
  type TelemetryOperation,
  type TelemetryMeta,
} from "./mongodb-telemetry.js";
export {
  synthesizeProfile,
  type ProfileSynthesis,
  type ProfileMemoryItem,
  type ProfileEntity,
  type ProfileEpisode,
  type ActivityPatterns,
} from "./mongodb-profile.js";
export { crossEncoderRerank, type RerankConfig, type RerankResult } from "./mongodb-reranker.js";
export {
  rewriteQuery,
  expandSynonyms,
  type QueryRewriteConfig,
  type QueryRewriteResult,
} from "./mongodb-query-rewriter.js";
export { mergeContiguousChunks } from "./mongodb-contiguous-merge.js";
export { expandSearchContext } from "./mongodb-context-expansion.js";
export {
  buildConversationWindows,
  projectConversationWindows,
  type ConversationWindow,
} from "./mongodb-conversation-windows.js";
export {
  buildTieredSummaryPrompt,
  parseTieredSummaryResponse,
  withTieredSummaries,
} from "./mongodb-tiered-summary.js";
export {
  type EntityExtractor,
  type ExtractedEntity as ExtractedEntityV2,
  type EntityExtractionContext,
  type LLMFunction,
  RegexEntityExtractor,
  LLMEntityExtractor,
  buildExtractionPrompt,
  buildUserExtractionPrompt,
  buildAssistantExtractionPrompt,
  parseExtractionResponse,
} from "./mongodb-entity-extractor.js";
