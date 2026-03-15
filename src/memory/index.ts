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
  type Episode,
  type EpisodeType,
  type EpisodeSummarizer,
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
export { backfillEventsFromChunks } from "./mongodb-migration.js";
