import fsSync from "node:fs";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
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
    // resolveMemoryBackendConfig throws when mongodb URI is missing
    if (cfg.memory?.backend === "mongodb") {
      note(
        [
          "MongoDB memory backend is configured but no URI is set.",
          "",
          "Fix (pick one):",
          `- Set URI in config: ${formatCliCommand("openclaw config set memory.mongodb.uri mongodb+srv://...")}`,
          "- Set OPENCLAW_MONGODB_URI environment variable",
          `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
        ].join("\n"),
        "Memory (MongoDB)",
      );
    }
    return;
  }

  if (backendConfig.backend !== "mongodb" || !backendConfig.mongodb) {
    return;
  }

  const { uri, deploymentProfile } = backendConfig.mongodb;

  // Connection test with timeout
  let MongoClient: typeof import("mongodb").MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    note(
      [
        "MongoDB driver is not installed.",
        "",
        "Fix (pick one):",
        "- Install: pnpm add mongodb",
        `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
      ].join("\n"),
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
        lines.push("Upgrade: ./docker/mongodb/start.sh fullstack");
      }

      note(lines.join("\n"), "Memory (MongoDB)");
    } catch {
      // Topology detection failed -- show basic connected message
      note(`MongoDB connected. Profile: ${deploymentProfile}.`, "Memory (MongoDB)");
    }

    // Check embedding coverage (embeddingStatus) while connection is still open
    await noteEmbeddingCoverage(client, backendConfig.mongodb);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        `MongoDB connection failed: ${message}`,
        "",
        "Fix (pick one):",
        "- Check that MongoDB is running and accessible",
        "- Verify URI credentials and network access",
        `- Test manually: mongosh "${redactDoctorUri(uri)}"`,
        `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
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
  const hasRemoteApiKey = Boolean(resolved?.remote?.apiKey?.trim());

  if (!resolved) {
    note("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }

  // QMD backend handles embeddings internally (e.g. embeddinggemma) — no
  // separate embedding provider is needed. Skip the provider check entirely.
  const backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
  if (backendConfig.backend === "qmd") {
    return;
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      if (hasLocalEmbeddings(resolved.local)) {
        return; // local model file exists
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
      "Memory search is enabled but no embedding provider is configured.",
      "Semantic recall will not work without an embedding provider.",
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

function hasLocalEmbeddings(local: { modelPath?: string }): boolean {
  const modelPath = local.modelPath?.trim();
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
  provider: "openai" | "gemini" | "voyage" | "mistral",
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
