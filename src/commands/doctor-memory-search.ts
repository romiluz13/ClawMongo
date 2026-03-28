import fsSync from "node:fs";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { DEFAULT_LOCAL_MODEL } from "../memory/embeddings.js";
import { hasConfiguredMemorySecretInput } from "../memory/secret-input.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

/**
 * Check MongoDB backend health when backend=mongodb.
 * Validates URI presence and attempts a connection test with timeout.
 */
export async function noteMongoDBBackendHealth(cfg: OpenClawConfig): Promise<void> {
  const agentId = resolveDefaultAgentId(cfg);
  let backendConfig;
  try {
    backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
  } catch {
    note(
      [
        "MongoDB memory is active but no URI is set.",
        "",
        "Fix:",
        `- Set URI in config: ${formatCliCommand("openclaw config set memory.mongodb.uri mongodb://localhost:27017/openclaw?replicaSet=rs0")}`,
        "- Or set OPENCLAW_MONGODB_URI in the environment",
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  }

  const mongoConfig = backendConfig.mongodb;
  if (!mongoConfig) {
    note(
      [
        "MongoDB memory is active but the resolved MongoDB config is incomplete.",
        "",
        "Fix:",
        `- Set URI in config: ${formatCliCommand("openclaw config set memory.mongodb.uri mongodb://localhost:27017/openclaw?replicaSet=rs0")}`,
        "- Or set OPENCLAW_MONGODB_URI in the environment",
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  }

  const { uri, deploymentProfile } = mongoConfig;

  // Connection test with timeout
  let MongoClient: typeof import("mongodb").MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    note(
      ["MongoDB driver is not installed.", "", "Fix:", "- Install: pnpm add mongodb"].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });

    // Detect topology while connection is still open
    try {
      const { detectTopology, topologyToTier, tierFeatures } =
        await import("../memory/mongodb-topology.js");
      const topology = await detectTopology(client.db());
      const tier = topologyToTier(topology);
      const features = tierFeatures(tier);

      const lines = [
        `MongoDB connected. Profile: ${deploymentProfile}.`,
        `Detected topology: ${tier} (v${topology.serverVersion})`,
      ];

      if (features.unavailable.length > 0) {
        lines.push("");
        lines.push("Missing features (upgrade to enable):");
        lines.push(...features.unavailable.map((f) => `  - ${f}`));
        lines.push("");
        lines.push("Upgrade: ./docker/mongodb/start-preview.sh (mongodb-atlas-local:preview)");
      }

      note(lines.join("\n"), "Memory (MongoDB)");

      // --- mongot health ---
      if (!topology.hasMongot) {
        note(
          [
            "mongot is not reachable. Vector search and auto-embeddings are unavailable.",
            "",
            "Fix: Start the atlas-local container which bundles mongot:",
            "  ./docker/mongodb/start-preview.sh",
          ].join("\n"),
          "Memory (mongot)",
        );
      } else {
        // mongot present -- check Voyage AI key
        if (!process.env.VOYAGE_API_KEY) {
          note(
            [
              "mongot is reachable but VOYAGE_API_KEY is not set in the environment.",
              "Auto-embeddings require a Voyage AI API key.",
              "",
              "Fix: Set VOYAGE_API_KEY and restart the container:",
              "  VOYAGE_API_KEY=your-key ./docker/mongodb/start-preview.sh",
            ].join("\n"),
            "Memory (Auto-Embed)",
          );
        }
      }

      // --- vector search index check ---
      await noteVectorSearchIndexHealth(
        client.db(mongoConfig.database),
        mongoConfig.collectionPrefix,
        topology.hasMongot,
      );
    } catch {
      // Topology detection failed -- show basic connected message
      note(`MongoDB connected. Profile: ${deploymentProfile}.`, "Memory (MongoDB)");
    }

    // Check embedding coverage (embeddingStatus) while connection is still open
    await noteEmbeddingCoverage(client, mongoConfig);

    // Show memory recall diagnostic guidance
    const recallDiag = noteMemoryRecallDiagnostic({ backend: "mongodb" });
    if (recallDiag) {
      note(recallDiag.lines, recallDiag.title);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        `MongoDB connection failed: ${message}`,
        "",
        "Fix:",
        "- Check that MongoDB is running and accessible",
        "- Verify URI credentials and network access",
        `- Test manually: mongosh "${redactDoctorUri(uri)}"`,
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Check embedding coverage across all chunk collections.
 * Warns the user if any chunks have embeddingStatus: "failed".
 */
async function noteEmbeddingCoverage(
  client: import("mongodb").MongoClient,
  mongoCfg: { database: string; collectionPrefix: string },
): Promise<void> {
  try {
    const { getMemoryStats } = await import("../memory/mongodb-analytics.js");
    const db = client.db(mongoCfg.database);
    const stats = await getMemoryStats(db, mongoCfg.collectionPrefix);

    const { embeddingStatusCoverage } = stats;
    if (embeddingStatusCoverage.failed > 0) {
      note(
        [
          `Embedding coverage: ${embeddingStatusCoverage.failed} chunks have failed embeddings.`,
          `  Success: ${embeddingStatusCoverage.success}`,
          `  Failed: ${embeddingStatusCoverage.failed}`,
          `  Pending: ${embeddingStatusCoverage.pending}`,
          `  Total: ${embeddingStatusCoverage.total}`,
          "",
          "Failed chunks will be re-embedded on the next sync cycle.",
          "If failures persist, check your embedding provider configuration.",
        ].join("\n"),
        "Memory (Embedding Coverage)",
      );
    } else if (embeddingStatusCoverage.total > 0) {
      const successRate =
        embeddingStatusCoverage.total > 0
          ? Math.round((embeddingStatusCoverage.success / embeddingStatusCoverage.total) * 100)
          : 0;
      note(
        `Embedding coverage: ${successRate}% (${embeddingStatusCoverage.success}/${embeddingStatusCoverage.total} chunks).`,
        "Memory (Embedding Coverage)",
      );
    }
  } catch {
    // Silently skip — stats aggregation may fail on empty or new databases
  }
}

function redactDoctorUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username && parsed.username.length > 4) {
      parsed.username = parsed.username.slice(0, 4) + "...";
    }
    return parsed.toString();
  } catch {
    return uri.replace(/:([^@]+)@/, ":***@");
  }
}

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` — config-only, no network calls.
 */
export async function noteMemorySearchHealth(
  cfg: OpenClawConfig,
  opts?: {
    gatewayMemoryProbe?: {
      checked: boolean;
      ready: boolean;
      error?: string;
    };
  },
): Promise<void> {
  // Check MongoDB backend health first
  await noteMongoDBBackendHealth(cfg);

  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = hasConfiguredMemorySecretInput(resolved?.remote?.apiKey);

  if (!resolved) {
    note("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }

  try {
    resolveMemoryBackendConfig({ cfg, agentId });
  } catch {
    return;
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      if (hasLocalEmbeddings(resolved.local, true)) {
        // Model path looks valid (explicit file, hf: URL, or default model).
        // If a gateway probe is available and reports not-ready, warn anyway —
        // the model download or node-llama-cpp setup may have failed at runtime.
        if (opts?.gatewayMemoryProbe?.checked && !opts.gatewayMemoryProbe.ready) {
          const detail = opts.gatewayMemoryProbe.error?.trim();
          note(
            [
              'Memory search provider is set to "local" and a model path is configured,',
              "but the gateway reports local embeddings are not ready.",
              detail ? `Gateway probe: ${detail}` : null,
              "",
              `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
            ]
              .filter(Boolean)
              .join("\n"),
            "Memory search",
          );
        }
        return;
      }
      note(
        [
          'Memory search provider is set to "local" but no local model file was found.',
          "",
          "Fix (pick one):",
          `- Install node-llama-cpp and set a local model path in config`,
          `- Switch to a remote provider: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.provider openai")}`,
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    // Remote provider — check for API key
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      return;
    }
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      note(
        [
          `Memory search provider is set to "${resolved.provider}" but the API key was not found in the CLI environment.`,
          "The running gateway reports memory embeddings are ready for the default agent.",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
    const envVar = providerEnvVar(resolved.provider);
    note(
      [
        `Memory search provider is set to "${resolved.provider}" but no API key was found.`,
        `Semantic recall will not work without a valid API key.`,
        gatewayProbeWarning ? gatewayProbeWarning : null,
        "",
        "Fix (pick one):",
        `- Set ${envVar} in your environment`,
        `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
        `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }

  // provider === "auto": check all providers in resolution order
  if (hasLocalEmbeddings(resolved.local)) {
    return;
  }
  for (const provider of ["openai", "gemini", "voyage", "mistral"] as const) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider, cfg, agentDir))) {
      return;
    }
  }

  if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
    note(
      [
        'Memory search provider is set to "auto" but the API key was not found in the CLI environment.',
        "The running gateway reports memory embeddings are ready for the default agent.",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }
  const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);

  note(
    [
      "Memory search is enabled, but no embedding provider is ready.",
      "Semantic recall needs at least one embedding provider.",
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      "- Set OPENAI_API_KEY, GEMINI_API_KEY, VOYAGE_API_KEY, or MISTRAL_API_KEY in your environment",
      `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
      `- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
      `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      "",
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ].join("\n"),
    "Memory search",
  );
}

/**
 * Check whether local embeddings are available.
 *
 * When `useDefaultFallback` is true (explicit `provider: "local"`), an empty
 * modelPath is treated as available because the runtime falls back to
 * DEFAULT_LOCAL_MODEL (an auto-downloaded HuggingFace model).
 *
 * When false (provider: "auto"), we only consider local available if the user
 * explicitly configured a local file path — matching `canAutoSelectLocal()`
 * in the runtime, which skips local for empty/hf: model paths.
 */
function hasLocalEmbeddings(local: { modelPath?: string }, useDefaultFallback = false): boolean {
  const modelPath =
    local.modelPath?.trim() || (useDefaultFallback ? DEFAULT_LOCAL_MODEL : undefined);
  if (!modelPath) {
    return false;
  }
  // Remote/downloadable models (hf: or http:) aren't pre-resolved on disk,
  // so we can't confirm availability without a network call. Treat as
  // potentially available — the user configured it intentionally.
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return true;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

async function hasApiKeyForProvider(
  provider: "openai" | "gemini" | "voyage" | "mistral" | "ollama",
  cfg: OpenClawConfig,
  agentDir: string,
): Promise<boolean> {
  // Map embedding provider names to model-auth provider names
  const authProvider = provider === "gemini" ? "google" : provider;
  try {
    await resolveApiKeyForProvider({ provider: authProvider, cfg, agentDir });
    return true;
  } catch {
    return false;
  }
}

function providerEnvVar(provider: string): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "voyage":
      return "VOYAGE_API_KEY";
    default:
      return `${provider.toUpperCase()}_API_KEY`;
  }
}

function buildGatewayProbeWarning(
  probe:
    | {
        checked: boolean;
        ready: boolean;
        error?: string;
      }
    | undefined,
): string | null {
  if (!probe?.checked || probe.ready) {
    return null;
  }
  const detail = probe.error?.trim();
  return detail
    ? `Gateway memory probe for default agent is not ready: ${detail}`
    : "Gateway memory probe for default agent is not ready.";
}

/**
 * MongoDB-adapted three-failure-mode diagnostic for memory recall issues.
 * Based on the VelvetShark "Memory Masterclass" failure taxonomy, adapted
 * for ClawMongo where "Never Stored" is rare (runtime write path is automatic)
 * and "Not Retrieved" (agent didn't search MongoDB) is the primary failure mode.
 */
/**
 * Check vector search index existence on chunks collection.
 * Only runs when mongot is available.
 */
async function noteVectorSearchIndexHealth(
  db: import("mongodb").Db,
  prefix: string,
  hasMongot: boolean,
): Promise<void> {
  if (!hasMongot) {
    return; // Skip when mongot is not available
  }
  try {
    const indexSpecs = [
      {
        collectionName: `${prefix}chunks`,
        indexName: `${prefix}chunks_vector`,
        requiredPaths: ["agentId", "scope", "scopeRef", "sessionId", "timestamp", "updatedAt"],
      },
      {
        collectionName: `${prefix}kb_chunks`,
        indexName: `${prefix}kb_chunks_vector`,
        requiredPaths: ["docId", "path", "source"],
      },
      {
        collectionName: `${prefix}structured_memory`,
        indexName: `${prefix}structured_mem_vector`,
        requiredPaths: ["type", "tags", "agentId", "scope", "scopeRef", "state", "salience"],
      },
      {
        collectionName: `${prefix}procedures`,
        indexName: `${prefix}procedures_vector`,
        requiredPaths: ["intentTags", "agentId", "scope", "scopeRef", "state"],
      },
      {
        collectionName: `${prefix}query_cache`,
        indexName: `${prefix}query_cache_vector`,
        requiredPaths: ["requestSignature", "agentId", "scope", "scopeRef"],
      },
    ] as const;
    const foundIndexes: string[] = [];
    const missingIndexes: string[] = [];
    const parityIssues: string[] = [];

    for (const spec of indexSpecs) {
      const collection = db.collection(spec.collectionName);
      const indexes = (await collection.listSearchIndexes(spec.indexName).toArray()) as Array<{
        name?: string;
        type?: string;
        definition?: { fields?: Array<Record<string, unknown>> };
        latestDefinition?: { fields?: Array<Record<string, unknown>> };
        queryable?: boolean;
      }>;
      const current = indexes.find(
        (idx) => idx.type === "vectorSearch" && idx.name === spec.indexName,
      );
      if (!current) {
        missingIndexes.push(`${spec.indexName} on ${spec.collectionName}`);
        continue;
      }
      foundIndexes.push(`${spec.indexName} on ${spec.collectionName}`);

      if (current.queryable === false) {
        parityIssues.push(`${spec.indexName} exists but is not yet queryable`);
      }

      const fields = Array.isArray(current.latestDefinition?.fields)
        ? current.latestDefinition.fields
        : Array.isArray(current.definition?.fields)
          ? current.definition.fields
          : [];
      const filterPaths = new Set(
        fields
          .filter((field) => field.type === "filter" && typeof field.path === "string")
          .map((field) => String(field.path)),
      );
      const missingPaths = spec.requiredPaths.filter((path) => !filterPaths.has(path));
      if (missingPaths.length > 0) {
        parityIssues.push(
          `${spec.indexName} is missing required filter paths: ${missingPaths.join(", ")}`,
        );
      }
    }

    if (foundIndexes.length === 0) {
      note(
        [
          `Vector search indexes: none found for the expected ClawMongo MongoDB collections`,
          "",
          "Fix: Indexes are created automatically on first gateway start.",
          "Manual: clawmongo memory init --indexes",
        ].join("\n"),
        "Memory (Vector Indexes)",
      );
    } else {
      note(
        `Vector search indexes: ${foundIndexes.length}/${indexSpecs.length} expected indexes found\n${foundIndexes.map((name) => `- ${name}`).join("\n")}`,
        "Memory (Vector Indexes)",
      );
    }

    if (missingIndexes.length > 0 || parityIssues.length > 0) {
      note(
        [
          ...(missingIndexes.length > 0
            ? [`Missing indexes:`, ...missingIndexes.map((entry) => `- ${entry}`), ""]
            : []),
          ...(parityIssues.length > 0
            ? [`Parity issues:`, ...parityIssues.map((entry) => `- ${entry}`), ""]
            : []),
          "Fix: restart the gateway or run memory index bootstrap so ClawMongo can refresh the MongoDB Search and Vector Search definitions.",
        ].join("\n"),
        "Memory (Index Parity)",
      );
    }
  } catch {
    // listSearchIndexes may fail on older MongoDB or without mongot -- skip silently
  }
}

export function noteMemoryRecallDiagnostic(params: {
  backend?: string;
}): { title: string; lines: string } | null {
  if (params.backend !== "mongodb") {
    return null;
  }
  const lines = [
    "If the agent seems to forget things, check these three failure modes:",
    "",
    "1. Not Retrieved (most common)",
    "   The agent didn't call memory_search before answering.",
    "   Fix: Check that the MongoDB bridge section is in the system prompt.",
    "   Verify: Look for memory_search tool calls in the session transcript.",
    "",
    "2. Compaction Lost It",
    "   Important context was summarized away during auto-compaction.",
    "   Fix: Raise reserveTokensFloor (default: 40000) or compact before new instructions.",
    "   Verify: Check the compaction summary for missing context.",
    "",
    "3. Never Stored",
    "   In ClawMongo this is rare -- conversation turns auto-persist to MongoDB.",
    "   But structured facts (preferences, decisions) require explicit memory_write.",
    "   Fix: Check that memory_write is available and the flush is enabled.",
    "   Verify: Search MongoDB events/structured_memory collections directly.",
  ].join("\n");
  return { title: "Memory Recall Diagnostic", lines };
}
