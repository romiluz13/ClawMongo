#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";

const repoRoot = process.cwd();
const mongoUri =
  process.env.CLAWMONGO_E2E_MONGODB_URI ||
  process.env.MONGODB_TEST_URI ||
  process.env.OPENCLAW_MONGODB_URI ||
  "";
const voyageKey =
  process.env.VOYAGE_API_KEY ||
  process.env.VOYAGE_API_QUERY_KEY ||
  process.env.VOYAGE_API_INDEXING_KEY ||
  "";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function requireEnv() {
  if (!mongoUri.trim()) {
    throw new Error(
      [
        "Missing MongoDB URI for real ClawMongo E2E.",
        "Set CLAWMONGO_E2E_MONGODB_URI, MONGODB_TEST_URI, or OPENCLAW_MONGODB_URI.",
      ].join(" "),
    );
  }
  if (!voyageKey.trim()) {
    throw new Error(
      [
        "Missing Voyage API key for ClawMongo autoEmbed E2E.",
        "Set VOYAGE_API_KEY, or set the profile-specific VOYAGE_API_QUERY_KEY / VOYAGE_API_INDEXING_KEY variables.",
        "MongoDB structured writes can run without Voyage, but vector recall cannot be proven without it.",
      ].join(" "),
    );
  }
}

async function writeConfig(homeDir, agentId, database, prefix) {
  const openclawDir = path.join(homeDir, ".openclaw");
  await fs.mkdir(openclawDir, { recursive: true });
  const deploymentProfile =
    mongoUri.includes(".mongodb.net") || mongoUri.startsWith("mongodb+srv://")
      ? "atlas-cloud"
      : "atlas-local-preview";
  const config = {
    agents: {
      defaults: {
        workspace: path.join(homeDir, "workspace"),
      },
    },
    memory: {
      backend: "mongodb",
      mongodb: {
        uri: mongoUri,
        database,
        collectionPrefix: prefix,
        deploymentProfile,
        embeddingMode: "automated",
        enableChangeStreams: false,
      },
    },
  };
  await fs.mkdir(config.agents.defaults.workspace, { recursive: true });
  await fs.writeFile(path.join(openclawDir, "openclaw.json"), JSON.stringify(config, null, 2));
  return { agentId, deploymentProfile };
}

async function main() {
  requireEnv();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const agentId = `e2e-${suffix}`;
  const database = `clawmongo_e2e_${suffix}`;
  const prefix = `e2e_${suffix}_`;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmongo-real-e2e-"));
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
  try {
    const profile = await writeConfig(homeDir, agentId, database, prefix);
    await client.connect();
    await client.db("admin").command({ ping: 1 });

    const env = {
      ...process.env,
      HOME: homeDir,
      OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
      OPENCLAW_CONFIG_PATH: path.join(homeDir, ".openclaw", "openclaw.json"),
    };

    run("node", ["openclaw.mjs", "memory", "status", "--json"], { env });

    const { getMemorySearchManager } = await import("../dist/memory/index.js");
    const cfg = JSON.parse(await fs.readFile(path.join(homeDir, ".openclaw", "openclaw.json"), "utf8"));
    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      throw new Error(error ?? "memory manager unavailable");
    }
    const writable = manager;
    if (typeof writable.writeStructuredMemory !== "function") {
      throw new Error("memory manager lacks writeStructuredMemory");
    }
    const key = `favorite-database-${suffix}`;
    await writable.writeStructuredMemory({
      agentId,
      type: "preference",
      key,
      value: "MongoDB is the canonical ClawMongo memory store",
      scope: "agent",
      scopeRef: `agent:${agentId}`,
      salience: "critical",
      source: "agent",
    });
    const results = await manager.search("canonical ClawMongo memory store", {
      maxResults: 5,
      minScore: 0,
    });
    if (!results.some((result) => result.snippet.includes("MongoDB"))) {
      throw new Error(`expected MongoDB memory result, got ${JSON.stringify(results)}`);
    }
    await manager.close?.();
    console.log(
      JSON.stringify(
        {
          ok: true,
          profile,
          database,
          prefix,
          resultCount: results.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.db(database).dropDatabase().catch(() => {});
    await client.close().catch(() => {});
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
