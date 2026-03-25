import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { MongoClient, type Db, type Document } from "mongodb";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
// v2 module imports
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedMemoryBackendConfig, ResolvedMongoDBConfig } from "./backend-config.js";
import { normalizeExtraMemoryPaths } from "./internal.js";
import { getMemoryStats, type MemoryStats } from "./mongodb-analytics.js";
import { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js";
import {
  heuristicEpisodeSummarizer,
  promoteDerivedMemoryFromEvent,
} from "./mongodb-derived-memory.js";
import { searchEpisodes } from "./mongodb-episodes.js";
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js";
import * as mongodbEvents from "./mongodb-events.js";
import * as mongodbGraph from "./mongodb-graph.js";
import type { Entity, RelationType } from "./mongodb-graph.js";
import { normalizeSearchResults, rrfScore, type SearchMethod } from "./mongodb-hybrid.js";
import { searchKB } from "./mongodb-kb-search.js";
import * as mongodbOps from "./mongodb-ops.js";
import type { IngestRun, ProjectionRun } from "./mongodb-ops.js";
import type { ProcedureEntry } from "./mongodb-procedures.js";
import { searchProcedures } from "./mongodb-procedures.js";
import { synthesizeProfile, type ProfileSynthesis } from "./mongodb-profile.js";
import {
  checkCache,
  writeCache,
  type QueryCacheConfig,
  type QueryCacheSourceScope,
} from "./mongodb-query-cache.js";
import { rewriteQuery, type QueryRewriteConfig } from "./mongodb-query-rewriter.js";
import {
  MongoDBRelevanceRuntime,
  type RelevanceArtifact,
  type RelevanceBenchmarkResult,
  type RelevanceHealth,
  type RelevanceReport,
  type RelevanceSampleState,
  type RelevanceSourceScope,
} from "./mongodb-relevance.js";
import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js";
import {
  planRetrieval,
  type RetrievalPath,
  type RetrievalPlan,
  resolveTimeRangePreset,
} from "./mongodb-retrieval-planner.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import {
  kbCollection,
  chunksCollection,
  detectCapabilities,
  ensureCollections,
  ensureSearchIndexes,
  ensureStandardIndexes,
  eventsCollection,
  entitiesCollection,
  relationsCollection,
  episodesCollection,
  filesCollection,
  kbChunksCollection,
  metaCollection,
  proceduresCollection,
  relevanceRunsCollection,
  structuredMemCollection,
} from "./mongodb-schema.js";
import { resolveScopeRef } from "./mongodb-scope.js";
import { mongoSearch } from "./mongodb-search.js";
import type {
  SearchExplainOptions,
  SearchExplainTraceArtifact,
  SearchTraceEvent,
} from "./mongodb-search.js";
import type { StructuredMemoryEntry } from "./mongodb-structured-memory.js";
import { searchStructuredMemory } from "./mongodb-structured-memory.js";
import { syncToMongoDB } from "./mongodb-sync.js";
import * as mongodbTelemetry from "./mongodb-telemetry.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";

// v2 validation constants
const VALID_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
  "session",
  "user",
  "agent",
  "workspace",
  "tenant",
  "global",
]);
const VALID_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "tool"]);

const log = createSubsystemLogger("memory:mongodb");
const CHANGE_STREAM_RESUME_TOKEN_META_KEY = "change_stream_resume_token";

// ---------------------------------------------------------------------------
// Result dedup utility — exported for testing and reuse
// ---------------------------------------------------------------------------

/**
 * Stable merge identity for search results.
 * Uses an explicit canonicalId when present, otherwise falls back to the
 * reopen locator surface (path + line range) instead of presentation text.
 */
export function getSearchResultCanonicalId(result: MemorySearchResult): string {
  const explicitId = result.canonicalId?.trim();
  if (explicitId) {
    return explicitId;
  }
  const locator = (result.path || result.filePath || "").trim();
  if (locator) {
    return `${locator}:${result.startLine}:${result.endLine}`;
  }
  return `snippet:${result.snippet}:${result.startLine}:${result.endLine}`;
}

/**
 * Deduplicate search results by canonical identity.
 * When duplicates are found (same locator surfaced through multiple paths),
 * keep only the highest-scoring result.
 */
export function deduplicateSearchResults(results: MemorySearchResult[]): MemorySearchResult[] {
  if (results.length === 0) {
    return [];
  }

  const seen = new Map<string, MemorySearchResult>();
  for (const result of results) {
    const identity = getSearchResultCanonicalId(result);
    const existing = seen.get(identity);
    if (!existing || result.score > existing.score) {
      seen.set(identity, result);
    }
  }

  return Array.from(seen.values());
}

function collectSearchResultSources(results: MemorySearchResult[]): Set<MemorySource> {
  return new Set(results.map((result) => result.source));
}

export function classifyQueryCacheSourceScope(
  results: MemorySearchResult[],
): QueryCacheSourceScope {
  const sources = collectSearchResultSources(results);
  if (sources.size === 0) {
    return "conversation";
  }
  if (sources.size > 1) {
    return "all";
  }
  return Array.from(sources)[0] as QueryCacheSourceScope;
}

export function resolveQueryCacheTtlSec(
  results: MemorySearchResult[],
  config: QueryCacheConfig,
): number {
  const sources = collectSearchResultSources(results);
  return sources.has("reference") ? config.kbTtlSec : config.conversationTtlSec;
}

// ---------------------------------------------------------------------------
// Heuristic reranker
// ---------------------------------------------------------------------------

/**
 * Configurable weights for the heuristic reranker.
 */
export type RerankWeights = {
  /** Penalty per excess result from same source (default 0.15) */
  diversityWeight?: number;
  /** Bonus for episode results (default 0.12) */
  episodeBoost?: number;
};

/**
 * Heuristic reranker for v2 search results.
 * - Source diversity penalty: no more than 2 results from the same source at the top
 * - Episode priority boost: episode results get a score boost
 *
 * Does not mutate the original array.
 * Recency boost deferred (needs timestamp in MemorySearchResult interface).
 */
export function rerankResults(
  results: MemorySearchResult[],
  _query: string,
  weights?: RerankWeights,
): MemorySearchResult[] {
  if (results.length === 0) {
    return [];
  }

  const diversityWeight = weights?.diversityWeight ?? 0.15;
  const episodeBoost = weights?.episodeBoost ?? 0.12;

  // Score each result (copy, don't mutate)
  const scored = results.map((r) => ({
    result: r,
    adjustedScore: r.score,
  }));

  // 1. Episode priority boost
  for (const entry of scored) {
    if (entry.result.path.startsWith("episode:")) {
      entry.adjustedScore += episodeBoost;
    }
  }

  // 2. Sort by adjusted score descending
  scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // 3. Source diversity penalty: penalize 3rd+ result from same source
  const sourceCounts = new Map<string, number>();
  for (const entry of scored) {
    const source = entry.result.source;
    const count = (sourceCounts.get(source) ?? 0) + 1;
    sourceCounts.set(source, count);
    if (count > 2) {
      entry.adjustedScore -= diversityWeight * (count - 2);
    }
  }

  // 4. Re-sort after diversity penalty
  scored.sort((a, b) => b.adjustedScore - a.adjustedScore);

  return scored.map((s) => s.result);
}

// ---------------------------------------------------------------------------
// Source policy helpers — exported for testing and reuse
// ---------------------------------------------------------------------------

type SourceConfig = {
  reference: { enabled: boolean };
  conversation: { enabled: boolean };
  structured: { enabled: boolean };
};

/**
 * Determine which search sources are active based on source policy config.
 * Reference (KB) search additionally requires KB to be enabled.
 */
export function getActiveSources(
  sources: SourceConfig | undefined,
  kbEnabled: boolean,
): { conversation: boolean; reference: boolean; structured: boolean } {
  if (!sources) {
    // Default: all sources enabled when no source config is present (backward compat)
    return { conversation: true, reference: kbEnabled, structured: true };
  }
  return {
    conversation: sources.conversation.enabled,
    reference: sources.reference.enabled && kbEnabled,
    structured: sources.structured.enabled,
  };
}

/**
 * Return the list of active source names for status reporting.
 * Only sources that are actually enabled are included.
 */
export function getActiveSourcesForStatus(
  sources: SourceConfig | undefined,
  kbEnabled: boolean,
): MemorySource[] {
  const active = getActiveSources(sources, kbEnabled);
  const names: MemorySource[] = [];
  if (active.conversation) {
    names.push("conversation");
  }
  if (active.reference) {
    names.push("reference");
  }
  if (active.structured) {
    names.push("structured");
  }
  return names;
}

type ActiveSources = { conversation: boolean; reference: boolean; structured: boolean };

/**
 * Resolve which sources to query in relevanceExplain based on the requested
 * sourceScope AND the active source policy. Disabled sources always return
 * false even when explicitly requested via sourceScope.
 */
export function resolveExplainSources(
  sourceScope: RelevanceSourceScope,
  activeSources: ActiveSources,
): ActiveSources {
  switch (sourceScope) {
    case "memory":
      return { conversation: activeSources.conversation, reference: false, structured: false };
    case "kb":
      return { conversation: false, reference: activeSources.reference, structured: false };
    case "structured":
      return { conversation: false, reference: false, structured: activeSources.structured };
    case "all":
    default:
      return { ...activeSources };
  }
}

/** Type guard: checks if a MemorySearchManager supports structured memory writes (MongoDB backend). */
export function hasWriteCapability(manager: MemorySearchManager): manager is MongoDBMemoryManager {
  return "writeStructuredMemory" in manager;
}

/** Type guard: checks if a MemorySearchManager supports relevance diagnostics. */
export function hasRelevanceCapability(
  manager: MemorySearchManager,
): manager is MongoDBMemoryManager {
  return "relevanceExplain" in manager;
}

/** Redact credentials from a MongoDB connection string for safe logging. */
function redactMongoURI(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username) {
      parsed.username = parsed.username.slice(0, 2) + "***";
    }
    return parsed.toString();
  } catch {
    // If URL parsing fails, do a simple regex-based redaction
    return uri.replace(/\/\/([^:]+):([^@]+)@/, "//***:***@");
  }
}

// ---------------------------------------------------------------------------
// MongoDBMemoryManager — implements MemorySearchManager for MongoDB backend
// ---------------------------------------------------------------------------

export class MongoDBMemoryManager implements MemorySearchManager {
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly prefix: string;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private readonly agentScopeRef: string;
  private readonly workspaceScopeRef: string;
  private readonly extraMemoryPaths: string[];
  private readonly capabilities: DetectedCapabilities;
  private readonly config: ResolvedMemoryBackendConfig;
  private syncing: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private changeStreamWatcher: MongoDBChangeStreamWatcher | null = null;
  private relevance: MongoDBRelevanceRuntime | null = null;
  private closed = false;
  private dirty = true;
  private fileCount = 0;
  private chunkCount = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private derivationQueue: Promise<void> = Promise.resolve();
  private lastSearchMode = "legacy";
  private lastSearchDetails: Record<string, unknown> | undefined;

  private constructor(params: {
    client: MongoClient;
    db: Db;
    prefix: string;
    agentId: string;
    workspaceDir: string;
    extraMemoryPaths?: string[];
    capabilities: DetectedCapabilities;
    config: ResolvedMemoryBackendConfig;
    relevance?: MongoDBRelevanceRuntime | null;
  }) {
    this.client = params.client;
    this.db = params.db;
    this.prefix = params.prefix;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.agentScopeRef = resolveScopeRef({ scope: "agent", agentId: params.agentId });
    this.workspaceScopeRef = resolveScopeRef({
      scope: "workspace",
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
    });
    this.extraMemoryPaths = params.extraMemoryPaths ?? [];
    this.capabilities = params.capabilities;
    this.config = params.config;
    this.relevance = params.relevance ?? null;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
    extraPaths?: string[];
  }): Promise<MongoDBMemoryManager | null> {
    const mongoCfg = params.resolved.mongodb;
    if (!mongoCfg) {
      return null;
    }

    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    // Connect to MongoDB with a timeout to avoid hanging
    const safeUri = redactMongoURI(mongoCfg.uri);
    log.info(`connecting to MongoDB: ${safeUri} (db=${mongoCfg.database})`);
    const client = new MongoClient(mongoCfg.uri, {
      serverSelectionTimeoutMS: mongoCfg.connectTimeoutMs,
      connectTimeoutMS: mongoCfg.connectTimeoutMs,
      maxPoolSize: mongoCfg.maxPoolSize,
      minPoolSize: mongoCfg.minPoolSize,
    });
    try {
      await client.connect();
      // Verify the connection actually works with a ping
      await client.db("admin").command({ ping: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`failed to connect to MongoDB (${safeUri}): ${msg}`);
      try {
        await client.close();
      } catch {
        // Ignore close errors during failed connect
      }
      return null;
    }

    const db = client.db(mongoCfg.database);
    const prefix = mongoCfg.collectionPrefix;

    // Ensure collections + schema validation + standard indexes
    await ensureCollections(db, prefix);
    await ensureStandardIndexes(db, prefix, {
      embeddingCacheTtlDays: mongoCfg.embeddingCacheTtlDays,
      memoryTtlDays: mongoCfg.memoryTtlDays,
      relevanceRetentionDays: mongoCfg.relevance.retention.days,
    });

    // Detect what the connected MongoDB supports
    const capabilities = await detectCapabilities(db, chunksCollection(db, prefix).collectionName);
    log.info(`capabilities: ${JSON.stringify(capabilities)}`);

    // Only bootstrap Search indexes when the deployment can talk to Search
    // Index Management at all. This keeps runtime startup responsive on
    // clusters that support fusion stages but do not expose mongot.
    if (capabilities.textSearch || capabilities.vectorSearch) {
      await ensureSearchIndexes(
        db,
        prefix,
        mongoCfg.deploymentProfile,
        mongoCfg.embeddingMode,
        mongoCfg.quantization,
        mongoCfg.numDimensions,
      );
    } else {
      log.info("search index management unavailable; skipping search index bootstrap");
    }

    let relevance: MongoDBRelevanceRuntime | null = null;
    try {
      if (mongoCfg.relevance.enabled) {
        relevance = new MongoDBRelevanceRuntime(db, prefix, params.agentId, mongoCfg, capabilities);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`relevance runtime initialization failed: ${msg}`);
    }

    const manager = new MongoDBMemoryManager({
      client,
      db,
      prefix,
      agentId: params.agentId,
      workspaceDir,
      extraMemoryPaths: normalizeExtraMemoryPaths(workspaceDir, params.extraPaths),
      capabilities,
      config: params.resolved,
      relevance,
    });

    try {
      await manager.sync({ reason: "startup" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`initial memory sync failed: ${msg}`);
    }

    // Start watching bridge memory files for changes
    manager.ensureWatcher();

    // Opt-in: Change Streams for cross-instance sync (requires replica set)
    if (mongoCfg.enableChangeStreams) {
      const persistedResumeToken = await manager.loadPersistedChangeStreamResumeToken();
      const csWatcher = new MongoDBChangeStreamWatcher(
        chunksCollection(db, prefix),
        (event) => {
          if (event.resumeToken !== undefined && event.resumeToken !== null) {
            void manager.persistChangeStreamResumeToken(event.resumeToken);
          }
        },
        mongoCfg.changeStreamDebounceMs,
      );
      let started = await csWatcher.start(persistedResumeToken ?? undefined);
      if (!started && persistedResumeToken) {
        log.warn("change stream resume failed with persisted token; retrying from latest position");
        started = await csWatcher.start();
        if (started) {
          await manager.clearPersistedChangeStreamResumeToken();
        }
      }
      if (started) {
        manager.changeStreamWatcher = csWatcher;
        log.info("change stream watcher enabled for cross-instance sync");
      } else {
        log.info("change streams not available — falling back to file watcher only");
      }
    }

    log.info(
      `ready: profile=${mongoCfg.deploymentProfile} embedding=${mongoCfg.embeddingMode} ` +
        `fusion=${mongoCfg.fusionMethod} caps=${JSON.stringify(capabilities)}`,
    );

    return manager;
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.search
  // ---------------------------------------------------------------------------

  private buildConversationChunkFilter(): Document {
    return {
      source: { $in: ["conversation", "sessions"] },
      agentId: this.agentId,
      status: { $ne: "deleted" },
    };
  }

  private buildBridgeChunkFilter(): Document {
    return {
      source: { $in: ["conversation", "memory"] },
      agentId: this.agentId,
      scope: "workspace",
      scopeRef: this.workspaceScopeRef,
      status: { $ne: "deleted" },
    };
  }

  private getBridgeChunkBudget(maxResults: number): number {
    // Bridge notes should remain searchable, but they are auxiliary to the
    // live runtime memory stream and should not monopolize the result budget.
    return Math.max(2, Math.ceil(maxResults / 3));
  }

  private buildV2AvailablePaths(activeSources: ActiveSources): Set<RetrievalPath> {
    const mongoCfg = this.config.mongodb!;
    const paths = new Set<RetrievalPath>();

    if (activeSources.structured) {
      paths.add("active-critical");
      paths.add("procedural");
      paths.add("structured");
    }
    if (activeSources.reference) {
      paths.add("kb");
    }
    if (activeSources.conversation) {
      paths.add("raw-window");
      paths.add("hybrid");
      if (mongoCfg.graph.enabled) {
        paths.add("graph");
      }
      if (mongoCfg.episodes.enabled) {
        paths.add("episodic");
      }
    }

    return paths;
  }

  private setLastSearchMode(mode: string, details?: Record<string, unknown>) {
    this.lastSearchMode = mode;
    this.lastSearchDetails = details;
  }

  private async legacySearch(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const mongoCfg = this.config.mongodb!;
    const maxResults = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.1;
    const startedAt = Date.now();
    const sampled = this.relevance?.shouldSample() ?? false;
    const explainArtifacts: RelevanceArtifact[] = [];
    const traceEvents: SearchTraceEvent[] = [];
    const explainOpts: SearchExplainOptions | undefined = sampled
      ? {
          enabled: true,
          deep: false,
          includeScoreDetails: true,
          onArtifact: (artifact: SearchExplainTraceArtifact) => {
            explainArtifacts.push({
              artifactType: artifact.artifactType,
              summary: artifact.summary,
              rawExplain: artifact.rawExplain,
              compression: "none",
            });
          },
        }
      : undefined;

    const queryVector: number[] | null = null;
    const activeSources = getActiveSources(mongoCfg.sources, mongoCfg.kb.enabled);
    const bridgeMaxResults = this.getBridgeChunkBudget(maxResults);
    const emptyResults: MemorySearchResult[] = [];
    const [runtimeConversationResults, bridgeConversationResults, kbResults, structuredResults] =
      await Promise.all([
        !activeSources.conversation
          ? emptyResults
          : mongoSearch(chunksCollection(this.db, this.prefix), cleaned, queryVector, {
              maxResults,
              minScore,
              numCandidates: mongoCfg.numCandidates,
              sessionKey: opts?.sessionKey,
              filter: this.buildConversationChunkFilter(),
              fusionMethod: mongoCfg.fusionMethod,
              capabilities: this.capabilities,
              vectorIndexName: `${this.prefix}chunks_vector`,
              textIndexName: `${this.prefix}chunks_text`,
              vectorWeight: 0.7,
              textWeight: 0.3,
              embeddingMode: mongoCfg.embeddingMode,
              explain: explainOpts,
              onTrace: (event) => {
                traceEvents.push(event);
              },
            }),
        !activeSources.conversation
          ? emptyResults
          : mongoSearch(chunksCollection(this.db, this.prefix), cleaned, queryVector, {
              maxResults: bridgeMaxResults,
              minScore,
              numCandidates: mongoCfg.numCandidates,
              sessionKey: opts?.sessionKey,
              filter: this.buildBridgeChunkFilter(),
              fusionMethod: mongoCfg.fusionMethod,
              capabilities: this.capabilities,
              vectorIndexName: `${this.prefix}chunks_vector`,
              textIndexName: `${this.prefix}chunks_text`,
              vectorWeight: 0.7,
              textWeight: 0.3,
              embeddingMode: mongoCfg.embeddingMode,
              explain: explainOpts,
              onTrace: (event) => {
                traceEvents.push(event);
              },
            }),
        !activeSources.reference
          ? emptyResults
          : searchKB(kbChunksCollection(this.db, this.prefix), cleaned, queryVector, {
              maxResults: Math.max(3, Math.floor(maxResults / 3)),
              minScore,
              numCandidates: mongoCfg.numCandidates,
              vectorIndexName: `${this.prefix}kb_chunks_vector`,
              textIndexName: `${this.prefix}kb_chunks_text`,
              capabilities: this.capabilities,
              embeddingMode: mongoCfg.embeddingMode,
              kbDocs: kbCollection(this.db, this.prefix),
              explain: explainOpts,
            }).catch((err) => {
              log.warn(`KB search failed: ${String(err)}`);
              return [] as MemorySearchResult[];
            }),
        !activeSources.structured
          ? emptyResults
          : searchStructuredMemory(
              structuredMemCollection(this.db, this.prefix),
              cleaned,
              queryVector,
              {
                maxResults: Math.max(3, Math.floor(maxResults / 3)),
                minScore,
                filter: { agentId: this.agentId },
                numCandidates: mongoCfg.numCandidates,
                capabilities: this.capabilities,
                vectorIndexName: `${this.prefix}structured_mem_vector`,
                embeddingMode: mongoCfg.embeddingMode,
                explain: explainOpts,
              },
            ).catch((err) => {
              log.warn(`structured memory search failed: ${String(err)}`);
              return [] as MemorySearchResult[];
            }),
      ]);

    const conversationResults = [...runtimeConversationResults, ...bridgeConversationResults];
    const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg);
    const normalizedLegacy = normalizeSearchResults(conversationResults, legacyMethod);
    const normalizedKb = normalizeSearchResults(kbResults, "kb");
    const normalizedStructured = normalizeSearchResults(structuredResults, "structured");

    const merged = [...normalizedLegacy, ...normalizedKb, ...normalizedStructured].toSorted(
      (a, b) => b.score - a.score,
    );

    const deduped = deduplicateSearchResults(merged);
    const dedupCount = merged.length - deduped.length;
    if (dedupCount > 0) {
      log.debug(`search dedup: removed ${dedupCount} duplicate result(s)`);
    }
    const finalResults = rerankResults(deduped, cleaned).slice(0, maxResults);
    const successfulTrace = [...traceEvents].toReversed().find((event) => event.ok);
    const fallbackPath =
      successfulTrace && successfulTrace.method !== mongoCfg.fusionMethod
        ? `${mongoCfg.fusionMethod}->${successfulTrace.method}`
        : undefined;
    const health = this.relevance?.evaluateHealth(finalResults, fallbackPath) ?? "ok";
    this.relevance?.recordSignal(finalResults, fallbackPath);

    if (sampled && this.relevance) {
      explainArtifacts.push({
        artifactType: "trace",
        summary: {
          requestedFusionMethod: mongoCfg.fusionMethod,
          fallbackPath,
          events: traceEvents,
          topScore: finalResults[0]?.score ?? 0,
          resultCount: finalResults.length,
        },
      });
      void this.relevance
        .persistRun({
          query: cleaned,
          sourceScope: "all",
          latencyMs: Date.now() - startedAt,
          topK: maxResults,
          hitSources: Array.from(new Set(finalResults.map((result) => result.source))),
          fallbackPath,
          status: health,
          sampled,
          sampleRate: this.relevance.getSampleState().current,
          artifacts: explainArtifacts,
          diagnosticMode: false,
        })
        .catch((err) => {
          this.relevance?.logTelemetryFailure(err);
        });
    }

    return finalResults;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      this.setLastSearchMode("v2:empty-query");
      return [];
    }

    const mongoCfg = this.config.mongodb!;
    const maxResults = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.1;
    const activeSources = getActiveSources(mongoCfg.sources, mongoCfg.kb.enabled);
    const availablePaths = this.buildV2AvailablePaths(activeSources);

    // Cache check: BEFORE search pipeline
    if (mongoCfg.cache.enabled) {
      const cacheResult = await checkCache({
        db: this.db,
        prefix: this.prefix,
        query: cleaned,
        agentId: this.agentId,
        scope: "agent",
        scopeRef: this.agentScopeRef,
        config: mongoCfg.cache,
      });
      if (cacheResult.hit) {
        this.setLastSearchMode(`v2:cache:${cacheResult.tier}`, {
          pathUsed: cacheResult.pathUsed,
          sourceScope: cacheResult.sourceScope,
        });
        return cacheResult.results;
      }
    }

    const searchStart = Date.now();
    try {
      const v2 = await searchV2(this.db, this.prefix, cleaned, this.agentId, {
        availablePaths,
        hasEpisodes: mongoCfg.episodes.enabled,
        hasGraphData: mongoCfg.graph.enabled,
        maxResults,
        searchOptions: {
          minScore,
          sessionKey: opts?.sessionKey,
          numCandidates: mongoCfg.numCandidates,
          capabilities: this.capabilities,
          fusionMethod: mongoCfg.fusionMethod,
          embeddingMode: mongoCfg.embeddingMode,
          conversationFilter: this.buildConversationChunkFilter(),
          bridgeFilter: activeSources.conversation ? this.buildBridgeChunkFilter() : undefined,
          bridgeMaxResults: this.getBridgeChunkBudget(maxResults),
          scope: "agent",
          scopeRef: this.agentScopeRef,
          rerankConfig: mongoCfg.reranking,
          queryRewriteConfig: mongoCfg.queryRewriting,
        },
      });

      // Emit search telemetry (fire-and-forget)
      mongodbTelemetry.emitTelemetry(this.db, this.prefix, {
        meta: { agentId: this.agentId, operation: "search" },
        durationMs: Date.now() - searchStart,
        ok: v2.results.length > 0,
        pathUsed: v2.metadata.pathsExecuted.join(","),
        resultCount: v2.results.length,
        topScore: v2.results[0]?.score ?? 0,
        fusionMethod: mongoCfg.fusionMethod,
      });

      const v2Details = {
        plan: v2.metadata.plan.paths,
        confidence: v2.metadata.plan.confidence,
        constraints: v2.metadata.plan.constraints,
        pathsExecuted: v2.metadata.pathsExecuted,
        resultsByPath: v2.metadata.resultsByPath,
      };

      if (v2.results.length > 0) {
        this.setLastSearchMode("v2", v2Details);
        // Fire-and-forget cache write
        if (mongoCfg.cache.enabled) {
          const sourceScope = classifyQueryCacheSourceScope(v2.results);
          const ttlSec = resolveQueryCacheTtlSec(v2.results, mongoCfg.cache);
          writeCache({
            db: this.db,
            prefix: this.prefix,
            query: cleaned,
            agentId: this.agentId,
            scope: "agent",
            scopeRef: this.agentScopeRef,
            results: v2.results,
            pathUsed: v2.metadata.pathsExecuted.join(","),
            sourceScope,
            ttlSec,
          });
        }
        return v2.results;
      }

      const fallbackResults = await this.legacySearch(cleaned, opts);
      this.setLastSearchMode("v2->legacy-empty", {
        ...v2Details,
        fallbackResults: fallbackResults.length,
      });
      return fallbackResults;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`planner search failed, falling back to legacy search: ${message}`);
      const fallbackResults = await this.legacySearch(cleaned, opts);
      this.setLastSearchMode("v2->legacy-error", {
        error: message,
        fallbackResults: fallbackResults.length,
      });
      return fallbackResults;
    }
  }

  async relevanceExplain(params: {
    query: string;
    sourceScope?: RelevanceSourceScope;
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
    deep?: boolean;
  }): Promise<{
    runId?: string;
    latencyMs: number;
    sourceScope: RelevanceSourceScope;
    health: RelevanceHealth;
    fallbackPath?: string;
    sampleRate: number;
    artifacts: RelevanceArtifact[];
    results: MemorySearchResult[];
  }> {
    if (!this.relevance) {
      throw new Error("relevance runtime is unavailable");
    }
    const sourceScope = params.sourceScope ?? "all";
    const maxResults = params.maxResults ?? 10;
    const minScore = params.minScore ?? 0.1;
    const startedAt = Date.now();
    const query = params.query.trim();
    if (!query) {
      return {
        latencyMs: 0,
        sourceScope,
        health: "insufficient-data",
        sampleRate: this.relevance.getSampleState().current,
        artifacts: [],
        results: [],
      };
    }

    const queryVector: number[] | null = null;
    const mongoCfg = this.config.mongodb!;

    const artifacts: RelevanceArtifact[] = [];
    const traces: SearchTraceEvent[] = [];
    const explainOpts: SearchExplainOptions = {
      enabled: true,
      deep: Boolean(params.deep),
      includeScoreDetails: true,
      onArtifact: (artifact) => {
        artifacts.push({
          artifactType: artifact.artifactType,
          summary: artifact.summary,
          rawExplain: artifact.rawExplain,
          compression: "none",
        });
      },
    };

    // Source policy enforcement: disabled sources return empty results even when
    // explicitly requested via sourceScope (matches search() behavior).
    const activeSources = getActiveSources(mongoCfg.sources, mongoCfg.kb.enabled);
    const explainSources = resolveExplainSources(sourceScope, activeSources);
    const bridgeMaxResults = this.getBridgeChunkBudget(maxResults);
    const emptyResults: MemorySearchResult[] = [];

    let mergedResults: MemorySearchResult[] = [];
    if (sourceScope === "memory") {
      if (!explainSources.conversation) {
        mergedResults = emptyResults;
      } else {
        const [runtimeHits, bridgeHits] = await Promise.all([
          mongoSearch(chunksCollection(this.db, this.prefix), query, queryVector, {
            maxResults: bridgeMaxResults,
            minScore,
            numCandidates: mongoCfg.numCandidates,
            sessionKey: params.sessionKey,
            filter: this.buildConversationChunkFilter(),
            fusionMethod: mongoCfg.fusionMethod,
            capabilities: this.capabilities,
            vectorIndexName: `${this.prefix}chunks_vector`,
            textIndexName: `${this.prefix}chunks_text`,
            vectorWeight: 0.7,
            textWeight: 0.3,
            embeddingMode: mongoCfg.embeddingMode,
            explain: explainOpts,
            onTrace: (event) => traces.push(event),
          }),
          mongoSearch(chunksCollection(this.db, this.prefix), query, queryVector, {
            maxResults,
            minScore,
            numCandidates: mongoCfg.numCandidates,
            sessionKey: params.sessionKey,
            filter: this.buildBridgeChunkFilter(),
            fusionMethod: mongoCfg.fusionMethod,
            capabilities: this.capabilities,
            vectorIndexName: `${this.prefix}chunks_vector`,
            textIndexName: `${this.prefix}chunks_text`,
            vectorWeight: 0.7,
            textWeight: 0.3,
            embeddingMode: mongoCfg.embeddingMode,
            explain: explainOpts,
            onTrace: (event) => traces.push(event),
          }),
        ]);
        const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg);
        const normalizedRuntime = normalizeSearchResults(runtimeHits, legacyMethod);
        const normalizedBridge = normalizeSearchResults(bridgeHits, legacyMethod);
        mergedResults = rerankResults(
          deduplicateSearchResults(
            [...normalizedRuntime, ...normalizedBridge].toSorted((a, b) => b.score - a.score),
          ),
          query,
        ).slice(0, maxResults);
      }
    } else if (sourceScope === "kb") {
      mergedResults = !explainSources.reference
        ? emptyResults
        : await searchKB(kbChunksCollection(this.db, this.prefix), query, queryVector, {
            maxResults,
            minScore,
            numCandidates: mongoCfg.numCandidates,
            vectorIndexName: `${this.prefix}kb_chunks_vector`,
            textIndexName: `${this.prefix}kb_chunks_text`,
            capabilities: this.capabilities,
            embeddingMode: mongoCfg.embeddingMode,
            kbDocs: kbCollection(this.db, this.prefix),
            explain: explainOpts,
          });
    } else if (sourceScope === "structured") {
      mergedResults = !explainSources.structured
        ? emptyResults
        : await searchStructuredMemory(
            structuredMemCollection(this.db, this.prefix),
            query,
            queryVector,
            {
              maxResults,
              minScore,
              filter: { agentId: this.agentId },
              numCandidates: mongoCfg.numCandidates,
              capabilities: this.capabilities,
              vectorIndexName: `${this.prefix}structured_mem_vector`,
              embeddingMode: mongoCfg.embeddingMode,
              explain: explainOpts,
            },
          );
    } else {
      const [runtimeConversationResults, bridgeConversationResults, kbResults, structuredResults] =
        await Promise.all([
          // Runtime conversation chunks — skip if conversation source is disabled
          !explainSources.conversation
            ? emptyResults
            : mongoSearch(chunksCollection(this.db, this.prefix), query, queryVector, {
                maxResults,
                minScore,
                numCandidates: mongoCfg.numCandidates,
                sessionKey: params.sessionKey,
                filter: this.buildConversationChunkFilter(),
                fusionMethod: mongoCfg.fusionMethod,
                capabilities: this.capabilities,
                vectorIndexName: `${this.prefix}chunks_vector`,
                textIndexName: `${this.prefix}chunks_text`,
                vectorWeight: 0.7,
                textWeight: 0.3,
                embeddingMode: mongoCfg.embeddingMode,
                explain: explainOpts,
                onTrace: (event) => traces.push(event),
              }),
          // Bridge-note chunks — same collection, different namespace filter
          !explainSources.conversation
            ? emptyResults
            : mongoSearch(chunksCollection(this.db, this.prefix), query, queryVector, {
                maxResults: bridgeMaxResults,
                minScore,
                numCandidates: mongoCfg.numCandidates,
                sessionKey: params.sessionKey,
                filter: this.buildBridgeChunkFilter(),
                fusionMethod: mongoCfg.fusionMethod,
                capabilities: this.capabilities,
                vectorIndexName: `${this.prefix}chunks_vector`,
                textIndexName: `${this.prefix}chunks_text`,
                vectorWeight: 0.7,
                textWeight: 0.3,
                embeddingMode: mongoCfg.embeddingMode,
                explain: explainOpts,
                onTrace: (event) => traces.push(event),
              }),
          // KB chunks — skip if reference source is disabled
          !explainSources.reference
            ? emptyResults
            : searchKB(kbChunksCollection(this.db, this.prefix), query, queryVector, {
                maxResults: Math.max(3, Math.floor(maxResults / 3)),
                minScore,
                numCandidates: mongoCfg.numCandidates,
                vectorIndexName: `${this.prefix}kb_chunks_vector`,
                textIndexName: `${this.prefix}kb_chunks_text`,
                capabilities: this.capabilities,
                embeddingMode: mongoCfg.embeddingMode,
                kbDocs: kbCollection(this.db, this.prefix),
                explain: explainOpts,
              }).catch((err) => {
                log.warn(`relevanceExplain KB search failed: ${String(err)}`);
                return [] as MemorySearchResult[];
              }),
          // Structured memory — skip if structured source is disabled
          !explainSources.structured
            ? emptyResults
            : searchStructuredMemory(
                structuredMemCollection(this.db, this.prefix),
                query,
                queryVector,
                {
                  maxResults: Math.max(3, Math.floor(maxResults / 3)),
                  minScore,
                  filter: { agentId: this.agentId },
                  numCandidates: mongoCfg.numCandidates,
                  capabilities: this.capabilities,
                  vectorIndexName: `${this.prefix}structured_mem_vector`,
                  embeddingMode: mongoCfg.embeddingMode,
                  explain: explainOpts,
                },
              ).catch((err) => {
                log.warn(`relevanceExplain structured memory search failed: ${String(err)}`);
                return [] as MemorySearchResult[];
              }),
        ]);
      const conversationResults = [...runtimeConversationResults, ...bridgeConversationResults];
      const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg);
      const normalizedLegacy = normalizeSearchResults(conversationResults, legacyMethod);
      const normalizedKb = normalizeSearchResults(kbResults, "kb");
      const normalizedStructured = normalizeSearchResults(structuredResults, "structured");
      const merged = [...normalizedLegacy, ...normalizedKb, ...normalizedStructured].toSorted(
        (a, b) => b.score - a.score,
      );
      mergedResults = rerankResults(deduplicateSearchResults(merged), query).slice(0, maxResults);
    }

    const successfulTrace = [...traces].toReversed().find((event) => event.ok);
    const fallbackPath =
      successfulTrace && successfulTrace.method !== mongoCfg.fusionMethod
        ? `${mongoCfg.fusionMethod}->${successfulTrace.method}`
        : undefined;
    const health = this.relevance.evaluateHealth(mergedResults, fallbackPath);
    this.relevance.recordSignal(mergedResults, fallbackPath);
    artifacts.push({
      artifactType: "trace",
      summary: {
        sourceScope,
        requestedFusionMethod: mongoCfg.fusionMethod,
        fallbackPath,
        events: traces,
        topScore: mergedResults[0]?.score ?? 0,
        resultCount: mergedResults.length,
      },
    });

    const latencyMs = Date.now() - startedAt;
    let runId: string | undefined;
    try {
      runId = await this.relevance.persistRun({
        query,
        sourceScope,
        latencyMs,
        topK: maxResults,
        hitSources: Array.from(new Set(mergedResults.map((result) => result.source))),
        fallbackPath,
        status: health,
        sampled: true,
        sampleRate: this.relevance.getSampleState().current,
        artifacts,
        diagnosticMode: true,
      });
    } catch (err) {
      this.relevance.logTelemetryFailure(err);
    }

    return {
      runId,
      latencyMs,
      sourceScope,
      health,
      fallbackPath,
      sampleRate: this.relevance.getSampleState().current,
      artifacts,
      results: mergedResults,
    };
  }

  async relevanceBenchmark(params?: {
    datasetPath?: string;
    maxResults?: number;
    minScore?: number;
  }): Promise<RelevanceBenchmarkResult> {
    if (!this.relevance) {
      throw new Error("relevance runtime is unavailable");
    }
    const mongoCfg = this.config.mongodb!;
    if (!mongoCfg.relevance.benchmark.enabled) {
      throw new Error("relevance benchmark is disabled by configuration");
    }
    const datasetPath = params?.datasetPath ?? mongoCfg.relevance.benchmark.datasetPath;
    const cases = await this.relevance.loadBenchmarkDataset(datasetPath);
    const evaluations: Array<{
      empty: boolean;
      topScore: number;
      latencyMs: number;
      pass: boolean;
    }> = [];

    for (const entry of cases) {
      const run = await this.relevanceExplain({
        query: entry.query,
        sourceScope: entry.sourceScope ?? "all",
        maxResults: params?.maxResults ?? 10,
        minScore: params?.minScore ?? 0.1,
        deep: false,
      });
      const summary = MongoDBRelevanceRuntime.buildCaseSummary(run.results, run.latencyMs);
      const expectedSources = entry.expectedSources ?? [];
      const sourcePass = expectedSources.every((source) => summary.hitSources.includes(source));
      const scorePass =
        typeof entry.minTopScore === "number" ? summary.topScore >= entry.minTopScore : true;
      evaluations.push({
        empty: summary.empty,
        topScore: summary.topScore,
        latencyMs: summary.latencyMs,
        pass: !summary.empty && sourcePass && scorePass,
      });
    }

    const metrics = MongoDBRelevanceRuntime.summarizeBenchmarkCases(evaluations);
    const datasetVersion = createHash("sha256")
      .update(JSON.stringify(cases.map((entry) => entry.query)))
      .digest("hex")
      .slice(0, 16);
    const regressions = await this.relevance.persistRegression(datasetVersion, metrics);
    return {
      datasetVersion,
      cases: cases.length,
      ...metrics,
      regressions,
    };
  }

  async relevanceReport(params?: { windowMs?: number }): Promise<RelevanceReport> {
    if (!this.relevance) {
      throw new Error("relevance runtime is unavailable");
    }
    const windowMs = params?.windowMs ?? 24 * 60 * 60 * 1000;
    return await this.relevance.buildReport(windowMs);
  }

  relevanceSampleRate(): RelevanceSampleState {
    if (!this.relevance) {
      return {
        enabled: false,
        current: 0,
        base: 0,
        max: 0,
        windowSize: 0,
        degradedSignals: 0,
      };
    }
    return this.relevance.getSampleState();
  }

  // ---------------------------------------------------------------------------
  // Direct KB search (for kb_search tool optimization)
  // ---------------------------------------------------------------------------

  async searchKB(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      filter?: { tags?: string[]; category?: string; source?: string };
    },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const mongoCfg = this.config.mongodb!;
    const maxResults = opts?.maxResults ?? 5;
    const minScore = opts?.minScore ?? 0.1;

    // Direct KB search uses MongoDB query-time automatic embeddings.
    const queryVector: number[] | null = null;

    return searchKB(kbChunksCollection(this.db, this.prefix), cleaned, queryVector, {
      maxResults,
      minScore,
      filter: opts?.filter,
      numCandidates: mongoCfg.numCandidates,
      vectorIndexName: `${this.prefix}kb_chunks_vector`,
      textIndexName: `${this.prefix}kb_chunks_text`,
      capabilities: this.capabilities,
      embeddingMode: mongoCfg.embeddingMode,
      kbDocs: kbCollection(this.db, this.prefix),
    });
  }

  // ---------------------------------------------------------------------------
  // Score normalization: detect which search method was used for legacy search
  // ---------------------------------------------------------------------------

  private detectSearchMethod(mongoCfg: ResolvedMongoDBConfig): SearchMethod {
    // Determine which search method mongoSearch() likely used based on
    // capabilities and fusion method configuration.
    const canVector = mongoCfg.embeddingMode === "automated" && this.capabilities.vectorSearch;

    if (canVector && this.capabilities.textSearch) {
      // Both server-side fusion and JS-merge fallback produce hybrid-like
      // scores in ~[0,1] range (server fusion via $meta:"searchScore",
      // JS merge via our RRF normalization in mergeHybridResultsMongoDB).
      return "hybrid";
    }
    if (canVector) {
      return "vector";
    }
    // Text-only or $text fallback
    return "text";
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.readFile
  // ---------------------------------------------------------------------------

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }

    if (rawPath.startsWith("structured:")) {
      const [basePath, queryString] = rawPath.split("?", 2);
      const [, type, ...keyParts] = basePath.split(":");
      const key = keyParts.join(":").trim();
      if (!type || !key) {
        throw new Error("path required");
      }
      const query = new URLSearchParams(queryString ?? "");
      const scope = query.get("scope");
      const scopeRef = query.get("scopeRef");
      const record = await structuredMemCollection(this.db, this.prefix).findOne({
        agentId: this.agentId,
        type,
        key,
        ...(scope ? { scope } : {}),
        ...(scopeRef ? { scopeRef } : {}),
      });
      if (!record) {
        return {
          text: "",
          path: rawPath,
          locator: rawPath,
          source: "structured" as const,
          sourceType: "structured" as const,
        };
      }
      await structuredMemCollection(this.db, this.prefix).updateOne(
        { _id: record._id },
        {
          $set: { openedAt: new Date() },
          $inc: { openedCount: 1 },
        },
      );
      const text = [
        `type: ${String(record.type ?? type)}`,
        `key: ${String(record.key ?? key)}`,
        `value: ${String(record.value ?? "")}`,
        typeof record.revision === "number" ? `revision: ${record.revision}` : null,
        typeof record.state === "string" ? `state: ${record.state}` : null,
        typeof record.salience === "string" ? `salience: ${record.salience}` : null,
        typeof record.temporalScope === "string" ? `temporalScope: ${record.temporalScope}` : null,
        record.validFrom instanceof Date ? `validFrom: ${record.validFrom.toISOString()}` : null,
        record.validTo instanceof Date ? `validTo: ${record.validTo.toISOString()}` : null,
        record.reviewAt instanceof Date ? `reviewAt: ${record.reviewAt.toISOString()}` : null,
        record.lastConfirmedAt instanceof Date
          ? `lastConfirmedAt: ${record.lastConfirmedAt.toISOString()}`
          : null,
        typeof record.reinforcementCount === "number"
          ? `reinforcementCount: ${record.reinforcementCount}`
          : null,
        typeof record.sourceReliability === "number"
          ? `sourceReliability: ${record.sourceReliability}`
          : null,
        typeof record.context === "string" ? `context: ${record.context}` : null,
        Array.isArray(record.tags) && record.tags.length > 0
          ? `tags: ${record.tags.join(", ")}`
          : null,
        Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
          ? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
          : null,
        record.provenance && typeof record.provenance === "object"
          ? `provenance: ${JSON.stringify(record.provenance)}`
          : null,
        record.supersedes && typeof record.supersedes === "object"
          ? `supersedes: ${JSON.stringify(record.supersedes)}`
          : null,
        record.invalidatedBy && typeof record.invalidatedBy === "object"
          ? `invalidatedBy: ${JSON.stringify(record.invalidatedBy)}`
          : null,
        Array.isArray(record.conflictsWith) && record.conflictsWith.length > 0
          ? `conflictsWith: ${JSON.stringify(record.conflictsWith)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        path: rawPath,
        locator: rawPath,
        source: "structured" as const,
        sourceType: "structured" as const,
        type,
        key,
      };
    }

    if (rawPath.startsWith("procedure:")) {
      const procedureId = rawPath.slice("procedure:".length).trim();
      if (!procedureId) {
        throw new Error("path required");
      }
      const record = await proceduresCollection(this.db, this.prefix).findOne({
        agentId: this.agentId,
        procedureId,
      });
      if (!record) {
        return {
          text: "",
          path: rawPath,
          locator: rawPath,
          source: "structured" as const,
          sourceType: "structured" as const,
        };
      }
      await proceduresCollection(this.db, this.prefix).updateOne(
        { _id: record._id },
        {
          $set: { openedAt: new Date() },
          $inc: { openedCount: 1 },
        },
      );
      const text = [
        `procedureId: ${String(record.procedureId ?? procedureId)}`,
        `name: ${String(record.name ?? "")}`,
        Array.isArray(record.intentTags) && record.intentTags.length > 0
          ? `intentTags: ${record.intentTags.join(", ")}`
          : null,
        Array.isArray(record.triggerQueries) && record.triggerQueries.length > 0
          ? `triggerQueries: ${record.triggerQueries.join(" | ")}`
          : null,
        Array.isArray(record.steps) && record.steps.length > 0
          ? `steps:\n${record.steps.map((step: unknown, index: number) => `${index + 1}. ${String(step)}`).join("\n")}`
          : null,
        Array.isArray(record.successSignals) && record.successSignals.length > 0
          ? `successSignals: ${record.successSignals.join(", ")}`
          : null,
        typeof record.state === "string" ? `state: ${record.state}` : null,
        typeof record.confidence === "number" ? `confidence: ${record.confidence}` : null,
        typeof record.revision === "number" ? `revision: ${record.revision}` : null,
        Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
          ? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
          : null,
        record.provenance && typeof record.provenance === "object"
          ? `provenance: ${JSON.stringify(record.provenance)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        path: rawPath,
        locator: rawPath,
        source: "structured" as const,
        sourceType: "structured" as const,
      };
    }

    if (rawPath.startsWith("event:")) {
      const eventId = rawPath.slice("event:".length).trim();
      if (!eventId) {
        throw new Error("path required");
      }
      return await this.readCanonicalEvent(eventId, rawPath);
    }

    if (rawPath.startsWith("episode:")) {
      const [basePath, queryString] = rawPath.split("?", 2);
      const episodeId = basePath.slice("episode:".length).trim();
      if (!episodeId) {
        throw new Error("path required");
      }
      const query = new URLSearchParams(queryString ?? "");
      const expand = query.get("expand")?.trim().toLowerCase();
      return await this.readEpisodeLocator({
        rawPath,
        episodeId,
        expandEvents: expand === "events" || expand === "full",
      });
    }

    if (rawPath.startsWith("relation:")) {
      const relationId = rawPath.slice("relation:".length).trim();
      if (!relationId) {
        throw new Error("path required");
      }
      const relation = (
        await relationsCollection(this.db, this.prefix)
          .find(
            {
              agentId: this.agentId,
              scope: "agent",
              scopeRef: this.agentScopeRef,
            },
            {
              sort: { updatedAt: -1, _id: 1 },
              limit: 50,
            },
          )
          .toArray()
      ).find((candidate) => {
        const fromEntityId = String(candidate.fromEntityId ?? "");
        const toEntityId = String(candidate.toEntityId ?? "");
        return `${fromEntityId}-${toEntityId}` === relationId;
      });
      if (!relation) {
        return {
          text: "",
          path: rawPath,
          locator: rawPath,
          source: "conversation" as const,
          sourceType: "conversation" as const,
        };
      }
      const text = [
        `type: ${String(relation.type ?? "")}`,
        `fromEntityId: ${String(relation.fromEntityId ?? "")}`,
        `toEntityId: ${String(relation.toEntityId ?? "")}`,
        typeof relation.weight === "number" ? `weight: ${relation.weight}` : null,
        typeof relation.confidence === "number" ? `confidence: ${relation.confidence}` : null,
        relation.updatedAt instanceof Date
          ? `updatedAt: ${relation.updatedAt.toISOString()}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        path: rawPath,
        locator: rawPath,
        source: "conversation" as const,
        sourceType: "conversation" as const,
      };
    }

    if (rawPath.startsWith("kb:") || rawPath.startsWith("reference:")) {
      const kbPath = rawPath.replace(/^kb:|^reference:/, "").trim();
      if (!kbPath) {
        throw new Error("path required");
      }
      const record = await kbCollection(this.db, this.prefix).findOne(
        {
          $or: [{ "source.path": kbPath }, { title: kbPath }],
        },
        { sort: { updatedAt: -1, _id: 1 } },
      );
      if (!record) {
        return {
          text: "",
          path: rawPath,
          locator: rawPath,
          source: "reference" as const,
          sourceType: "reference" as const,
        };
      }
      return {
        text: typeof record.content === "string" ? record.content : "",
        path: rawPath,
        locator: rawPath,
        source: "reference" as const,
        sourceType: "reference" as const,
        title: typeof record.title === "string" ? record.title : undefined,
      };
    }

    if (
      rawPath.startsWith("conversation:") ||
      rawPath.startsWith("events/") ||
      rawPath.startsWith("sessions/")
    ) {
      return await this.readConversationChunk(rawPath, params.from, params.lines);
    }

    return await this.readBridgeChunk(rawPath, params.from, params.lines);
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.status
  // ---------------------------------------------------------------------------

  status(): MemoryProviderStatus {
    const mongoCfg = this.config.mongodb!;
    const vectorEnabled = this.capabilities.vectorSearch && this.probeEmbeddingModeSupportsVector();
    const lexicalEnabled = this.capabilities.textSearch;
    const hybridEnabled = vectorEnabled && lexicalEnabled;
    return {
      backend: "mongodb",
      provider: "mongodb-automated",
      model: "automated (server-managed)",
      files: this.fileCount,
      chunks: this.chunkCount,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      sources: getActiveSourcesForStatus(mongoCfg.sources, mongoCfg.kb.enabled),
      custom: {
        deploymentProfile: mongoCfg.deploymentProfile,
        embeddingMode: mongoCfg.embeddingMode,
        fusionMethod: mongoCfg.fusionMethod,
        capabilities: this.capabilities,
        searchModes: {
          vector: vectorEnabled,
          lexical: lexicalEnabled,
          hybrid: hybridEnabled,
        },
        searchMode: this.lastSearchMode,
        searchModeDetails: this.lastSearchDetails,
        retrievalPaths: [
          "active-critical",
          "structured",
          "raw-window",
          "graph",
          "hybrid",
          "kb",
          "episodic",
          "procedural",
        ],
        sourceCoverage: {
          reference: mongoCfg.sources?.reference?.enabled && mongoCfg.kb.enabled,
          conversation: mongoCfg.sources?.conversation?.enabled,
          structured: mongoCfg.sources?.structured?.enabled,
        },
        database: mongoCfg.database,
        collectionPrefix: mongoCfg.collectionPrefix,
        quantization: mongoCfg.quantization,
        relevance: this.relevance
          ? {
              enabled: mongoCfg.relevance.enabled,
              telemetry: {
                state:
                  mongoCfg.relevance.enabled && mongoCfg.relevance.telemetry.enabled
                    ? "enabled"
                    : "disabled",
              },
              sampleRate: {
                current: this.relevance.getSampleState().current,
              },
              health: this.relevance.getCurrentHealth(),
              lastRegressionAt: undefined,
              profileCapabilities: this.relevance.getProfileCapabilities(),
            }
          : {
              enabled: false,
              telemetry: { state: "disabled" },
              sampleRate: { current: 0 },
              health: "insufficient-data",
              profileCapabilities: {
                textExplain: false,
                vectorExplain: false,
                fusionExplain: false,
              },
            },
      },
    };
  }

  private async readConversationChunk(rawPath: string, from?: number, lines?: number) {
    const normalizedPath = rawPath.startsWith("conversation:")
      ? rawPath.slice("conversation:".length).trim()
      : rawPath;
    if (!normalizedPath) {
      throw new Error("path required");
    }
    const start = Math.max(1, from ?? 1);
    const count = Math.max(1, lines ?? Number.MAX_SAFE_INTEGER);
    const end = start + count - 1;
    const docs = await chunksCollection(this.db, this.prefix)
      .find({
        path: normalizedPath,
        source: { $in: ["sessions", "conversation"] },
        agentId: this.agentId,
        ...(from || lines
          ? {
              $or: [
                { startLine: { $gte: start, $lte: end } },
                { endLine: { $gte: start, $lte: end } },
                { startLine: { $lte: start }, endLine: { $gte: end } },
              ],
            }
          : {}),
      })
      // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
      .sort({ startLine: 1 })
      .toArray();
    if (docs.length === 0) {
      if (normalizedPath.startsWith("events/")) {
        const eventId = normalizedPath.slice("events/".length).trim();
        if (eventId) {
          return await this.readCanonicalEvent(eventId, `conversation:${normalizedPath}`);
        }
      }
      return {
        text: "",
        path: `conversation:${normalizedPath}`,
        locator: `conversation:${normalizedPath}`,
        source: "conversation" as const,
        sourceType: "conversation" as const,
      };
    }
    return {
      text: docs
        .map((doc: Document) => (typeof doc.text === "string" ? doc.text : ""))
        .filter(Boolean)
        .join("\n"),
      path: `conversation:${normalizedPath}`,
      locator: `conversation:${normalizedPath}`,
      source: "conversation" as const,
      sourceType: "conversation" as const,
    };
  }

  private async readCanonicalEvent(eventId: string, rawPath: string) {
    const event = await eventsCollection(this.db, this.prefix).findOne({
      agentId: this.agentId,
      eventId,
    });
    if (!event) {
      return {
        text: "",
        path: rawPath,
        locator: rawPath,
        source: "conversation" as const,
        sourceType: "conversation" as const,
      };
    }
    const role = typeof event.role === "string" ? event.role : "unknown-role";
    const body = typeof event.body === "string" ? event.body : "";
    const timestamp =
      event.timestamp instanceof Date ? `timestamp: ${event.timestamp.toISOString()}\n` : "";
    return {
      text: `${timestamp}${role}: ${body}`.trim(),
      path: rawPath,
      locator: rawPath,
      source: "conversation" as const,
      sourceType: "conversation" as const,
      type: "event",
      key: eventId,
    };
  }

  private async readBridgeChunk(rawPath: string, from?: number, lines?: number) {
    const start = Math.max(1, from ?? 1);
    const count = Math.max(1, lines ?? Number.MAX_SAFE_INTEGER);
    const end = start + count - 1;
    const docs = await chunksCollection(this.db, this.prefix)
      .find({
        path: rawPath,
        source: { $in: ["conversation", "memory"] },
        agentId: this.agentId,
        scope: "workspace",
        scopeRef: this.workspaceScopeRef,
        ...(from || lines
          ? {
              $or: [
                { startLine: { $gte: start, $lte: end } },
                { endLine: { $gte: start, $lte: end } },
                { startLine: { $lte: start }, endLine: { $gte: end } },
              ],
            }
          : {}),
      })
      // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
      .sort({ startLine: 1 })
      .toArray();
    if (docs.length === 0) {
      return {
        text: "",
        path: rawPath,
        locator: rawPath,
        source: "reference" as const,
        sourceType: "reference" as const,
      };
    }
    return {
      text: docs
        .map((doc: Document) => (typeof doc.text === "string" ? doc.text : ""))
        .filter(Boolean)
        .join("\n"),
      path: rawPath,
      locator: rawPath,
      source: "reference" as const,
      sourceType: "reference" as const,
    };
  }

  private async readEpisodeLocator(params: {
    rawPath: string;
    episodeId: string;
    expandEvents: boolean;
  }) {
    const { rawPath, episodeId, expandEvents } = params;
    const episode = await episodesCollection(this.db, this.prefix).findOne({
      agentId: this.agentId,
      episodeId,
      status: { $ne: "deleted" },
    });
    if (!episode) {
      return {
        text: "",
        path: rawPath,
        locator: rawPath,
        source: "conversation" as const,
        sourceType: "conversation" as const,
      };
    }

    const sourceEventIds = Array.isArray(episode.sourceEventIds)
      ? episode.sourceEventIds.filter((value): value is string => typeof value === "string")
      : Array.isArray(episode.eventIds)
        ? episode.eventIds.filter((value): value is string => typeof value === "string")
        : [];

    const lines = [
      `type: episode`,
      `episodeId: ${episodeId}`,
      typeof episode.type === "string" ? `episodeType: ${episode.type}` : null,
      typeof episode.title === "string" ? `title: ${episode.title}` : null,
      typeof episode.summary === "string" ? `summary: ${episode.summary}` : null,
      episode.timeRange?.start instanceof Date
        ? `timeRangeStart: ${episode.timeRange.start.toISOString()}`
        : null,
      episode.timeRange?.end instanceof Date
        ? `timeRangeEnd: ${episode.timeRange.end.toISOString()}`
        : null,
      typeof episode.sourceEventCount === "number"
        ? `sourceEventCount: ${episode.sourceEventCount}`
        : `sourceEventCount: ${sourceEventIds.length}`,
      sourceEventIds.length > 0 && !expandEvents
        ? `expandLocator: episode:${episodeId}?expand=events`
        : null,
    ].filter(Boolean);

    if (expandEvents && sourceEventIds.length > 0) {
      const events = await eventsCollection(this.db, this.prefix)
        .find({
          agentId: this.agentId,
          eventId: { $in: sourceEventIds },
        })
        .toArray();
      const eventOrder = new Map(sourceEventIds.map((value, index) => [value, index]));
      events.sort((a, b) => {
        const left = eventOrder.get(String(a.eventId)) ?? Number.MAX_SAFE_INTEGER;
        const right = eventOrder.get(String(b.eventId)) ?? Number.MAX_SAFE_INTEGER;
        return left - right;
      });

      if (events.length > 0) {
        lines.push("sourceEvents:");
        for (const event of events) {
          const timestamp =
            event.timestamp instanceof Date ? event.timestamp.toISOString() : "unknown-time";
          const role = typeof event.role === "string" ? event.role : "unknown-role";
          const body = typeof event.body === "string" ? event.body : "";
          lines.push(`[${timestamp}] ${role}: ${body}`);
        }
      }
    }

    return {
      text: lines.join("\n"),
      path: rawPath,
      locator: rawPath,
      source: "conversation" as const,
      sourceType: "conversation" as const,
      title: typeof episode.title === "string" ? episode.title : undefined,
      type: "episode",
      key: episodeId,
    };
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.sync
  // ---------------------------------------------------------------------------

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const mongoCfg = this.config.mongodb!;
    try {
      const result = await syncToMongoDB({
        client: this.client,
        db: this.db,
        prefix: this.prefix,
        agentId: this.agentId,
        // Runtime conversation memory is event-native in MongoDB. Manager-level
        // sync only keeps bridge Markdown in sync and must not rebuild live
        // conversation memory from session transcript files.
        sessionMemoryEnabled: false,
        workspaceDir: this.workspaceDir,
        extraPaths: this.extraMemoryPaths,
        embeddingMode: mongoCfg.embeddingMode,
        reason: params?.reason,
        force: params?.force,
        maxSessionChunks: mongoCfg.maxSessionChunks,
        progress: params?.progress,
      });

      // Query actual totals from MongoDB (not just the delta from this sync)
      try {
        this.fileCount = await filesCollection(this.db, this.prefix).countDocuments();
        this.chunkCount = await chunksCollection(this.db, this.prefix).countDocuments();
      } catch {
        // Fallback to delta counts if count query fails
        this.fileCount = result.filesProcessed + result.sessionFilesProcessed;
        this.chunkCount = result.chunksUpserted + result.sessionChunksUpserted;
      }

      this.dirty = false;
      log.info(
        `sync complete: processed=${result.filesProcessed}+${result.sessionFilesProcessed} ` +
          `chunks=${result.chunksUpserted}+${result.sessionChunksUpserted} ` +
          `totals=${this.fileCount} files, ${this.chunkCount} chunks`,
      );

      // KB auto-refresh: re-import autoImportPaths if autoRefreshHours has elapsed
      await this.maybeAutoRefreshKB();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`sync failed: ${msg}`);
      throw err instanceof Error ? err : new Error(msg);
    }
  }

  private async loadPersistedChangeStreamResumeToken(): Promise<unknown> {
    try {
      const meta = metaCollection(this.db, this.prefix);
      const doc = await meta.findOne({
        _id: CHANGE_STREAM_RESUME_TOKEN_META_KEY,
      } as Record<string, unknown>);
      if (!doc || !("token" in doc)) {
        return null;
      }
      return (doc as Record<string, unknown>).token ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`failed to load persisted change stream resume token: ${msg}`);
      return null;
    }
  }

  private async persistChangeStreamResumeToken(token: unknown): Promise<void> {
    try {
      const meta = metaCollection(this.db, this.prefix);
      await meta.updateOne(
        { _id: CHANGE_STREAM_RESUME_TOKEN_META_KEY } as Record<string, unknown>,
        { $set: { token, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`failed to persist change stream resume token: ${msg}`);
    }
  }

  private async clearPersistedChangeStreamResumeToken(): Promise<void> {
    try {
      const meta = metaCollection(this.db, this.prefix);
      await meta.deleteOne({ _id: CHANGE_STREAM_RESUME_TOKEN_META_KEY } as Record<string, unknown>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`failed to clear stale change stream resume token: ${msg}`);
    }
  }

  private async maybeAutoRefreshKB(): Promise<void> {
    const mongoCfg = this.config.mongodb!;
    if (!mongoCfg.kb.enabled) {
      return;
    }
    const autoRefreshHours = mongoCfg.kb.autoRefreshHours;
    if (autoRefreshHours <= 0) {
      return;
    }
    const paths = mongoCfg.kb.autoImportPaths;
    if (paths.length === 0) {
      return;
    }

    // Check last KB import time from meta collection
    const meta = metaCollection(this.db, this.prefix);
    const lastRefresh = await meta.findOne({ _id: "kb_last_auto_refresh" } as Record<
      string,
      unknown
    >);
    const lastRefreshTime =
      lastRefresh?.timestamp instanceof Date ? lastRefresh.timestamp.getTime() : 0;
    const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60);

    if (hoursSinceRefresh < autoRefreshHours) {
      return;
    }

    log.info(
      `KB auto-refresh: ${hoursSinceRefresh.toFixed(1)}h since last import, refreshing ${paths.length} paths`,
    );
    try {
      const { ingestFilesToKB } = await import("./mongodb-kb.js");
      const result = await ingestFilesToKB({
        db: this.db,
        prefix: this.prefix,
        paths,
        recursive: true,
        importedBy: "agent",
        embeddingMode: mongoCfg.embeddingMode,
        chunking: mongoCfg.kb.chunking,
      });
      log.info(
        `KB auto-refresh complete: ${result.documentsProcessed} docs, ${result.chunksCreated} chunks, ${result.skipped} skipped`,
      );

      // Update last refresh timestamp
      await meta.updateOne(
        { _id: "kb_last_auto_refresh" } as Record<string, unknown>,
        { $set: { timestamp: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`KB auto-refresh failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // File watcher (chokidar)
  // ---------------------------------------------------------------------------

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    const mongoCfg = this.config.mongodb!;
    const debounceMs = mongoCfg.watchDebounceMs;
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "memory"),
      ...this.extraMemoryPaths,
    ]);
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
    this.watcher.on("error", (err) => {
      log.warn(`file watcher error: ${String(err)}`);
    });
  }

  private scheduleWatchSync(): void {
    const mongoCfg = this.config.mongodb!;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, mongoCfg.watchDebounceMs);
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.probeEmbeddingAvailability
  // ---------------------------------------------------------------------------

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const mongoCfg = this.config.mongodb!;

    if (mongoCfg.embeddingMode === "automated") {
      if (mongoCfg.deploymentProfile !== "community-mongot") {
        return {
          ok: false,
          error: `embeddingMode "automated" is only supported on community-mongot in ClawMongo`,
        };
      }
      return this.capabilities.vectorSearch
        ? { ok: true }
        : { ok: false, error: "vector search not available on this MongoDB deployment" };
    }

    return { ok: false, error: "unsupported embedding mode" };
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.probeVectorAvailability
  // ---------------------------------------------------------------------------

  async probeVectorAvailability(): Promise<boolean> {
    return this.capabilities.vectorSearch && this.probeEmbeddingModeSupportsVector();
  }

  private probeEmbeddingModeSupportsVector(): boolean {
    const mongoCfg = this.config.mongodb!;
    return (
      mongoCfg.embeddingMode === "automated" && mongoCfg.deploymentProfile === "community-mongot"
    );
  }

  // ---------------------------------------------------------------------------
  // Structured memory write (exposed for memory_write tool to avoid per-call MongoClient)
  // ---------------------------------------------------------------------------

  async writeStructuredMemory(
    entry: StructuredMemoryEntry,
  ): Promise<{ upserted: boolean; id: string }> {
    const mongoCfg = this.config.mongodb!;
    const { writeStructuredMemory: writeFn } = await import("./mongodb-structured-memory.js");
    return writeFn({
      db: this.db,
      prefix: this.prefix,
      entry: { ...entry, workspaceDir: this.workspaceDir },
      embeddingMode: mongoCfg.embeddingMode,
      client: this.client,
    });
  }

  async writeProcedure(entry: ProcedureEntry): Promise<{ upserted: boolean; id: string }> {
    const mongoCfg = this.config.mongodb!;
    const { writeProcedure: writeFn } = await import("./mongodb-procedures.js");
    return writeFn({
      db: this.db,
      prefix: this.prefix,
      entry: { ...entry, workspaceDir: this.workspaceDir },
      embeddingMode: mongoCfg.embeddingMode,
      client: this.client,
    });
  }

  async getDetailedStatus(): Promise<V2Status> {
    return getV2Status(this.db, this.prefix, this.agentId);
  }

  // C2-manager audit fix: synthesizeProfile delegation to standalone function
  async synthesizeProfile(
    params: {
      scope?: MemoryScope;
      scopeRef?: string;
      maxPerType?: number;
      maxEntities?: number;
      maxEpisodes?: number;
      activityWindowMs?: number;
    } = {},
  ): Promise<ProfileSynthesis> {
    return synthesizeProfile({
      db: this.db,
      prefix: this.prefix,
      agentId: this.agentId,
      scope: params.scope ?? "agent",
      scopeRef: params.scopeRef ?? this.agentScopeRef,
      maxPerType: params.maxPerType,
      maxEntities: params.maxEntities,
      maxEpisodes: params.maxEpisodes,
      activityWindowMs: params.activityWindowMs,
    });
  }

  private enqueueDerivedWork(task: () => Promise<void>): void {
    const run = async () => {
      try {
        await task();
      } catch (err) {
        log.warn(`derived memory work failed: ${String(err)}`);
      }
    };
    const next = this.derivationQueue.then(run, run);
    this.derivationQueue = next.then(
      () => undefined,
      () => undefined,
    );
  }

  private schedulePostWriteDerivations(params: {
    eventId: string;
    role: "user" | "assistant" | "system" | "tool";
    body: string;
    sessionId?: string;
    timestamp: Date;
    scope: MemoryScope;
    scopeRef: string;
  }): void {
    const mongoCfg = this.config.mongodb;
    if (!mongoCfg) {
      return;
    }

    const event = {
      eventId: params.eventId,
      agentId: this.agentId,
      role: params.role,
      body: params.body,
      sessionId: params.sessionId,
      timestamp: params.timestamp,
      scope: params.scope,
      scopeRef: params.scopeRef,
      workspaceDir: this.workspaceDir,
    } as const;

    this.enqueueDerivedWork(async () => {
      await promoteDerivedMemoryFromEvent({
        db: this.db,
        prefix: this.prefix,
        client: this.client,
        embeddingMode: mongoCfg.embeddingMode,
        event,
      });
    });

    if (!mongoCfg.episodes.enabled) {
      return;
    }

    this.enqueueDerivedWork(async () => {
      const triggerThreshold = Math.max(1, mongoCfg.episodes.minEventsForEpisode - 1);
      await checkAutoEpisodeTriggers({
        db: this.db,
        prefix: this.prefix,
        agentId: this.agentId,
        summarizer: heuristicEpisodeSummarizer,
        scope: params.scope,
        scopeRef: params.scopeRef,
        maxEventsWithoutEpisode: triggerThreshold,
      }).catch((err) => {
        log.warn(`auto episode trigger failed after event write: ${String(err)}`);
      });
    });
  }

  async writeConversationEvent(event: {
    role: "user" | "assistant" | "system" | "tool";
    body: string;
    sessionId?: string;
    timestamp?: Date;
    metadata?: Record<string, unknown>;
    scope?: MemoryScope;
  }): Promise<{ eventId: string; chunkCreated: boolean }> {
    const execute = async () => {
      const eventId = randomUUID();
      const scope = event.scope ?? ("agent" as MemoryScope);
      const written = await mongodbEvents.writeEvent({
        db: this.db,
        prefix: this.prefix,
        event: {
          eventId,
          agentId: this.agentId,
          sessionId: event.sessionId,
          role: event.role,
          body: event.body,
          scope,
          timestamp: event.timestamp,
          metadata: event.metadata,
        },
      });
      const projected = await mongodbEvents.projectEventChunk({
        db: this.db,
        prefix: this.prefix,
        event: {
          eventId: written.eventId,
          agentId: this.agentId,
          role: event.role,
          body: event.body,
          scope,
          scopeRef: written.scopeRef,
          timestamp: written.timestamp,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.metadata ? { metadata: event.metadata } : {}),
        },
      });
      if (projected.chunkCreated) {
        this.chunkCount += 1;
      }
      await mongodbGraph
        .extractAndUpsertEntities({
          db: this.db,
          prefix: this.prefix,
          agentId: this.agentId,
          eventContent: event.body,
          scope,
          scopeRef: written.scopeRef,
          sourceEventId: written.eventId,
        })
        .catch((err) => {
          log.warn("entity projection failed after event write", { error: err });
        });
      this.schedulePostWriteDerivations({
        eventId: written.eventId,
        role: event.role,
        body: event.body,
        sessionId: event.sessionId,
        timestamp: written.timestamp,
        scope,
        scopeRef: written.scopeRef,
      });
      this.dirty = false;
      return { eventId: written.eventId, chunkCreated: projected.chunkCreated };
    };

    const next = this.writeQueue.then(execute, execute);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ---------------------------------------------------------------------------
  // Analytics: getMemoryStats
  // ---------------------------------------------------------------------------

  async stats(): Promise<MemoryStats> {
    return getMemoryStats(this.db, this.prefix);
  }

  // ---------------------------------------------------------------------------
  // MemorySearchManager.close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // Clear the debounced sync timer
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }

    await this.derivationQueue;

    // Close the file watcher
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch {
        // Ignore watcher close errors
      }
      this.watcher = null;
    }

    // Close the change stream watcher
    if (this.changeStreamWatcher) {
      const token = this.changeStreamWatcher.lastResumeToken;
      if (token !== undefined && token !== null) {
        await this.persistChangeStreamResumeToken(token);
      }
      try {
        await this.changeStreamWatcher.close();
      } catch {
        // Ignore change stream close errors
      }
      this.changeStreamWatcher = null;
    }

    // Wait for any in-flight sync to complete before closing the connection
    if (this.syncing) {
      try {
        await this.syncing;
      } catch {
        // Ignore sync errors during close — already logged in runSync
      }
    }
    await this.writeQueue;

    // Close the MongoDB connection
    try {
      await this.client.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`error closing MongoDB connection: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 8: v2 standalone functions — write, search, status
// ---------------------------------------------------------------------------

/**
 * Write an event and project it to chunks. Records an ingest run on success or failure.
 * Standalone function following the v2 module pattern (db, prefix, ...).
 */
export async function writeEventAndProject(
  db: Db,
  prefix: string,
  event: {
    agentId: string;
    role: string;
    body: string;
    scope: string;
    sessionId?: string;
    path?: string;
    hash?: string;
    metadata?: Record<string, unknown>;
  },
  options?: { extractor?: import("./mongodb-entity-extractor.js").EntityExtractor },
): Promise<{ eventId: string; chunksCreated: number }> {
  const startMs = Date.now();
  try {
    // Validate scope and role before passing to writeEvent
    if (!VALID_SCOPES.has(event.scope)) {
      throw new Error(`Invalid scope: ${event.scope}`);
    }
    if (!VALID_ROLES.has(event.role)) {
      throw new Error(`Invalid role: ${event.role}`);
    }
    const written = await mongodbEvents.writeEvent({
      db,
      prefix,
      event: {
        eventId: randomUUID(),
        agentId: event.agentId,
        role: event.role as "user" | "assistant" | "system" | "tool",
        body: event.body,
        scope: event.scope as MemoryScope,
        sessionId: event.sessionId,
        channel: undefined,
        metadata: event.metadata,
      },
    });

    const projected = await mongodbEvents.projectEventChunk({
      db,
      prefix,
      event: {
        eventId: written.eventId,
        agentId: event.agentId,
        role: event.role as "user" | "assistant" | "system" | "tool",
        body: event.body,
        scope: event.scope as MemoryScope,
        scopeRef: written.scopeRef,
        timestamp: written.timestamp,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      },
    });
    await mongodbGraph
      .extractAndUpsertEntities({
        db,
        prefix,
        agentId: event.agentId,
        eventContent: event.body,
        scope: event.scope as MemoryScope,
        scopeRef: written.scopeRef,
        sourceEventId: written.eventId,
        extractor: options?.extractor,
      })
      .catch((projErr) => {
        log.warn("entity projection failed during writeEventAndProject", { error: projErr });
      });

    const durationMs = Date.now() - startMs;
    await mongodbOps.recordIngestRun({
      db,
      prefix,
      run: {
        agentId: event.agentId,
        source: "event-write",
        status: "ok",
        itemsProcessed: 1,
        itemsFailed: 0,
        durationMs,
      },
    });

    // Emit event-write telemetry (fire-and-forget)
    mongodbTelemetry.emitTelemetry(db, prefix, {
      meta: { agentId: event.agentId, operation: "event-write" },
      durationMs,
      ok: true,
      eventType: event.role,
      projectionTriggered: true,
    });

    return { eventId: written.eventId, chunksCreated: projected.chunkCreated ? 1 : 0 };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    await mongodbOps
      .recordIngestRun({
        db,
        prefix,
        run: {
          agentId: event.agentId,
          source: "event-write",
          status: "failed",
          itemsProcessed: 0,
          itemsFailed: 1,
          durationMs,
        },
      })
      .catch((recErr) => {
        log.warn("recordIngestRun failed during error recovery", { error: recErr });
      });
    log.error("writeEventAndProject failed", { error: err });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// v2 search types
// ---------------------------------------------------------------------------

export type V2SearchMetadata = {
  plan: RetrievalPlan;
  pathsExecuted: RetrievalPath[];
  resultsByPath: Record<string, number>;
  reranked?: boolean;
  queryRewritten?: boolean;
};

function graphRelationPriority(type: RelationType): number {
  switch (type) {
    case "works_on":
    case "owns":
    case "depends_on":
    case "blocked_by":
    case "decided":
    case "reported_by":
      return 4;
    case "related_to":
      return 3;
    case "mentioned_with":
    default:
      return 1;
  }
}

function entityMatchScore(entity: Entity, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedName = entity.name.trim().toLowerCase();
  if (!normalizedQuery || !normalizedName) {
    return 0;
  }
  if (normalizedQuery === normalizedName) {
    return 10;
  }
  if (normalizedQuery.includes(normalizedName)) {
    return 8;
  }
  if (normalizedName.includes(normalizedQuery)) {
    return 6;
  }
  const aliasMatch = entity.aliases?.some((alias) => {
    const normalizedAlias = alias.trim().toLowerCase();
    return normalizedAlias === normalizedQuery || normalizedQuery.includes(normalizedAlias);
  });
  if (aliasMatch) {
    return 7;
  }
  return 1;
}

function pickBestEntityMatch(candidates: Entity[], query: string): Entity | null {
  if (candidates.length === 0) {
    return null;
  }
  return (
    [...candidates].toSorted((a, b) => {
      const scoreDiff = entityMatchScore(b, query) - entityMatchScore(a, query);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      const recencyDiff =
        (b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0) -
        (a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0);
      if (recencyDiff !== 0) {
        return recencyDiff;
      }
      return a.name.localeCompare(b.name);
    })[0] ?? null
  );
}

function buildGraphQueryCandidates(query: string): string[] {
  const candidates = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 2) {
      candidates.add(trimmed);
    }
  };

  for (const match of query.matchAll(/"([^"]+)"/g)) {
    add(match[1]);
  }
  for (const match of query.matchAll(/[@#]([A-Za-z0-9_./-]+)/g)) {
    add(match[1]);
  }
  for (const match of query.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)) {
    add(match[0]);
  }

  if (candidates.size === 0) {
    const words = query
      .split(/\s+/)
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter((word) => word.length >= 4);
    for (const word of words.slice(0, 4)) {
      add(word);
    }
  }

  return Array.from(candidates).slice(0, 6);
}

/**
 * Execute a v2 retrieval plan: call planRetrieval, execute top 3 paths, deduplicate results.
 * Each path has its own try/catch so one failure doesn't kill the whole search.
 */
export async function searchV2(
  db: Db,
  prefix: string,
  query: string,
  agentId: string,
  context: {
    availablePaths: Set<RetrievalPath>;
    knownEntityNames?: string[];
    hasEpisodes?: boolean;
    hasGraphData?: boolean;
    maxResults?: number;
    searchOptions?: {
      minScore?: number;
      sessionKey?: string;
      numCandidates?: number;
      capabilities?: DetectedCapabilities;
      fusionMethod?: ResolvedMongoDBConfig["fusionMethod"];
      embeddingMode?: ResolvedMongoDBConfig["embeddingMode"];
      conversationFilter?: Document;
      bridgeFilter?: Document;
      bridgeMaxResults?: number;
      scope?: MemoryScope;
      scopeRef?: string;
      allowHybridBackstop?: boolean;
      rerankConfig?: RerankConfig;
      queryRewriteConfig?: QueryRewriteConfig;
      projection?: "full" | "ids-only";
    };
  },
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
  try {
    const graphQueryCandidates =
      context.knownEntityNames && context.knownEntityNames.length > 0
        ? context.knownEntityNames
        : buildGraphQueryCandidates(query);
    const scope = context.searchOptions?.scope ?? "agent";
    const agentScopeRef = context.searchOptions?.scopeRef ?? resolveScopeRef({ scope, agentId });
    const conversationChunkFilter: Document = context.searchOptions?.conversationFilter ?? {
      source: { $in: ["conversation", "sessions"] },
      agentId,
      status: { $ne: "deleted" },
    };
    const bridgeChunkFilter = context.searchOptions?.bridgeFilter;
    const maxResults = context.maxResults ?? 20;
    const minScore = context.searchOptions?.minScore ?? 0.1;
    const numCandidates = context.searchOptions?.numCandidates ?? 200;
    const capabilities = context.searchOptions?.capabilities ?? {
      vectorSearch: true,
      textSearch: true,
      scoreFusion: true,
      rankFusion: false,
    };
    const fusionMethod = context.searchOptions?.fusionMethod ?? "scoreFusion";
    const embeddingMode = context.searchOptions?.embeddingMode ?? "automated";
    const bridgeMaxResults =
      context.searchOptions?.bridgeMaxResults ?? Math.max(2, Math.ceil(maxResults / 3));
    const allowHybridBackstop = context.searchOptions?.allowHybridBackstop ?? true;
    const plan = planRetrieval(query, {
      availablePaths: context.availablePaths,
      knownEntityNames: graphQueryCandidates,
      hasEpisodes: context.hasEpisodes,
      hasGraphData: context.hasGraphData,
    });

    // Rewrite query for search execution (NOT for planner or cache key):
    const qrConfig = context.searchOptions?.queryRewriteConfig;
    let searchQuery = query;
    let wasQueryRewritten = false;
    if (qrConfig?.enabled) {
      const rewriteResult = await rewriteQuery({
        db,
        prefix,
        agentId,
        query,
        config: qrConfig,
      });
      if (rewriteResult.rewritten) {
        searchQuery = rewriteResult.rewrittenQuery;
        wasQueryRewritten = true;
      }
    }

    const constrainedGraphCandidates =
      plan.constraints?.entities?.names && plan.constraints.entities.names.length > 0
        ? plan.constraints.entities.names
        : graphQueryCandidates;
    const timeRange = plan.constraints?.timeRange
      ? resolveTimeRangePreset(plan.constraints.timeRange.preset)
      : undefined;
    const structuredFilter: {
      agentId: string;
      type?: string;
    } = {
      agentId,
      ...(plan.constraints?.structured?.type ? { type: plan.constraints.structured.type } : {}),
    };
    const activeCriticalFilter = {
      agentId,
      state: "active" as const,
      salience: plan.constraints?.activeCritical?.salience ?? (["critical", "high"] as const),
      currentOnly: true,
    };
    const proceduralFilter = {
      agentId,
      state: "active" as const,
    };
    const kbFilter = plan.constraints?.kb
      ? plan.constraints.kb.source
        ? { source: plan.constraints.kb.source }
        : {}
      : undefined;

    const results: MemorySearchResult[] = [];
    const pathsExecuted: RetrievalPath[] = [];
    const resultsByPath: Record<string, number> = {};
    // C3 audit fix: track per-path results for RRF score normalization
    const perPathResults: Record<string, MemorySearchResult[]> = {};

    // Execute the top planned paths first, but keep hybrid as the backstop when
    // specialized paths come back weak or empty.
    const pathsToExecute = plan.paths.slice(0, 3);

    for (const path of pathsToExecute) {
      try {
        let pathResults: MemorySearchResult[] = [];

        switch (path) {
          case "active-critical": {
            const criticalHits = await searchStructuredMemory(
              structuredMemCollection(db, prefix),
              searchQuery,
              null,
              {
                maxResults: context.maxResults ?? 10,
                minScore,
                filter: activeCriticalFilter,
                numCandidates,
                capabilities,
                vectorIndexName: `${prefix}structured_mem_vector`,
                embeddingMode,
              },
            ).catch((err) => {
              log.warn(`searchV2 active-critical path failed: ${String(err)}`);
              return [] as MemorySearchResult[];
            });
            pathResults = criticalHits;
            break;
          }
          case "structured": {
            const structuredHits = await searchStructuredMemory(
              structuredMemCollection(db, prefix),
              searchQuery,
              null,
              {
                maxResults: context.maxResults ?? 10,
                minScore,
                filter: structuredFilter,
                numCandidates,
                capabilities,
                vectorIndexName: `${prefix}structured_mem_vector`,
                embeddingMode,
              },
            ).catch((err) => {
              log.warn(`searchV2 structured path failed: ${String(err)}`);
              return [] as MemorySearchResult[];
            });
            pathResults = structuredHits;
            break;
          }
          case "raw-window": {
            // M2 audit fix: cap raw-window events at 50 to avoid unbounded result sets
            const rawWindowLimit = 50;
            const events = await mongodbEvents.getEventsByTimeRange({
              db,
              prefix,
              agentId,
              start: timeRange?.start ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
              end: timeRange?.end ?? new Date(),
              scope,
              scopeRef: agentScopeRef,
              limit: rawWindowLimit,
            });
            const recentFirst = [...events].toSorted(
              (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
            );
            pathResults = recentFirst.map((e, i) => ({
              canonicalId: e.eventId,
              path: `events/${e.eventId}`,
              filePath: `events/${e.eventId}`,
              startLine: 0,
              endLine: 0,
              snippet: e.body,
              score: 1 - i * 0.01,
              source: "conversation" as MemorySource,
            }));
            break;
          }
          case "graph": {
            if (constrainedGraphCandidates.length > 0) {
              const candidateEntities = (
                await Promise.all(
                  constrainedGraphCandidates.slice(0, 4).map((name) =>
                    mongodbGraph.findEntitiesByName({
                      db,
                      prefix,
                      query: name,
                      agentId,
                      scope,
                      scopeRef: agentScopeRef,
                      limit: 5,
                    }),
                  ),
                )
              ).flat();
              const entity = pickBestEntityMatch(candidateEntities, query);
              if (entity) {
                const graph = await mongodbGraph.expandGraph({
                  db,
                  prefix,
                  entityId: entity.entityId,
                  agentId,
                  scope,
                  scopeRef: agentScopeRef,
                });
                if (graph) {
                  pathResults = graph.connections.map((c, i) => ({
                    canonicalId: `${c.relation.fromEntityId}:${c.relation.type}:${c.relation.toEntityId}`,
                    path: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}`,
                    filePath: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}`,
                    startLine: 0,
                    endLine: 0,
                    snippet: `${graph.rootEntity.name} ${c.relation.type} ${c.entity.name}`,
                    score: Math.min(
                      1.0,
                      Math.max(
                        0.25,
                        0.9 -
                          c.depth * 0.08 -
                          i * 0.02 -
                          (4 - graphRelationPriority(c.relation.type)) * 0.05,
                      ) + Math.min(c.relation.weight ?? 0, 0.15),
                    ),
                    source: "conversation" as MemorySource,
                  }));
                }
              }
            }
            break;
          }
          case "episodic": {
            // Use original query for regex-based episodic search (synonym expansion breaks regex matching)
            const episodes = await searchEpisodes({
              db,
              prefix,
              query,
              agentId,
              scope,
              scopeRef: agentScopeRef,
              ...(timeRange ? { timeRange } : {}),
            });
            pathResults = episodes.map((ep, i) => ({
              canonicalId: ep.episodeId,
              path: `episode:${ep.episodeId}`,
              filePath: `episode:${ep.episodeId}`,
              startLine: 0,
              endLine: 0,
              snippet: `${ep.title}: ${ep.summary}`,
              score: 0.85 - i * 0.01,
              source: "conversation" as MemorySource,
            }));
            break;
          }
          case "procedural": {
            const procedureHits = await searchProcedures(
              proceduresCollection(db, prefix),
              searchQuery,
              null,
              {
                maxResults: context.maxResults ?? 10,
                minScore,
                filter: proceduralFilter,
                numCandidates,
                capabilities,
                vectorIndexName: `${prefix}procedures_vector`,
                embeddingMode,
              },
            ).catch((err) => {
              log.warn(`searchV2 procedural path failed: ${String(err)}`);
              return [] as MemorySearchResult[];
            });
            pathResults = procedureHits;
            break;
          }
          case "hybrid": {
            const searches: Array<Promise<MemorySearchResult[]>> = [];
            if (conversationChunkFilter) {
              searches.push(
                mongoSearch(chunksCollection(db, prefix), searchQuery, null, {
                  maxResults: context.maxResults ?? 10,
                  minScore,
                  numCandidates,
                  sessionKey: context.searchOptions?.sessionKey,
                  filter: conversationChunkFilter,
                  fusionMethod,
                  capabilities,
                  vectorIndexName: `${prefix}chunks_vector`,
                  textIndexName: `${prefix}chunks_text`,
                  vectorWeight: 0.7,
                  textWeight: 0.3,
                  embeddingMode,
                }).catch((err) => {
                  log.warn(`searchV2 hybrid conversation path failed: ${String(err)}`);
                  return [] as MemorySearchResult[];
                }),
              );
            }
            if (bridgeChunkFilter) {
              searches.push(
                mongoSearch(chunksCollection(db, prefix), searchQuery, null, {
                  maxResults: bridgeMaxResults,
                  minScore,
                  numCandidates,
                  sessionKey: context.searchOptions?.sessionKey,
                  filter: bridgeChunkFilter,
                  fusionMethod,
                  capabilities,
                  vectorIndexName: `${prefix}chunks_vector`,
                  textIndexName: `${prefix}chunks_text`,
                  vectorWeight: 0.7,
                  textWeight: 0.3,
                  embeddingMode,
                }).catch((err) => {
                  log.warn(`searchV2 hybrid bridge path failed: ${String(err)}`);
                  return [] as MemorySearchResult[];
                }),
              );
            }
            pathResults = searches.length > 0 ? (await Promise.all(searches)).flat() : [];
            break;
          }
          case "kb": {
            const kbHits = await searchKB(kbChunksCollection(db, prefix), searchQuery, null, {
              maxResults: Math.max(3, Math.floor((context.maxResults ?? 10) / 3)),
              minScore,
              ...(kbFilter ? { filter: kbFilter } : {}),
              numCandidates,
              vectorIndexName: `${prefix}kb_chunks_vector`,
              textIndexName: `${prefix}kb_chunks_text`,
              capabilities,
              embeddingMode,
              kbDocs: kbCollection(db, prefix),
            }).catch((err) => {
              log.warn(`searchV2 kb path failed: ${String(err)}`);
              return [] as MemorySearchResult[];
            });
            pathResults = kbHits;
            break;
          }
        }

        if (pathResults.length > 0) {
          pathsExecuted.push(path);
          resultsByPath[path] = pathResults.length;
          perPathResults[path] = pathResults;
          results.push(...pathResults);
        }
      } catch (pathErr) {
        log.error(`searchV2 path ${path} failed`, { error: pathErr });
        // Continue with other paths
      }
    }

    // Deduplicate, rerank, and limit
    let deduped = deduplicateSearchResults(results);
    const needsProceduralBackstop =
      context.availablePaths.has("procedural") &&
      !pathsToExecute.includes("procedural") &&
      deduped.length < Math.max(2, Math.ceil(maxResults / 3));
    if (needsProceduralBackstop) {
      try {
        const procedureFallback = await searchProcedures(
          proceduresCollection(db, prefix),
          searchQuery,
          null,
          {
            maxResults: context.maxResults ?? 10,
            minScore,
            filter: proceduralFilter,
            numCandidates,
            capabilities,
            vectorIndexName: `${prefix}procedures_vector`,
            embeddingMode,
          },
        );
        if (procedureFallback.length > 0) {
          pathsExecuted.push("procedural");
          resultsByPath.procedural = procedureFallback.length;
          perPathResults.procedural = procedureFallback;
          deduped = deduplicateSearchResults([...deduped, ...procedureFallback]);
        }
      } catch (err) {
        log.warn(`searchV2 procedural backstop failed: ${String(err)}`);
      }
    }

    const needsHybridBackstop =
      allowHybridBackstop &&
      context.availablePaths.has("hybrid") &&
      !pathsExecuted.includes("hybrid") &&
      deduped.length < Math.max(2, Math.ceil(maxResults / 3));
    if (needsHybridBackstop) {
      try {
        // Use searchQuery (already rewritten) for the backstop, but disable rewriting
        // to prevent double-expansion (idempotent for synonyms but breaks future LLM/HyDE)
        const fallback = await searchV2(db, prefix, searchQuery, agentId, {
          ...context,
          availablePaths: new Set(["hybrid"]),
          maxResults,
          searchOptions: {
            ...context.searchOptions,
            allowHybridBackstop: false,
            queryRewriteConfig: undefined, // already rewritten — don't rewrite again
          },
        });
        if (fallback.results.length > 0) {
          pathsExecuted.push("hybrid");
          resultsByPath.hybrid = fallback.results.length;
          perPathResults.hybrid = fallback.results;
          deduped = deduplicateSearchResults([...deduped, ...fallback.results]);
        }
      } catch (err) {
        log.warn(`searchV2 hybrid backstop failed: ${String(err)}`);
      }
    }
    // C3 audit fix: RRF score normalization across paths before reranking.
    // Replace raw scores (incomparable across paths: vector 0-1, BM25 0-inf, episode 0.85-synthetic)
    // with rank-based scores summed across paths. Uses existing rrfScore() from mongodb-hybrid.ts.
    if (Object.keys(perPathResults).length > 1) {
      const rrfMap = new Map<string, number>();
      for (const [_pathName, pathRes] of Object.entries(perPathResults)) {
        for (let rank = 0; rank < pathRes.length; rank++) {
          const key = getSearchResultCanonicalId(pathRes[rank]);
          rrfMap.set(key, (rrfMap.get(key) ?? 0) + rrfScore(rank + 1));
        }
      }
      for (const r of deduped) {
        const rrfVal = rrfMap.get(getSearchResultCanonicalId(r));
        if (rrfVal !== undefined) {
          r.score = rrfVal;
        }
      }
      deduped.sort((a, b) => b.score - a.score);
    }

    const heuristicReranked = rerankResults(deduped, query);

    // Cross-encoder re-ranking via Voyage API (after heuristic, before final slice)
    const rerankCfg = context.searchOptions?.rerankConfig;
    let finalResults = heuristicReranked;
    let wasReranked = false;
    if (rerankCfg?.enabled) {
      const rerankResult = await crossEncoderRerank({
        db,
        prefix,
        agentId,
        query,
        results: heuristicReranked,
        config: rerankCfg,
      });
      if (rerankResult.reranked) {
        finalResults = rerankResult.results;
        wasReranked = true;
      }
    }

    const sliced = finalResults.slice(0, maxResults);

    // Phase 9: Tiered retrieval — strip text for ids-only projection mode
    const projectionMode = context.searchOptions?.projection ?? "full";
    const projected =
      projectionMode === "ids-only" ? sliced.map((r) => ({ ...r, snippet: "" })) : sliced;

    return {
      results: projected,
      metadata: {
        plan,
        pathsExecuted,
        resultsByPath,
        reranked: wasReranked,
        queryRewritten: wasQueryRewritten,
      },
    };
  } catch (err) {
    log.error("searchV2 failed", { query, error: err });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// v2 status types
// ---------------------------------------------------------------------------

export type V2Status = {
  events: { count: number; latestTimestamp?: Date };
  entities: { count: number };
  relations: { count: number };
  episodes: { count: number; latestTimestamp?: Date };
  procedures: { count: number; latestTimestamp?: Date };
  projectionLag: Record<string, number | null>;
  health: {
    overall: "ok" | "degraded" | "health-uncertain";
    retrieval: "ok" | "retrieval-degraded" | "health-uncertain";
    recentNoRelevantResults: boolean;
    canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain";
    derivedProducts: Record<
      string,
      "ok" | "projection-behind" | "derived-product-unavailable" | "health-uncertain"
    >;
    diagnostics: string[];
  };
  retrievalPaths: string[];
};

const PROJECTION_BEHIND_SECONDS = 5 * 60;

export function classifyCanonicalIngestHealth(
  latestIngestRun: Pick<IngestRun, "status"> | null,
): "ok" | "canonical-ingest-failed" | "health-uncertain" {
  if (!latestIngestRun) {
    return "health-uncertain";
  }
  return latestIngestRun.status === "failed" ? "canonical-ingest-failed" : "ok";
}

export function classifyProjectionHealth(params: {
  latestRun: Pick<ProjectionRun, "status"> | null;
  lagSeconds: number | null;
}): "ok" | "projection-behind" | "derived-product-unavailable" | "health-uncertain" {
  const { latestRun, lagSeconds } = params;
  if (!latestRun) {
    return "health-uncertain";
  }
  if (latestRun.status === "failed") {
    return "derived-product-unavailable";
  }
  if (lagSeconds === null) {
    return "health-uncertain";
  }
  if (lagSeconds > PROJECTION_BEHIND_SECONDS) {
    return "projection-behind";
  }
  return "ok";
}

export function classifyRetrievalHealth(params: {
  status?: string | null;
  hitSources?: string[] | null;
}): {
  state: "ok" | "retrieval-degraded" | "health-uncertain";
  recentNoRelevantResults: boolean;
} {
  const status = params.status ?? null;
  const hitSources = params.hitSources ?? [];
  if (status === "ok") {
    return { state: "ok", recentNoRelevantResults: false };
  }
  if (status === "degraded") {
    return {
      state: "retrieval-degraded",
      recentNoRelevantResults: hitSources.length === 0,
    };
  }
  return { state: "health-uncertain", recentNoRelevantResults: false };
}

export function computeOverallV2Health(params: {
  retrieval: "ok" | "retrieval-degraded" | "health-uncertain";
  canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain";
  derivedProducts: Array<
    "ok" | "projection-behind" | "derived-product-unavailable" | "health-uncertain"
  >;
}): "ok" | "degraded" | "health-uncertain" {
  const { retrieval, canonicalIngest, derivedProducts } = params;
  if (
    retrieval === "retrieval-degraded" ||
    canonicalIngest === "canonical-ingest-failed" ||
    derivedProducts.some(
      (state) => state === "projection-behind" || state === "derived-product-unavailable",
    )
  ) {
    return "degraded";
  }
  if (
    retrieval === "health-uncertain" ||
    canonicalIngest === "health-uncertain" ||
    derivedProducts.some((state) => state === "health-uncertain")
  ) {
    return "health-uncertain";
  }
  return "ok";
}

/**
 * Gather v2 health metrics: collection counts, projection lag, available retrieval paths.
 */
export async function getV2Status(db: Db, prefix: string, agentId: string): Promise<V2Status> {
  try {
    const settled = await Promise.allSettled([
      eventsCollection(db, prefix).countDocuments({ agentId }),
      entitiesCollection(db, prefix).countDocuments({ agentId }),
      relationsCollection(db, prefix).countDocuments({ agentId }),
      episodesCollection(db, prefix).countDocuments({ agentId }),
      proceduresCollection(db, prefix).countDocuments({ agentId }),
      mongodbOps.getProjectionLag({ db, prefix, agentId, projectionType: "chunks" }),
      mongodbOps.getProjectionLag({ db, prefix, agentId, projectionType: "entities" }),
      mongodbOps.getProjectionLag({ db, prefix, agentId, projectionType: "relations" }),
      mongodbOps.getProjectionLag({ db, prefix, agentId, projectionType: "episodes" }),
      mongodbOps.getProjectionLag({ db, prefix, agentId, projectionType: "structured-promotion" }),
      mongodbOps.getProjectionLag({ db, prefix, agentId, projectionType: "procedures" }),
      mongodbOps.getLatestIngestRun({ db, prefix, agentId }),
      mongodbOps.getLatestProjectionRun({ db, prefix, agentId, projectionType: "chunks" }),
      mongodbOps.getLatestProjectionRun({ db, prefix, agentId, projectionType: "entities" }),
      mongodbOps.getLatestProjectionRun({ db, prefix, agentId, projectionType: "relations" }),
      mongodbOps.getLatestProjectionRun({ db, prefix, agentId, projectionType: "episodes" }),
      mongodbOps.getLatestProjectionRun({
        db,
        prefix,
        agentId,
        projectionType: "structured-promotion",
      }),
      mongodbOps.getLatestProjectionRun({ db, prefix, agentId, projectionType: "procedures" }),
      relevanceRunsCollection(db, prefix).findOne(
        { agentId },
        { sort: { ts: -1 }, projection: { status: 1, hitSources: 1 } },
      ),
      eventsCollection(db, prefix).findOne(
        { agentId },
        { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
      ),
      episodesCollection(db, prefix).findOne(
        { agentId },
        { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
      ),
      proceduresCollection(db, prefix).findOne(
        { agentId },
        { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
      ),
    ]);

    // Extract fulfilled values, default to safe fallbacks on rejection
    const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === "fulfilled" ? r.value : fallback;

    const eventCount = val(settled[0], 0);
    const entityCount = val(settled[1], 0);
    const relationCount = val(settled[2], 0);
    const episodeCount = val(settled[3], 0);
    const procedureCount = val(settled[4], 0);
    const chunksLag = val(settled[5], null);
    const entitiesLag = val(settled[6], null);
    const relationsLag = val(settled[7], null);
    const episodesLag = val(settled[8], null);
    const structuredPromotionLag = val(settled[9], null);
    const proceduresLag = val(settled[10], null);
    const latestIngest = val(settled[11], null);
    const latestChunksProjection = val(settled[12], null);
    const latestEntitiesProjection = val(settled[13], null);
    const latestRelationsProjection = val(settled[14], null);
    const latestEpisodesProjection = val(settled[15], null);
    const latestStructuredPromotion = val(settled[16], null);
    const latestProceduresProjection = val(settled[17], null);
    const latestRetrievalSafe = val(settled[18], null) as {
      status?: string;
      hitSources?: string[];
    } | null;
    const latestEvent = val(settled[19], null) as { timestamp?: Date } | null;
    const latestEpisode = val(settled[20], null) as { updatedAt?: Date } | null;
    const latestProcedure = val(settled[21], null) as { updatedAt?: Date } | null;

    const canonicalIngest = classifyCanonicalIngestHealth(latestIngest);
    const retrievalHealth = classifyRetrievalHealth({
      status: latestRetrievalSafe?.status,
      hitSources: latestRetrievalSafe?.hitSources,
    });
    const derivedProducts = {
      chunks: classifyProjectionHealth({
        latestRun: latestChunksProjection,
        lagSeconds: chunksLag,
      }),
      entities: classifyProjectionHealth({
        latestRun: latestEntitiesProjection,
        lagSeconds: entitiesLag,
      }),
      relations: classifyProjectionHealth({
        latestRun: latestRelationsProjection,
        lagSeconds: relationsLag,
      }),
      episodes: classifyProjectionHealth({
        latestRun: latestEpisodesProjection,
        lagSeconds: episodesLag,
      }),
      "structured-promotion": classifyProjectionHealth({
        latestRun: latestStructuredPromotion,
        lagSeconds: structuredPromotionLag,
      }),
      procedures: classifyProjectionHealth({
        latestRun: latestProceduresProjection,
        lagSeconds: proceduresLag,
      }),
    };
    const diagnostics = [
      retrievalHealth.state === "retrieval-degraded" ? "retrieval-degraded" : null,
      retrievalHealth.recentNoRelevantResults ? "no-relevant-results" : null,
      canonicalIngest === "canonical-ingest-failed" ? "canonical-ingest-failed" : null,
      canonicalIngest === "health-uncertain" ? "health-uncertain:canonical-ingest" : null,
      ...Object.entries(derivedProducts).map(([name, state]) => {
        if (state === "projection-behind") {
          return `projection-behind:${name}`;
        }
        if (state === "derived-product-unavailable") {
          return `derived-product-unavailable:${name}`;
        }
        if (state === "health-uncertain") {
          return `health-uncertain:${name}`;
        }
        return null;
      }),
    ].filter((value): value is string => Boolean(value));
    const overall = computeOverallV2Health({
      retrieval: retrievalHealth.state,
      canonicalIngest,
      derivedProducts: [
        derivedProducts.chunks,
        derivedProducts.entities,
        derivedProducts.relations,
        derivedProducts.episodes,
      ],
    });

    // Log any individual failures for diagnostics
    for (const r of settled) {
      if (r.status === "rejected") {
        log.error("getV2Status partial failure", { error: r.reason });
      }
    }

    return {
      events: {
        count: eventCount,
        latestTimestamp: latestEvent?.timestamp,
      },
      entities: { count: entityCount },
      relations: { count: relationCount },
      episodes: {
        count: episodeCount,
        latestTimestamp: latestEpisode?.updatedAt,
      },
      procedures: {
        count: procedureCount,
        latestTimestamp: latestProcedure?.updatedAt,
      },
      projectionLag: {
        chunks: chunksLag,
        entities: entitiesLag,
        relations: relationsLag,
        episodes: episodesLag,
        "structured-promotion": structuredPromotionLag,
        procedures: proceduresLag,
      },
      health: {
        overall,
        retrieval: retrievalHealth.state,
        recentNoRelevantResults: retrievalHealth.recentNoRelevantResults,
        canonicalIngest,
        derivedProducts,
        diagnostics,
      },
      retrievalPaths: [
        "active-critical",
        "structured",
        "raw-window",
        "graph",
        "hybrid",
        "kb",
        "episodic",
        "procedural",
      ],
    };
  } catch (err) {
    log.error("getV2Status failed", { error: err });
    throw err;
  }
}
