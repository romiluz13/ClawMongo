import type { Db } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:topology");

export type MongoTopology = {
  isReplicaSet: boolean;
  replicaSetName?: string;
  hasMongot: boolean;
  serverVersion: string;
};

export type DeploymentTier = "standalone" | "replicaset" | "fullstack";

/**
 * Detect the MongoDB deployment topology by probing the server.
 * Safe to call on any MongoDB version/edition - all probes use try/catch.
 */
export async function detectTopology(db: Db): Promise<MongoTopology> {
  const result: MongoTopology = {
    isReplicaSet: false,
    hasMongot: false,
    serverVersion: "unknown",
  };

  // Probe 1: Replica set status
  try {
    const rsStatus = await db.admin().command({ replSetGetStatus: 1 });
    result.isReplicaSet = true;
    result.replicaSetName = rsStatus.set;
  } catch {
    // Not a replica set member or not authorized
    result.isReplicaSet = false;
  }

  // Probe 2: Server version via buildInfo
  try {
    const buildInfo = await db.admin().command({ buildInfo: 1 });
    result.serverVersion = buildInfo.version ?? "unknown";
  } catch {
    result.serverVersion = "unknown";
  }

  // Probe 3: mongot availability via listSearchIndexes
  try {
    const collections = await db.listCollections().toArray();
    for (const col of collections.slice(0, 5)) {
      try {
        await db.collection(col.name).listSearchIndexes().toArray();
        result.hasMongot = true;
        break;
      } catch {
        // This collection doesn't support search indexes
      }
    }
  } catch {
    result.hasMongot = false;
  }

  log.info(`topology detected: ${JSON.stringify(result)}`);
  return result;
}

/**
 * Map detected topology to one of three deployment tiers.
 */
export function topologyToTier(topology: MongoTopology): DeploymentTier {
  if (topology.isReplicaSet && topology.hasMongot) {
    return "fullstack";
  }
  if (topology.isReplicaSet) {
    return "replicaset";
  }
  return "standalone";
}

/**
 * Suggest connection string adjustments based on detected topology.
 */
export function suggestConnectionString(topology: MongoTopology, currentUri: string): string {
  if (!topology.isReplicaSet) {
    return currentUri;
  }

  // Check if replicaSet is already in the URI
  try {
    const url = new URL(currentUri);
    if (!url.searchParams.has("replicaSet") && topology.replicaSetName) {
      url.searchParams.set("replicaSet", topology.replicaSetName);
      return url.toString();
    }
  } catch {
    // URI parsing failed, return as-is
  }
  return currentUri;
}

/**
 * Get human-readable feature list for a deployment tier.
 */
export function tierFeatures(tier: DeploymentTier): {
  available: string[];
  unavailable: string[];
} {
  switch (tier) {
    case "fullstack":
      return {
        available: [
          "ACID transactions (withTransaction)",
          "$vectorSearch (semantic/vector search)",
          "$search with $rankFusion and $scoreFusion",
          "Automated embeddings (Voyage AI)",
          "Change streams (real-time sync)",
          "$text keyword search",
        ],
        unavailable: [],
      };
    case "replicaset":
      return {
        available: [
          "ACID transactions (withTransaction)",
          "$text keyword search",
          "Change streams (real-time sync)",
        ],
        unavailable: [
          "$vectorSearch (requires mongot)",
          "$search/$rankFusion/$scoreFusion (requires mongot)",
          "Automated embeddings (requires mongot)",
        ],
      };
    case "standalone":
      return {
        available: ["$text keyword search", "Basic CRUD operations"],
        unavailable: [
          "ACID transactions (requires replica set)",
          "$vectorSearch (requires mongot)",
          "$search/$rankFusion/$scoreFusion (requires mongot)",
          "Automated embeddings (requires mongot)",
          "Change streams (requires replica set)",
        ],
      };
  }
}
