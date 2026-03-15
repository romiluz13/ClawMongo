import { createHash } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { MongoClient, type Db, type Document } from "mongodb";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
// v2 module imports
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedMemoryBackendConfig, ResolvedMongoDBConfig } from "./backend-config.js";
import { getMemoryStats, type MemoryStats } from "./mongodb-analytics.js";
import { MongoDBChangeStreamWatcher } from "./mongodb-change-stream.js";
import { searchEpisodes } from "./mongodb-episodes.js";
import { writeEvent, projectChunksFromEvents, getEventsByTimeRange } from "./mongodb-events.js";
import { findEntitiesByName, expandGraph } from "./mongodb-graph.js";
import { normalizeSearchResults, type SearchMethod } from "./mongodb-hybrid.js";
import { searchKB } from "./mongodb-kb-search.js";
import { recordIngestRun, getProjectionLag } from "./mongodb-ops.js";
import {
  MongoDBRelevanceRuntime,
  type RelevanceArtifact,
  type RelevanceBenchmarkResult,
  type RelevanceHealth,
  type RelevanceReport,
  type RelevanceSampleState,
  type RelevanceSourceScope,
} from "./mongodb-relevance.js";
import {
  planRetrieval,
  type RetrievalPath,
  type RetrievalPlan,
} from "./mongodb-retrieval-planner.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";
import {
  kbCollection,
  chunksCollection,
  detectCapabilities,
  ensureCollections,
  ensureSchemaValidation,
  ensureSearchIndexes,
  ensureStandardIndexes,
  eventsCollection,
  entitiesCollection,
  relationsCollection,
  episodesCollection,
  filesCollection,
  kbChunksCollection,
  metaCollection,
  structuredMemCollection,
} from "./mongodb-schema.js";
import { mongoSearch } from "./mongodb-search.js";
import type {
  SearchExplainOptions,
  SearchExplainTraceArtifact,
  SearchTraceEvent,
} from "./mongodb-search.js";
import type { StructuredMemoryEntry } from "./mongodb-structured-memory.js";
import { searchStructuredMemory } from "./mongodb-structured-memory.js";
import { syncToMongoDB } from "./mongodb-sync.js";
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
 * Deduplicate search results by content (snippet text).
 * When duplicates are found (same snippet from different sources),
 * keep only the highest-scoring result.
 * Uses simple string comparison (not crypto hash) per plan spec.
 */
export function deduplicateSearchResults(results: MemorySearchResult[]): MemorySearchResult[] {
  if (results.length === 0) {
    return [];
  }

  const seen = new Map<string, MemorySearchResult>();
  for (const result of results) {
    const existing = seen.get(result.snippet);
    if (!existing || result.score > existing.score) {
      seen.set(result.snippet, result);
    }
  }

  return Array.from(seen.values());
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
  private readonly sessionMemoryEnabled: boolean;
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

  private constructor(params: {
    client: MongoClient;
    db: Db;
    prefix: string;
    agentId: string;
    workspaceDir: string;
    sessionMemoryEnabled: boolean;
    capabilities: DetectedCapabilities;
    config: ResolvedMemoryBackendConfig;
    relevance?: MongoDBRelevanceRuntime | null;
  }) {
    this.client = params.client;
    this.db = params.db;
    this.prefix = params.prefix;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.sessionMemoryEnabled = params.sessionMemoryEnabled;
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
  }): Promise<MongoDBMemoryManager | null> {
    const mongoCfg = params.resolved.mongodb;
    if (!mongoCfg) {
      return null;
    }

    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sessionMemoryEnabled =
      params.cfg.agents?.defaults?.memorySearch?.experimental?.sessionMemory ?? false;

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
    await ensureSchemaValidation(db, prefix);
    await ensureStandardIndexes(db, prefix, {
      embeddingCacheTtlDays: mongoCfg.embeddingCacheTtlDays,
      memoryTtlDays: mongoCfg.memoryTtlDays,
      relevanceRetentionDays: mongoCfg.relevance.retention.days,
    });

    // Detect what the connected MongoDB supports
    const capabilities = await detectCapabilities(db);
    log.info(`capabilities: ${JSON.stringify(capabilities)}`);

    // Create search indexes (text + vector) if applicable
    await ensureSearchIndexes(
      db,
      prefix,
      mongoCfg.deploymentProfile,
      mongoCfg.embeddingMode,
      mongoCfg.quantization,
      mongoCfg.numDimensions,
    );

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
      sessionMemoryEnabled,
      capabilities,
      config: params.resolved,
      relevance,
    });

    // Start watching memory files for changes
    manager.ensureWatcher();

    // Opt-in: Change Streams for cross-instance sync (requires replica set)
    if (mongoCfg.enableChangeStreams) {
      const persistedResumeToken = await manager.loadPersistedChangeStreamResumeToken();
      const csWatcher = new MongoDBChangeStreamWatcher(
        chunksCollection(db, prefix),
        (event) => {
          manager.dirty = true;
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

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    // Keep searches strongly fresh when the index is marked dirty.
    if (this.dirty) {
      try {
        await this.sync({ reason: "search" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`memory sync failed before search: ${msg}`, { cause: err });
      }
    }
    if (this.dirty) {
      throw new Error("memory index is still dirty after sync");
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

    // Query embeddings are generated by MongoDB from raw text in automated mode.
    const queryVector: number[] | null = null;

    // Source policy enforcement: only search sources that are enabled in config.
    const activeSources = getActiveSources(mongoCfg.sources, mongoCfg.kb.enabled);

    // Search all sources in parallel with Promise.all for performance.
    // Legacy search does NOT have .catch() — it's the primary search,
    // so total failure propagates. KB and structured keep their .catch(() => []).
    const emptyResults: MemorySearchResult[] = [];
    const [conversationResults, kbResults, structuredResults] = await Promise.all([
      // Conversation chunks — skip if conversation source is disabled
      !activeSources.conversation
        ? emptyResults
        : mongoSearch(chunksCollection(this.db, this.prefix), cleaned, queryVector, {
            maxResults,
            minScore,
            numCandidates: mongoCfg.numCandidates,
            sessionKey: opts?.sessionKey,
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
      // KB chunks — skip if reference source is disabled
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
      // Structured memory — skip if structured source is disabled
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

    // F23 FIX: Normalize scores to [0,1] before cross-source merge.
    // Different search methods produce scores on different scales:
    //   - $vectorSearch: cosine similarity [0,1]
    //   - $search/$text: BM25/TF-IDF [0,inf)
    //   - $rankFusion/$scoreFusion: hybrid fusion scores
    //   - KB and structured: same as legacy (depends on underlying method)
    // We classify each source's search method and normalize accordingly.
    const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg);
    const normalizedLegacy = normalizeSearchResults(conversationResults, legacyMethod);
    const normalizedKb = normalizeSearchResults(kbResults, "kb");
    const normalizedStructured = normalizeSearchResults(structuredResults, "structured");

    const merged = [...normalizedLegacy, ...normalizedKb, ...normalizedStructured].toSorted(
      (a, b) => b.score - a.score,
    );

    // Deduplicate results by content — keep highest-scoring on duplicate
    const deduped = deduplicateSearchResults(merged);
    const dedupCount = merged.length - deduped.length;
    if (dedupCount > 0) {
      log.debug(`search dedup: removed ${dedupCount} duplicate result(s)`);
    }
    const finalResults = deduped.slice(0, maxResults);
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
    const emptyResults: MemorySearchResult[] = [];

    let mergedResults: MemorySearchResult[] = [];
    if (sourceScope === "memory") {
      mergedResults = !explainSources.conversation
        ? emptyResults
        : await mongoSearch(chunksCollection(this.db, this.prefix), query, queryVector, {
            maxResults,
            minScore,
            numCandidates: mongoCfg.numCandidates,
            sessionKey: params.sessionKey,
            fusionMethod: mongoCfg.fusionMethod,
            capabilities: this.capabilities,
            vectorIndexName: `${this.prefix}chunks_vector`,
            textIndexName: `${this.prefix}chunks_text`,
            vectorWeight: 0.7,
            textWeight: 0.3,
            embeddingMode: mongoCfg.embeddingMode,
            explain: explainOpts,
            onTrace: (event) => traces.push(event),
          });
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
      const [conversationResults, kbResults, structuredResults] = await Promise.all([
        // Conversation chunks — skip if conversation source is disabled
        !explainSources.conversation
          ? emptyResults
          : mongoSearch(chunksCollection(this.db, this.prefix), query, queryVector, {
              maxResults,
              minScore,
              numCandidates: mongoCfg.numCandidates,
              sessionKey: params.sessionKey,
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
      const legacyMethod: SearchMethod = this.detectSearchMethod(mongoCfg);
      const normalizedLegacy = normalizeSearchResults(conversationResults, legacyMethod);
      const normalizedKb = normalizeSearchResults(kbResults, "kb");
      const normalizedStructured = normalizeSearchResults(structuredResults, "structured");
      const merged = [...normalizedLegacy, ...normalizedKb, ...normalizedStructured].toSorted(
        (a, b) => b.score - a.score,
      );
      mergedResults = deduplicateSearchResults(merged).slice(0, maxResults);
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
      const [, type, ...keyParts] = rawPath.split(":");
      const key = keyParts.join(":").trim();
      if (!type || !key) {
        throw new Error("path required");
      }
      const record = await structuredMemCollection(this.db, this.prefix).findOne({
        agentId: this.agentId,
        type,
        key,
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
      const text = [
        `type: ${String(record.type ?? type)}`,
        `key: ${String(record.key ?? key)}`,
        `value: ${String(record.value ?? "")}`,
        typeof record.context === "string" ? `context: ${record.context}` : null,
        Array.isArray(record.tags) && record.tags.length > 0
          ? `tags: ${record.tags.join(", ")}`
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

    if (rawPath.startsWith("kb:") || rawPath.startsWith("reference:")) {
      const kbPath = rawPath.replace(/^kb:|^reference:/, "").trim();
      if (!kbPath) {
        throw new Error("path required");
      }
      const record = await kbCollection(this.db, this.prefix).findOne({
        $or: [{ "source.path": kbPath }, { title: kbPath }],
      });
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

    return await this.readConversationChunk(rawPath, params.from, params.lines);
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
      .toSorted({ startLine: 1 })
      .toArray();
    if (docs.length === 0) {
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
        sessionMemoryEnabled: this.sessionMemoryEnabled,
        workspaceDir: this.workspaceDir,
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
    const watchPaths = [resolveSessionTranscriptsDirForAgent(this.agentId)];
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
      entry,
      embeddingMode: mongoCfg.embeddingMode,
    });
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
    const written = await writeEvent({
      db,
      prefix,
      event: {
        agentId: event.agentId,
        role: event.role as "user" | "assistant" | "system" | "tool",
        body: event.body,
        scope: event.scope as MemoryScope,
        sessionId: event.sessionId,
        channel: undefined,
        metadata: event.metadata,
      },
    });

    const projected = await projectChunksFromEvents({
      db,
      prefix,
      agentId: event.agentId,
    });

    const durationMs = Date.now() - startMs;
    await recordIngestRun({
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

    return { eventId: written.eventId, chunksCreated: projected.chunksCreated };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    await recordIngestRun({
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
    }).catch((recErr) => {
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
};

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
  },
): Promise<{ results: MemorySearchResult[]; metadata: V2SearchMetadata }> {
  try {
    const plan = planRetrieval(query, {
      availablePaths: context.availablePaths,
      knownEntityNames: context.knownEntityNames,
      hasEpisodes: context.hasEpisodes,
      hasGraphData: context.hasGraphData,
    });

    const results: MemorySearchResult[] = [];
    const pathsExecuted: RetrievalPath[] = [];
    const resultsByPath: Record<string, number> = {};
    const maxResults = context.maxResults ?? 20;

    // Execute top 3 paths from plan (avoid executing all 6)
    const pathsToExecute = plan.paths.slice(0, 3);

    for (const path of pathsToExecute) {
      try {
        let pathResults: MemorySearchResult[] = [];

        switch (path) {
          case "structured":
            log.debug("searchV2: structured path delegated to caller");
            break;
          case "raw-window": {
            const now = new Date();
            const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const events = await getEventsByTimeRange({
              db,
              prefix,
              agentId,
              start: dayAgo,
              end: now,
            });
            pathResults = events.map((e, i) => ({
              path: `event:${e.eventId}`,
              filePath: `event:${e.eventId}`,
              startLine: 0,
              endLine: 0,
              snippet: e.body,
              score: 1 - i * 0.01,
              source: "conversation" as MemorySource,
            }));
            break;
          }
          case "graph": {
            if (context.knownEntityNames?.length) {
              const entities = await findEntitiesByName({
                db,
                prefix,
                query: context.knownEntityNames[0],
                agentId,
              });
              if (entities.length > 0) {
                const graph = await expandGraph({
                  db,
                  prefix,
                  entityId: entities[0].entityId,
                  agentId,
                });
                if (graph) {
                  pathResults = graph.connections.map((c, i) => ({
                    path: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}`,
                    filePath: `relation:${c.relation.fromEntityId}-${c.relation.toEntityId}`,
                    startLine: 0,
                    endLine: 0,
                    snippet: `${c.relation.type}: ${c.entity.name}`,
                    score: 0.8 - i * 0.01,
                    source: "conversation" as MemorySource,
                  }));
                }
              }
            }
            break;
          }
          case "episodic": {
            const episodes = await searchEpisodes({
              db,
              prefix,
              query,
              agentId,
            });
            pathResults = episodes.map((ep, i) => ({
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
          case "hybrid":
            log.debug("searchV2: hybrid path delegated to existing search infrastructure");
            break;
          case "kb":
            log.debug("searchV2: kb path delegated to existing search infrastructure");
            break;
        }

        if (pathResults.length > 0) {
          pathsExecuted.push(path);
          resultsByPath[path] = pathResults.length;
          results.push(...pathResults);
        }
      } catch (pathErr) {
        log.error(`searchV2 path ${path} failed`, { error: pathErr });
        // Continue with other paths
      }
    }

    // Deduplicate and limit
    const deduped = deduplicateSearchResults(results).slice(0, maxResults);

    return {
      results: deduped,
      metadata: { plan, pathsExecuted, resultsByPath },
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
  runtimeMode: "mongo_v2";
  events: { count: number; latestTimestamp?: Date };
  entities: { count: number };
  relations: { count: number };
  episodes: { count: number; latestTimestamp?: Date };
  projectionLag: Record<string, number | null>;
  retrievalPaths: string[];
};

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
      getProjectionLag({ db, prefix, agentId, projectionType: "chunks" }),
      getProjectionLag({ db, prefix, agentId, projectionType: "entities" }),
      getProjectionLag({ db, prefix, agentId, projectionType: "relations" }),
      getProjectionLag({ db, prefix, agentId, projectionType: "episodes" }),
      eventsCollection(db, prefix).findOne(
        { agentId },
        { sort: { timestamp: -1 }, projection: { timestamp: 1 } },
      ),
      episodesCollection(db, prefix).findOne(
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
    const chunksLag = val(settled[4], null);
    const entitiesLag = val(settled[5], null);
    const relationsLag = val(settled[6], null);
    const episodesLag = val(settled[7], null);
    const latestEvent = val(settled[8], null) as { timestamp?: Date } | null;
    const latestEpisode = val(settled[9], null) as { updatedAt?: Date } | null;

    // Log any individual failures for diagnostics
    for (const r of settled) {
      if (r.status === "rejected") {
        log.error("getV2Status partial failure", { error: r.reason });
      }
    }

    return {
      runtimeMode: "mongo_v2",
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
      projectionLag: {
        chunks: chunksLag,
        entities: entitiesLag,
        relations: relationsLag,
        episodes: episodesLag,
      },
      retrievalPaths: ["structured", "raw-window", "graph", "hybrid", "kb", "episodic"],
    };
  } catch (err) {
    log.error("getV2Status failed", { error: err });
    throw err;
  }
}
