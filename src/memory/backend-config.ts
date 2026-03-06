import type { OpenClawConfig } from "../config/config.js";
import type { SessionSendPolicyConfig } from "../config/types.base.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryMongoDBDeploymentProfile,
  MemoryMongoDBEmbeddingMode,
  MemoryMongoDBFusionMethod,
  MemoryQmdSearchMode,
} from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("memory:backend-config");

// Known embedding model dimensions for numDimensions validation (F22)
const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
  "voyage-4-large": 1024,
  "voyage-4": 1024,
  "voyage-4-lite": 512,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-code-3": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export type ResolvedMongoDBConfig = {
  uri: string;
  database: string;
  collectionPrefix: string;
  deploymentProfile: MemoryMongoDBDeploymentProfile;
  embeddingMode: MemoryMongoDBEmbeddingMode;
  fusionMethod: MemoryMongoDBFusionMethod;
  quantization: "none" | "scalar" | "binary";
  watchDebounceMs: number;
  numDimensions: number;
  maxPoolSize: number;
  minPoolSize: number;
  embeddingCacheTtlDays: number;
  memoryTtlDays: number;
  enableChangeStreams: boolean;
  changeStreamDebounceMs: number;
  connectTimeoutMs: number;
  numCandidates: number;
  maxSessionChunks: number;
  kb: {
    enabled: boolean;
    chunking: { tokens: number; overlap: number };
    autoImportPaths: string[];
    maxDocumentSize: number;
    autoRefreshHours: number;
  };
  relevance: {
    enabled: boolean;
    telemetry: {
      enabled: boolean;
      baseSampleRate: number;
      adaptive: {
        enabled: boolean;
        maxSampleRate: number;
        minWindowSize: number;
      };
      persistRawExplain: boolean;
      queryPrivacyMode: "redacted-hash" | "raw" | "none";
    };
    retention: {
      days: number;
    };
    benchmark: {
      enabled: boolean;
      datasetPath: string;
    };
  };
};

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  qmd?: ResolvedQmdConfig;
  mongodb?: ResolvedMongoDBConfig;
};

export type ResolvedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ResolvedQmdUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  waitForBootSync: boolean;
  embedIntervalMs: number;
  commandTimeoutMs: number;
  updateTimeoutMs: number;
  embedTimeoutMs: number;
};

export type ResolvedQmdLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};

export type ResolvedQmdSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type ResolvedQmdMcporterConfig = {
  enabled: boolean;
  serverName: string;
  startDaemon: boolean;
};

export type ResolvedQmdConfig = {
  command: string;
  mcporter: ResolvedQmdMcporterConfig;
  searchMode: MemoryQmdSearchMode;
  collections: ResolvedQmdCollection[];
  sessions: ResolvedQmdSessionConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: SessionSendPolicyConfig;
};

const DEFAULT_BACKEND: MemoryBackend = "mongodb";
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";
const DEFAULT_RELEVANCE_DATASET = "~/.openclaw/relevance/golden.jsonl";
const DEFAULT_MONGODB_PROFILE: MemoryMongoDBDeploymentProfile = "community-mongot";
const DEFAULT_MONGODB_EMBEDDING_MODE: MemoryMongoDBEmbeddingMode = "managed";

function sanitizeName(input: string): string {
  const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "collection";
}

export function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;

  if (backend === "builtin" || backend === "qmd") {
    throw new Error(buildLegacyBackendError(backend));
  }

  if (backend === "mongodb") {
    const mongoCfg = params.cfg.memory?.mongodb;
    const uri = mongoCfg?.uri ?? process.env.OPENCLAW_MONGODB_URI;
    if (!uri) {
      throw new Error(
        [
          "MongoDB URI required for ClawMongo.",
          "Set `memory.mongodb.uri` in config or `OPENCLAW_MONGODB_URI` in the environment.",
        ].join(" "),
      );
    }
    const deploymentProfile: MemoryMongoDBDeploymentProfile =
      mongoCfg?.deploymentProfile ?? DEFAULT_MONGODB_PROFILE;
    const embeddingMode = mongoCfg?.embeddingMode ?? DEFAULT_MONGODB_EMBEDDING_MODE;

    if (deploymentProfile === "community-bare" && embeddingMode === "automated") {
      throw new Error(
        [
          'embeddingMode "automated" is not supported for deploymentProfile "community-bare".',
          'Use embeddingMode "managed" or switch to deploymentProfile "community-mongot".',
        ].join(" "),
      );
    }
    if (
      (deploymentProfile === "atlas-default" || deploymentProfile === "atlas-m0") &&
      embeddingMode === "automated"
    ) {
      throw new Error(
        [
          'embeddingMode "automated" is not supported for Atlas deployment profiles in ClawMongo.',
          'Use embeddingMode "managed" for Atlas deployments.',
        ].join(" "),
      );
    }

    const result: ResolvedMemoryBackendConfig = {
      backend: "mongodb",
      citations,
      mongodb: {
        uri,
        database: mongoCfg?.database ?? "openclaw",
        collectionPrefix: mongoCfg?.collectionPrefix ?? `openclaw_${sanitizeName(params.agentId)}_`,
        deploymentProfile,
        embeddingMode,
        fusionMethod: mongoCfg?.fusionMethod ?? "scoreFusion",
        quantization: mongoCfg?.quantization ?? "none",
        watchDebounceMs:
          typeof mongoCfg?.watchDebounceMs === "number" &&
          Number.isFinite(mongoCfg.watchDebounceMs) &&
          mongoCfg.watchDebounceMs >= 0
            ? Math.floor(mongoCfg.watchDebounceMs)
            : 500,
        numDimensions:
          typeof mongoCfg?.numDimensions === "number" &&
          Number.isFinite(mongoCfg.numDimensions) &&
          mongoCfg.numDimensions > 0
            ? Math.floor(mongoCfg.numDimensions)
            : 1024,
        maxPoolSize:
          typeof mongoCfg?.maxPoolSize === "number" &&
          Number.isFinite(mongoCfg.maxPoolSize) &&
          mongoCfg.maxPoolSize > 0
            ? Math.floor(mongoCfg.maxPoolSize)
            : 10,
        minPoolSize:
          typeof mongoCfg?.minPoolSize === "number" &&
          Number.isFinite(mongoCfg.minPoolSize) &&
          mongoCfg.minPoolSize >= 0
            ? Math.floor(mongoCfg.minPoolSize)
            : 2,
        embeddingCacheTtlDays:
          typeof mongoCfg?.embeddingCacheTtlDays === "number" &&
          Number.isFinite(mongoCfg.embeddingCacheTtlDays) &&
          mongoCfg.embeddingCacheTtlDays >= 0
            ? Math.floor(mongoCfg.embeddingCacheTtlDays)
            : 30,
        memoryTtlDays:
          typeof mongoCfg?.memoryTtlDays === "number" &&
          Number.isFinite(mongoCfg.memoryTtlDays) &&
          mongoCfg.memoryTtlDays >= 0
            ? Math.floor(mongoCfg.memoryTtlDays)
            : 0,
        enableChangeStreams: mongoCfg?.enableChangeStreams === true,
        changeStreamDebounceMs:
          typeof mongoCfg?.changeStreamDebounceMs === "number" &&
          Number.isFinite(mongoCfg.changeStreamDebounceMs) &&
          mongoCfg.changeStreamDebounceMs >= 0
            ? Math.floor(mongoCfg.changeStreamDebounceMs)
            : 1000,
        connectTimeoutMs:
          typeof mongoCfg?.connectTimeoutMs === "number" &&
          Number.isFinite(mongoCfg.connectTimeoutMs) &&
          mongoCfg.connectTimeoutMs > 0
            ? Math.floor(mongoCfg.connectTimeoutMs)
            : 10_000,
        numCandidates: Math.min(
          typeof mongoCfg?.numCandidates === "number" &&
            Number.isFinite(mongoCfg.numCandidates) &&
            mongoCfg.numCandidates > 0
            ? Math.floor(mongoCfg.numCandidates)
            : 200,
          10_000, // F1: hard cap at MongoDB's max numCandidates
        ),
        maxSessionChunks:
          typeof mongoCfg?.maxSessionChunks === "number" &&
          Number.isFinite(mongoCfg.maxSessionChunks) &&
          mongoCfg.maxSessionChunks > 0
            ? Math.floor(mongoCfg.maxSessionChunks)
            : 50,
        kb: {
          enabled: mongoCfg?.kb?.enabled !== false,
          chunking: {
            tokens:
              typeof mongoCfg?.kb?.chunking?.tokens === "number" &&
              Number.isFinite(mongoCfg.kb.chunking.tokens) &&
              mongoCfg.kb.chunking.tokens > 0
                ? Math.floor(mongoCfg.kb.chunking.tokens)
                : 600,
            overlap:
              typeof mongoCfg?.kb?.chunking?.overlap === "number" &&
              Number.isFinite(mongoCfg.kb.chunking.overlap) &&
              mongoCfg.kb.chunking.overlap >= 0
                ? Math.floor(mongoCfg.kb.chunking.overlap)
                : 100,
          },
          autoImportPaths: Array.isArray(mongoCfg?.kb?.autoImportPaths)
            ? mongoCfg.kb.autoImportPaths.filter(
                (p): p is string => typeof p === "string" && p.trim().length > 0,
              )
            : [],
          maxDocumentSize:
            typeof mongoCfg?.kb?.maxDocumentSize === "number" &&
            Number.isFinite(mongoCfg.kb.maxDocumentSize) &&
            mongoCfg.kb.maxDocumentSize > 0
              ? Math.floor(mongoCfg.kb.maxDocumentSize)
              : 10 * 1024 * 1024,
          autoRefreshHours:
            typeof mongoCfg?.kb?.autoRefreshHours === "number" &&
            Number.isFinite(mongoCfg.kb.autoRefreshHours) &&
            mongoCfg.kb.autoRefreshHours >= 0
              ? mongoCfg.kb.autoRefreshHours
              : 24,
        },
        relevance: {
          enabled: mongoCfg?.relevance?.enabled !== false,
          telemetry: {
            enabled: mongoCfg?.relevance?.telemetry?.enabled !== false,
            baseSampleRate:
              typeof mongoCfg?.relevance?.telemetry?.baseSampleRate === "number" &&
              Number.isFinite(mongoCfg.relevance.telemetry.baseSampleRate)
                ? Math.min(1, Math.max(0, mongoCfg.relevance.telemetry.baseSampleRate))
                : 0.01,
            adaptive: {
              enabled: mongoCfg?.relevance?.telemetry?.adaptive?.enabled !== false,
              maxSampleRate:
                typeof mongoCfg?.relevance?.telemetry?.adaptive?.maxSampleRate === "number" &&
                Number.isFinite(mongoCfg.relevance.telemetry.adaptive.maxSampleRate)
                  ? Math.min(1, Math.max(0, mongoCfg.relevance.telemetry.adaptive.maxSampleRate))
                  : 0.1,
              minWindowSize:
                typeof mongoCfg?.relevance?.telemetry?.adaptive?.minWindowSize === "number" &&
                Number.isFinite(mongoCfg.relevance.telemetry.adaptive.minWindowSize) &&
                mongoCfg.relevance.telemetry.adaptive.minWindowSize > 0
                  ? Math.floor(mongoCfg.relevance.telemetry.adaptive.minWindowSize)
                  : 200,
            },
            persistRawExplain: mongoCfg?.relevance?.telemetry?.persistRawExplain !== false,
            queryPrivacyMode:
              mongoCfg?.relevance?.telemetry?.queryPrivacyMode === "raw" ||
              mongoCfg?.relevance?.telemetry?.queryPrivacyMode === "none"
                ? mongoCfg.relevance.telemetry.queryPrivacyMode
                : "redacted-hash",
          },
          retention: {
            days:
              typeof mongoCfg?.relevance?.retention?.days === "number" &&
              Number.isFinite(mongoCfg.relevance.retention.days) &&
              mongoCfg.relevance.retention.days > 0
                ? Math.floor(mongoCfg.relevance.retention.days)
                : 14,
          },
          benchmark: {
            enabled: mongoCfg?.relevance?.benchmark?.enabled !== false,
            datasetPath:
              typeof mongoCfg?.relevance?.benchmark?.datasetPath === "string" &&
              mongoCfg.relevance.benchmark.datasetPath.trim().length > 0
                ? resolveUserPath(mongoCfg.relevance.benchmark.datasetPath.trim())
                : resolveUserPath(DEFAULT_RELEVANCE_DATASET),
          },
        },
      },
    };
    if (
      result.mongodb!.relevance.telemetry.adaptive.maxSampleRate <
      result.mongodb!.relevance.telemetry.baseSampleRate
    ) {
      result.mongodb!.relevance.telemetry.adaptive.maxSampleRate =
        result.mongodb!.relevance.telemetry.baseSampleRate;
    }

    // F22: numDimensions validation warning — check if configured dimensions
    // match known model dimensions for the default embedding model
    const resolvedNumDims = result.mongodb!.numDimensions;
    const defaultModel = "voyage-4-large";
    const expectedDims = KNOWN_MODEL_DIMENSIONS[defaultModel];
    if (mongoCfg?.numDimensions && expectedDims && resolvedNumDims !== expectedDims) {
      log.warn(
        `numDimensions=${resolvedNumDims} may not match expected dimensions for ${defaultModel} (${expectedDims}). ` +
          "Mismatched dimensions will cause vector search errors.",
      );
    }

    return result;
  }

  throw new Error(`Unsupported memory backend: ${String(backend)}`);
}

function buildLegacyBackendError(backend: Exclude<MemoryBackend, "mongodb">): string {
  return [
    `Legacy memory backend "${backend}" is no longer supported in ClawMongo.`,
    "ClawMongo is MongoDB-only.",
    "Remove `memory.backend`, configure `memory.mongodb.uri`, and keep all memory flows on MongoDB.",
  ].join(" ");
}
