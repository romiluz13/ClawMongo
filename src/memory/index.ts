export type {
  MemoryEmbeddingProbeResult,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
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
  type CanonicalEvent,
} from "./mongodb-events.js";
export {
  upsertEntity,
  upsertRelation,
  findEntitiesByName,
  getEntitiesByType,
  expandGraph,
  deleteEntity,
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
  type Episode,
  type EpisodeType,
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
  type ProcedureEntry,
  type ProcedureState,
} from "./mongodb-procedures.js";
export { backfillEventsFromChunks } from "./mongodb-migration.js";
export { rerankResults, type RerankWeights } from "./mongodb-manager.js";
