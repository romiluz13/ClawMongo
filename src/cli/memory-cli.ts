import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";
import { withProgress, withProgressTotals } from "./progress.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;

type RelevanceSourceScope = "all" | "memory" | "kb" | "structured";

type RelevanceCapableManager = MemoryManager & {
  relevanceExplain: (params: {
    query: string;
    sourceScope?: RelevanceSourceScope;
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
    deep?: boolean;
  }) => Promise<{
    runId?: string;
    latencyMs: number;
    sourceScope: RelevanceSourceScope;
    health: "ok" | "degraded" | "insufficient-data";
    fallbackPath?: string;
    sampleRate: number;
    artifacts: Array<{
      artifactType: "searchExplain" | "vectorExplain" | "fusionExplain" | "scoreDetails" | "trace";
      summary: Record<string, unknown>;
      rawExplain?: unknown;
      compression?: "none";
    }>;
    results: Awaited<ReturnType<MemoryManager["search"]>>;
  }>;
  relevanceBenchmark: (params?: {
    datasetPath?: string;
    maxResults?: number;
    minScore?: number;
  }) => Promise<{
    datasetVersion: string;
    cases: number;
    hitRate: number;
    emptyRate: number;
    avgTopScore: number;
    p95LatencyMs: number;
    regressions: Array<{
      metricName: string;
      baseline: number;
      current: number;
      delta: number;
      severity: "low" | "medium" | "high";
    }>;
  }>;
  relevanceReport: (params?: { windowMs?: number }) => Promise<{
    health: "ok" | "degraded" | "insufficient-data";
    runs: number;
    sampledRuns: number;
    emptyRate: number;
    avgTopScore: number;
    fallbackRate: number;
    lastRegressionAt?: string;
    profileCapabilities: {
      textExplain: boolean;
      vectorExplain: boolean;
      fusionExplain: boolean;
    };
  }>;
  relevanceSampleRate: () => {
    enabled: boolean;
    current: number;
    base: number;
    max: number;
    windowSize: number;
    degradedSignals: number;
  };
};

type MemorySourceName = "memory" | "sessions";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

function hasRelevanceCapability(manager: MemoryManager): manager is RelevanceCapableManager {
  return (
    typeof (manager as Partial<RelevanceCapableManager>).relevanceExplain === "function" &&
    typeof (manager as Partial<RelevanceCapableManager>).relevanceBenchmark === "function" &&
    typeof (manager as Partial<RelevanceCapableManager>).relevanceReport === "function" &&
    typeof (manager as Partial<RelevanceCapableManager>).relevanceSampleRate === "function"
  );
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  if (alt.issue) {
    issues.push(alt.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
      if (alt.exists) {
        files.add(altMemoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function summarizeQmdIndexArtifact(manager: MemoryManager): Promise<string | null> {
  const status = manager.status?.();
  if (!status || status.backend !== "qmd") {
    return null;
  }
  const dbPath = status.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
    }
    throw new Error(
      `QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`,
      { cause: err },
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
  }
  return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "default" : "status";
    await withManager<MemoryManager>({
      getManager: () => getMemorySearchManager({ cfg, agentId, purpose: managerPurpose }),
      onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
      onCloseError: (err) =>
        defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
      close: async (manager) => {
        await manager.close?.();
      },
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            })
          : undefined;
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    const relevance =
      status.custom &&
      typeof status.custom === "object" &&
      "relevance" in status.custom &&
      status.custom.relevance &&
      typeof status.custom.relevance === "object"
        ? (status.custom.relevance as {
            enabled?: boolean;
            telemetry?: { state?: string };
            sampleRate?: { current?: number };
            health?: string;
            lastRegressionAt?: string;
            profileCapabilities?: {
              textExplain?: boolean;
              vectorExplain?: boolean;
              fusionExplain?: boolean;
            };
          })
        : null;
    if (relevance) {
      lines.push(label("Relevance"));
      lines.push(`  ${label("enabled")} ${relevance.enabled ? success("yes") : muted("no")}`);
      lines.push(`  ${label("telemetry")} ${info(relevance.telemetry?.state ?? "unknown")}`);
      lines.push(
        `  ${label("sample rate")} ${info(
          typeof relevance.sampleRate?.current === "number"
            ? relevance.sampleRate.current.toFixed(4)
            : "n/a",
        )}`,
      );
      lines.push(`  ${label("health")} ${info(relevance.health ?? "unknown")}`);
      if (relevance.lastRegressionAt) {
        lines.push(`  ${label("last regression")} ${info(relevance.lastRegressionAt)}`);
      }
      if (relevance.profileCapabilities) {
        lines.push(
          `  ${label("capabilities")} ${info(
            `textExplain=${Boolean(relevance.profileCapabilities.textExplain)} ` +
              `vectorExplain=${Boolean(relevance.profileCapabilities.vectorExplain)} ` +
              `fusionExplain=${Boolean(relevance.profileCapabilities.fusionExplain)}`,
          )}`,
        );
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

type MemorySmokeResult = {
  agentId: string;
  backend: string;
  statusBackend?: string;
  sync: "ok" | "skipped" | "failed";
  writeReadRoundtrip: "ok" | "failed";
  retrieval: "ok" | "failed";
  details: string[];
};

async function runMemorySmoke(opts: MemoryCommandOptions): Promise<void> {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  const details: string[] = [];

  let resolvedBackend: ReturnType<typeof resolveMemoryBackendConfig>;
  try {
    resolvedBackend = resolveMemoryBackendConfig({ cfg, agentId });
  } catch (err) {
    const message = formatErrorMessage(err);
    const result: MemorySmokeResult = {
      agentId,
      backend: "unknown",
      sync: "failed",
      writeReadRoundtrip: "failed",
      retrieval: "failed",
      details: [`backend resolution failed: ${message}`],
    };
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } else {
      defaultRuntime.error(`Memory smoke failed (${agentId}): ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (resolvedBackend.backend !== "mongodb") {
    const message = `memory backend is "${resolvedBackend.backend}", expected "mongodb"`;
    const result: MemorySmokeResult = {
      agentId,
      backend: resolvedBackend.backend,
      sync: "failed",
      writeReadRoundtrip: "failed",
      retrieval: "failed",
      details: [message],
    };
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } else {
      defaultRuntime.error(`Memory smoke failed (${agentId}): ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  const lookup = await getMemorySearchManager({ cfg, agentId, purpose: "default" });
  if (!lookup.manager) {
    const message = lookup.error ?? "mongodb memory manager unavailable";
    const result: MemorySmokeResult = {
      agentId,
      backend: resolvedBackend.backend,
      sync: "failed",
      writeReadRoundtrip: "failed",
      retrieval: "failed",
      details: [message],
    };
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } else {
      defaultRuntime.error(`Memory smoke failed (${agentId}): ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  const manager = lookup.manager;
  const statusBackend = manager.status().backend;
  if (statusBackend !== "mongodb") {
    const message = `runtime memory backend is "${statusBackend}", expected "mongodb"`;
    const result: MemorySmokeResult = {
      agentId,
      backend: resolvedBackend.backend,
      statusBackend,
      sync: "failed",
      writeReadRoundtrip: "failed",
      retrieval: "failed",
      details: [message],
    };
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } else {
      defaultRuntime.error(`Memory smoke failed (${agentId}): ${message}`);
    }
    await manager.close?.().catch(() => {});
    process.exitCode = 1;
    return;
  }

  let sync: MemorySmokeResult["sync"] = "skipped";
  let writeReadRoundtrip: MemorySmokeResult["writeReadRoundtrip"] = "failed";
  let retrieval: MemorySmokeResult["retrieval"] = "failed";

  try {
    if (manager.sync) {
      await manager.sync({ reason: "smoke" });
      sync = "ok";
      details.push("sync ok");
    } else {
      details.push("sync skipped (backend does not expose sync)");
    }

    const writer = manager as MemoryManager & {
      writeStructuredMemory?: (entry: {
        type: string;
        key: string;
        value: string;
        context?: string;
        confidence?: number;
      }) => Promise<{ upserted: boolean; id: string }>;
    };
    if (typeof writer.writeStructuredMemory !== "function") {
      throw new Error("runtime manager missing structured memory write capability");
    }

    const marker = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payload = `clawmongo smoke marker ${marker}`;
    await writer.writeStructuredMemory({
      type: "custom",
      key: marker,
      value: payload,
      context: "memory smoke validation",
      confidence: 1,
    });
    writeReadRoundtrip = "ok";
    details.push(`write ok (${marker})`);

    const results = await manager.search(marker, { maxResults: 5, minScore: 0 });
    const matched = results.some(
      (result) =>
        result.snippet.includes(marker) ||
        result.snippet.includes(payload) ||
        result.snippet.includes("clawmongo smoke marker") ||
        result.path.includes(marker),
    );
    if (!matched) {
      throw new Error("retrieval check failed: marker not found in memory search results");
    }
    retrieval = "ok";
    details.push("retrieval ok");
  } catch (err) {
    const message = formatErrorMessage(err);
    details.push(message);
    if (sync === "ok" && writeReadRoundtrip === "ok") {
      retrieval = "failed";
    } else if (sync === "ok") {
      writeReadRoundtrip = "failed";
      retrieval = "failed";
    } else {
      sync = "failed";
      writeReadRoundtrip = "failed";
      retrieval = "failed";
    }
    process.exitCode = 1;
  } finally {
    await manager.close?.().catch(() => {});
  }

  const result: MemorySmokeResult = {
    agentId,
    backend: resolvedBackend.backend,
    statusBackend,
    sync,
    writeReadRoundtrip,
    retrieval,
    details,
  };
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  if (process.exitCode === 1) {
    defaultRuntime.error(`Memory smoke failed (${agentId}).`);
    for (const detail of details) {
      defaultRuntime.error(`  - ${detail}`);
    }
    return;
  }
  defaultRuntime.log(`Memory smoke passed (${agentId}).`);
  for (const detail of details) {
    defaultRuntime.log(`  - ${detail}`);
  }
}

function parseWindowMs(raw?: string): number {
  const value = raw?.trim();
  if (!value) {
    return 24 * 60 * 60 * 1000;
  }
  if (value === "24h") {
    return 24 * 60 * 60 * 1000;
  }
  if (value === "7d") {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 24 * 60 * 60 * 1000;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    return 24 * 60 * 60 * 1000;
  }
  if (unit === "s") {
    return amount * 1000;
  }
  if (unit === "m") {
    return amount * 60 * 1000;
  }
  if (unit === "h") {
    return amount * 60 * 60 * 1000;
  }
  return amount * 24 * 60 * 60 * 1000;
}

async function runRelevanceExplain(
  query: string,
  opts: MemoryCommandOptions & {
    source?: RelevanceSourceScope;
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
    deep?: boolean;
  },
): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager({ cfg, agentId, purpose: "default" }),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: async (manager) => {
      if (!hasRelevanceCapability(manager)) {
        defaultRuntime.error("Relevance diagnostics are available only on MongoDB backend.");
        process.exitCode = 1;
        return;
      }
      try {
        const result = await manager.relevanceExplain({
          query,
          sourceScope: opts.source ?? "all",
          sessionKey: opts.sessionKey,
          maxResults: opts.maxResults,
          minScore: opts.minScore,
          deep: Boolean(opts.deep),
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`Relevance explain (${agentId})`);
        defaultRuntime.log(`  runId: ${result.runId ?? "n/a"}`);
        defaultRuntime.log(`  source: ${result.sourceScope}`);
        defaultRuntime.log(`  health: ${result.health}`);
        defaultRuntime.log(`  sampleRate: ${result.sampleRate.toFixed(4)}`);
        defaultRuntime.log(`  latencyMs: ${result.latencyMs}`);
        if (result.fallbackPath) {
          defaultRuntime.log(`  fallbackPath: ${result.fallbackPath}`);
        }
        defaultRuntime.log(`  artifacts: ${result.artifacts.length}`);
        defaultRuntime.log(`  results: ${result.results.length}`);
      } catch (err) {
        defaultRuntime.error(`Relevance explain failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    },
  });
}

async function runRelevanceBenchmark(
  opts: MemoryCommandOptions & { dataset?: string; maxResults?: number; minScore?: number },
): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager({ cfg, agentId, purpose: "default" }),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: async (manager) => {
      if (!hasRelevanceCapability(manager)) {
        defaultRuntime.error("Relevance benchmark is available only on MongoDB backend.");
        process.exitCode = 1;
        return;
      }
      try {
        const result = await manager.relevanceBenchmark({
          datasetPath: opts.dataset,
          maxResults: opts.maxResults,
          minScore: opts.minScore,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`Relevance benchmark (${agentId})`);
        defaultRuntime.log(`  datasetVersion: ${result.datasetVersion}`);
        defaultRuntime.log(`  cases: ${result.cases}`);
        defaultRuntime.log(`  hitRate: ${(result.hitRate * 100).toFixed(2)}%`);
        defaultRuntime.log(`  emptyRate: ${(result.emptyRate * 100).toFixed(2)}%`);
        defaultRuntime.log(`  avgTopScore: ${result.avgTopScore.toFixed(4)}`);
        defaultRuntime.log(`  p95LatencyMs: ${result.p95LatencyMs.toFixed(2)}`);
        if (result.regressions.length > 0) {
          defaultRuntime.log("  regressions:");
          for (const regression of result.regressions) {
            defaultRuntime.log(
              `    - ${regression.metricName}: baseline=${regression.baseline.toFixed(4)} current=${regression.current.toFixed(4)} delta=${regression.delta.toFixed(4)} severity=${regression.severity}`,
            );
          }
        }
      } catch (err) {
        defaultRuntime.error(`Relevance benchmark failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    },
  });
}

async function runRelevanceReport(opts: MemoryCommandOptions & { window?: string }): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager({ cfg, agentId, purpose: "default" }),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: async (manager) => {
      if (!hasRelevanceCapability(manager)) {
        defaultRuntime.error("Relevance report is available only on MongoDB backend.");
        process.exitCode = 1;
        return;
      }
      try {
        const report = await manager.relevanceReport({ windowMs: parseWindowMs(opts.window) });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(report, null, 2));
          return;
        }
        defaultRuntime.log(`Relevance report (${agentId})`);
        defaultRuntime.log(`  health: ${report.health}`);
        defaultRuntime.log(`  runs: ${report.runs}`);
        defaultRuntime.log(`  sampledRuns: ${report.sampledRuns}`);
        defaultRuntime.log(`  emptyRate: ${(report.emptyRate * 100).toFixed(2)}%`);
        defaultRuntime.log(`  avgTopScore: ${report.avgTopScore.toFixed(4)}`);
        defaultRuntime.log(`  fallbackRate: ${(report.fallbackRate * 100).toFixed(2)}%`);
        if (report.lastRegressionAt) {
          defaultRuntime.log(`  lastRegressionAt: ${report.lastRegressionAt}`);
        }
        defaultRuntime.log(
          `  capabilities: textExplain=${report.profileCapabilities.textExplain} vectorExplain=${report.profileCapabilities.vectorExplain} fusionExplain=${report.profileCapabilities.fusionExplain}`,
        );
      } catch (err) {
        defaultRuntime.error(`Relevance report failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    },
  });
}

async function runRelevanceSampleRate(opts: MemoryCommandOptions): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager({ cfg, agentId, purpose: "default" }),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: async (manager) => {
      if (!hasRelevanceCapability(manager)) {
        defaultRuntime.error("Relevance sample-rate is available only on MongoDB backend.");
        process.exitCode = 1;
        return;
      }
      const state = manager.relevanceSampleRate();
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(state, null, 2));
        return;
      }
      defaultRuntime.log(`Relevance sample rate (${agentId})`);
      defaultRuntime.log(`  enabled: ${state.enabled}`);
      defaultRuntime.log(`  current: ${state.current.toFixed(4)}`);
      defaultRuntime.log(`  base: ${state.base.toFixed(4)}`);
      defaultRuntime.log(`  max: ${state.max.toFixed(4)}`);
      defaultRuntime.log(`  windowSize: ${state.windowSize}`);
      defaultRuntime.log(`  degradedSignals: ${state.degradedSignals}`);
    },
  });
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Search, inspect, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw memory status", "Show index and provider status."],
          ["openclaw memory index --force", "Force a full reindex."],
          [
            'openclaw memory relevance explain --query "deployment notes" --deep',
            "Run explain-driven relevance diagnostics for one query.",
          ],
          [
            "openclaw memory smoke",
            "Run MongoDB memory smoke checks (sync + write/read + retrieval).",
          ],
          ['openclaw memory search "deployment notes"', "Search indexed memory entries."],
          ["openclaw memory status --json", "Output machine-readable JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: async (manager) => {
            await manager.close?.();
          },
          run: async (manager) => {
            try {
              const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = (status.sources ?? []).map((source) =>
                  formatSourceLabel(source, status.workspaceDir ?? "", agentId),
                );
                const extraPaths = status.workspaceDir
                  ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
                  : [];
                const requestedProvider = status.requestedProvider ?? status.provider;
                const modelLabel = status.model ?? status.provider;
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(modelLabel)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) {
                  return null;
                }
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) {
                  return null;
                }
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              if (!syncFn) {
                defaultRuntime.log("Memory backend does not support manual reindex.");
                return;
              }
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await syncFn({
                      reason: "cli",
                      force: Boolean(opts.force),
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) {
                          lastLabel = syncUpdate.label;
                        }
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
              if (qmdIndexSummary) {
                defaultRuntime.log(qmdIndexSummary);
              }
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        query: string,
        opts: MemoryCommandOptions & {
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: async (manager) => {
            await manager.close?.();
          },
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );

  const relevance = memory
    .command("relevance")
    .description("Explain-driven relevance diagnostics and telemetry");

  relevance
    .command("explain")
    .description("Run explain diagnostics for a single query")
    .requiredOption("--query <text>", "Query text")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--source <scope>", "Scope: all|memory|kb|structured", "all")
    .option("--session-key <key>", "Session key override")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--deep", "Include raw explain artifacts")
    .option("--json", "Print JSON")
    .action(
      async (
        opts: MemoryCommandOptions & {
          query: string;
          source?: string;
          sessionKey?: string;
          maxResults?: number;
          minScore?: number;
          deep?: boolean;
        },
      ) => {
        const sourceScope = (opts.source ?? "all").trim() as RelevanceSourceScope;
        if (!["all", "memory", "kb", "structured"].includes(sourceScope)) {
          defaultRuntime.error(
            `Invalid --source value "${opts.source}". Expected one of: all, memory, kb, structured.`,
          );
          process.exitCode = 1;
          return;
        }
        await runRelevanceExplain(opts.query, {
          ...opts,
          source: sourceScope,
        });
      },
    );

  relevance
    .command("benchmark")
    .description("Run relevance benchmark dataset and persist regressions")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--dataset <path>", "Dataset JSONL path")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        opts: MemoryCommandOptions & {
          dataset?: string;
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        await runRelevanceBenchmark(opts);
      },
    );

  relevance
    .command("report")
    .description("Show relevance telemetry report for a time window")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--window <range>", "Window: 24h|7d|<number><s|m|h|d>", "24h")
    .option("--json", "Print JSON")
    .action(async (opts: MemoryCommandOptions & { window?: string }) => {
      await runRelevanceReport(opts);
    });

  relevance
    .command("sample-rate")
    .description("Print current adaptive relevance telemetry sample rate")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: MemoryCommandOptions) => {
      await runRelevanceSampleRate(opts);
    });

  memory
    .command("smoke")
    .description("Run MongoDB memory smoke checks (sync + write/read + retrieval)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemorySmoke(opts);
    });
}
