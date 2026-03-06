import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawPackageName } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { confirm, select, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

function shouldShowNoDockerHint(reason: string): boolean {
  const lower = reason.toLowerCase();
  return lower.includes("docker") || lower.includes("compose");
}

function showNoDockerLocalHint(): void {
  note(
    [
      "Docker is optional. Local MongoDB works without Docker.",
      "",
      "Standalone (basic):",
      "  mongod --dbpath ./data/db --port 27017",
      "",
      "Replica set (recommended for transactions + change streams):",
      "  mongod --dbpath ./data/db --port 27017 --replSet rs0",
      '  mongosh --eval "rs.initiate()"',
      "",
      "Then continue with URI: mongodb://localhost:27017/openclaw",
    ].join("\n"),
    "Local MongoDB (No Docker)",
  );
}

/**
 * Memory section for the configure wizard.
 * ClawMongo is MongoDB-only, so this flow only configures MongoDB settings.
 */
export async function configureMemorySection(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  const packageName = await resolveOpenClawPackageName();
  const isClawMongo = packageName === "@romiluz/clawmongo";
  const currentBackend = nextConfig.memory?.backend ?? "mongodb";

  note(
    [
      "ClawMongo memory is MongoDB-only.",
      ...(currentBackend !== "mongodb"
        ? [`Legacy backend config detected: ${currentBackend}. It will be replaced by MongoDB.`]
        : []),
      ...(nextConfig.memory?.mongodb?.uri
        ? [`MongoDB URI: ${redactUri(nextConfig.memory.mongodb.uri)}`]
        : []),
      ...(nextConfig.memory?.mongodb?.deploymentProfile
        ? [`Profile: ${nextConfig.memory.mongodb.deploymentProfile}`]
        : []),
    ].join("\n"),
    "Memory",
  );

  // --- Auto-Setup: try Docker auto-start BEFORE manual URI prompt ---
  // Only for ClawMongo; upstream openclaw skips directly to manual URI
  if (isClawMongo) {
    try {
      const { attemptAutoSetup } = await import("../wizard/mongodb-auto-setup.js");
      const { createConfigurePrompterAdapter } =
        await import("../wizard/configure-prompter-adapter.js");
      const adapter = createConfigurePrompterAdapter();
      const autoResult = await attemptAutoSetup(adapter);
      if (autoResult.success) {
        // Auto-setup succeeded — skip manual URI prompt, use auto URI
        return configureMongoDBWithUri(nextConfig, runtime, isClawMongo, autoResult.uri);
      }
      // Auto-setup failed - show reason and fall through to manual
      note(autoResult.reason, "Auto-Setup");
      if (shouldShowNoDockerHint(autoResult.reason)) {
        showNoDockerLocalHint();
      }
    } catch {
      // Auto-setup module not available — fall through to manual
    }
  }

  // MongoDB configuration
  const existingUri = nextConfig.memory?.mongodb?.uri ?? "";
  const uriInput = guardCancel(
    await text({
      message: existingUri
        ? "MongoDB connection URI (leave blank to keep current)"
        : "MongoDB connection URI",
      placeholder: "mongodb://localhost:27017/openclaw?replicaSet=rs0",
      validate: (value) => {
        const trimmed = (value ?? "").trim();
        if (!trimmed && existingUri) {
          return undefined;
        } // keep existing
        if (!trimmed) {
          return "URI is required for MongoDB backend";
        }
        if (!trimmed.startsWith("mongodb://") && !trimmed.startsWith("mongodb+srv://")) {
          return "URI must start with mongodb:// or mongodb+srv://";
        }
        if (trimmed.includes(".mongodb.net")) {
          return "ClawMongo supports MongoDB Community + mongot only. Atlas URIs are not supported.";
        }
        return undefined;
      },
    }),
    runtime,
  );

  const uri = String(uriInput ?? "").trim() || existingUri;
  return configureMongoDBWithUri(nextConfig, runtime, isClawMongo, uri);
}

/**
 * Continue MongoDB configuration after a URI has been obtained
 * (either from auto-setup or manual prompt).
 */
async function configureMongoDBWithUri(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  isClawMongo: boolean,
  uri: string,
): Promise<OpenClawConfig> {
  let resolvedUri = uri;
  let detectedTier: import("../memory/mongodb-topology.js").DeploymentTier | undefined;

  try {
    const { MongoClient } = await import("mongodb");
    const testClient = new MongoClient(resolvedUri, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
    try {
      await testClient.connect();
      const { detectTopology, topologyToTier, tierFeatures, suggestConnectionString } =
        await import("../memory/mongodb-topology.js");
      const topology = await detectTopology(testClient.db());
      detectedTier = topologyToTier(topology);
      const features = tierFeatures(detectedTier);

      const suggestedUri = suggestConnectionString(topology, resolvedUri);
      if (suggestedUri !== resolvedUri) {
        note(
          `Detected replica set "${topology.replicaSetName}". Recommended URI:\n${suggestedUri}`,
          "Connection String",
        );
        resolvedUri = suggestedUri;
      }

      const lines: string[] = [
        `Detected: ${detectedTier} (MongoDB ${topology.serverVersion})`,
        "",
        "Required ClawMongo target:",
        "  + Community Edition 8.2+",
        "  + mongot enabled",
        "  + automated embeddings",
      ];
      if (features.available.length > 0) {
        lines.push("", "Currently available:");
        lines.push(...features.available.map((f) => `  + ${f}`));
      }
      if (features.unavailable.length > 0 || detectedTier !== "fullstack") {
        lines.push("", "Missing features (upgrade to enable):");
        lines.push(...features.unavailable.map((f) => `  - ${f}`));
        if (detectedTier !== "fullstack") {
          lines.push("  - Community + mongot full stack");
        }
        lines.push("", "Upgrade: ./docker/mongodb/start.sh fullstack");
      }
      note(lines.join("\n"), "MongoDB Topology");
    } finally {
      await testClient.close().catch(() => {});
    }
  } catch {
    // Connection failed - keep manual flow
  }
  const profile = "community-mongot";
  const embeddingMode = "automated";
  const existingEnableChangeStreams = nextConfig.memory?.mongodb?.enableChangeStreams;
  const defaultEnableChangeStreams = detectedTier !== "standalone";
  const enableChangeStreams =
    typeof existingEnableChangeStreams === "boolean"
      ? existingEnableChangeStreams
      : defaultEnableChangeStreams;
  const { backend: _legacyBackend, qmd: _legacyQmd, ...memoryConfig } = nextConfig.memory ?? {};

  let baseResult: OpenClawConfig = {
    ...nextConfig,
    memory: {
      ...memoryConfig,
      mongodb: {
        ...nextConfig.memory?.mongodb,
        uri: resolvedUri,
        deploymentProfile: profile,
        embeddingMode,
        enableChangeStreams,
      },
    },
  };

  if (typeof existingEnableChangeStreams !== "boolean") {
    note(
      enableChangeStreams
        ? "Change streams enabled for real-time cross-instance sync."
        : "Change streams disabled for this setup.",
      "Change Streams",
    );
  }

  note(
    [
      "ClawMongo is pinned to MongoDB Community + mongot with automatic embeddings.",
      "No external embedding provider setup is required for the supported path.",
    ].join("\n"),
    "Memory",
  );

  // Offer connection test + topology detection
  const shouldTest = guardCancel(
    await confirm({
      message: "Test MongoDB connection now?",
      initialValue: true,
    }),
    runtime,
  );

  if (shouldTest) {
    await testMongoDBConnection(resolvedUri);
  }

  // Offer KB import (only for MongoDB backend)
  return offerKBImportConfigure(baseResult, runtime, isClawMongo, resolvedUri);
}

async function testMongoDBConnection(uri: string): Promise<void> {
  let MongoClient: typeof import("mongodb").MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    note(
      [
        "MongoDB driver is not installed.",
        "",
        "The configuration will be saved anyway.",
        "Install with: pnpm add mongodb",
        `Verify later: ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
      "Memory",
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
    note("MongoDB connection successful.", "Memory");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        `MongoDB connection failed: ${message}`,
        "",
        "The configuration will be saved anyway.",
        `Verify later: ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
      "Memory",
    );
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// KB Import Step (offered after MongoDB configuration)
// ---------------------------------------------------------------------------

async function offerKBImportConfigure(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  isClawMongo: boolean,
  uri: string,
): Promise<OpenClawConfig> {
  const cliName = isClawMongo ? "clawmongo" : "openclaw";
  const wantImport = guardCancel(
    await select({
      message: "Import documents into the knowledge base?",
      options: [
        {
          value: "skip",
          label: "Skip for now",
          hint: `Import later with: ${cliName} kb ingest <path>`,
        },
        {
          value: "import",
          label: "Yes, import files/directory",
          hint: "Import .md and .txt files",
        },
      ],
      initialValue: "skip",
    }),
    runtime,
  );

  if (wantImport !== "import") {
    noteMongoMemorySmokeCommand(isClawMongo);
    return config;
  }

  const importPathInput = guardCancel(
    await text({
      message: "Path to files or directory to import",
      placeholder: "./docs",
      validate: (value) => {
        if (!(value ?? "").trim()) {
          return "Path is required";
        }
        return undefined;
      },
    }),
    runtime,
  );

  const resolvedPath = path.resolve(String(importPathInput).trim());
  const tagsInput = guardCancel(
    await text({
      message: "Tags (comma-separated, or leave blank)",
      placeholder: "docs, reference",
      validate: () => undefined,
    }),
    runtime,
  );
  const tagList = String(tagsInput ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  let importSucceeded = false;
  let client: import("mongodb").MongoClient | undefined;
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    });
    await client.connect();

    const mongoCfg = config.memory?.mongodb;
    const database = mongoCfg?.database ?? "openclaw";
    const prefix = mongoCfg?.collectionPrefix ?? "openclaw_";
    const db = client.db(database);

    const { ensureCollections, ensureStandardIndexes } =
      await import("../memory/mongodb-schema.js");
    await ensureCollections(db, prefix);
    await ensureStandardIndexes(db, prefix);

    const { ingestFilesToKB } = await import("../memory/mongodb-kb.js");
    const embeddingMode = mongoCfg?.embeddingMode ?? "automated";

    note("Importing documents…", "Knowledge Base");

    const result = await ingestFilesToKB({
      db,
      prefix,
      paths: [resolvedPath],
      recursive: true,
      tags: tagList.length > 0 ? tagList : undefined,
      importedBy: "wizard",
      embeddingMode,
    });

    note(
      `Imported ${result.documentsProcessed} documents (${result.chunksCreated} chunks, ${result.skipped} skipped)`,
      "Knowledge Base",
    );

    if (result.errors.length > 0) {
      note(result.errors.map((e) => `- ${e}`).join("\n"), "Import Warnings");
    }

    importSucceeded = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(
      [
        `Import failed: ${msg}`,
        "",
        `You can import later with: ${cliName} kb ingest ${resolvedPath}`,
      ].join("\n"),
      "Knowledge Base",
    );
  } finally {
    await client?.close().catch(() => {});
  }

  // Store autoImportPaths in config only when import succeeded
  if (!importSucceeded) {
    noteMongoMemorySmokeCommand(isClawMongo);
    return config;
  }
  noteMongoMemorySmokeCommand(isClawMongo);
  return {
    ...config,
    memory: {
      ...config.memory,
      mongodb: {
        ...config.memory?.mongodb,
        kb: {
          ...config.memory?.mongodb?.kb,
          autoImportPaths: [...(config.memory?.mongodb?.kb?.autoImportPaths ?? []), resolvedPath],
        },
      },
    },
  };
}

function noteMongoMemorySmokeCommand(isClawMongo: boolean): void {
  const cliName = isClawMongo ? "clawmongo" : "openclaw";
  note(
    [
      "Validate MongoDB memory setup before production use:",
      formatCliCommand(`${cliName} memory smoke --agent main`),
      "",
      "This checks backend selection, sync, structured-memory write/read, and retrieval.",
    ].join("\n"),
    "MongoDB Smoke Check",
  );
}

function redactUri(uri: string): string {
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
