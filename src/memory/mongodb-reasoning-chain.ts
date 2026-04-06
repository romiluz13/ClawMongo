/**
 * Reasoning Chain Traversal — trace any derived fact back to its original
 * conversation events via `$lookup` on `sourceEventIds`.
 *
 * Events are leaf nodes (they do NOT have sourceEventIds).
 * The traversal is a single-hop: fact -> sourceEventIds -> events.
 *
 * @module mongodb-reasoning-chain
 */

import type { Db, Document } from "mongodb";
import type { ReasoningChain, ReasoningChainNode, ReasoningChainOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known source collections that carry `sourceEventIds`.
 * Maps collection short name to its primary id field.
 */
const COLLECTION_ID_FIELDS: Record<string, string> = {
  structured_mem: "key",
  entities: "entityId",
  relations: "fromEntityId", // relations use compound key, but fromEntityId is the closest primary
  procedures: "procedureId",
  entity_links: "linkId",
};

const DEFAULT_MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trace a reasoning chain from a derived fact back to its source events.
 *
 * The chain is ordered oldest-first: source events sorted by timestamp ascending,
 * then the fact itself as the last node.
 *
 * Gap nodes are produced for `sourceEventIds` entries that do not resolve to
 * actual events (deleted or missing).
 */
export async function traceReasoningChain(params: {
  db: Db;
  prefix: string;
  agentId: string;
  factId: string;
  collection: string;
  options?: ReasoningChainOptions;
}): Promise<ReasoningChain> {
  const { db, prefix, agentId, factId, collection, options } = params;
  const maxDepth = Math.max(0, options?.maxDepth ?? DEFAULT_MAX_DEPTH);

  const emptyResult: ReasoningChain = {
    factId,
    collection,
    nodes: [],
    chainComplete: true,
    maxDepthReached: false,
    agentId,
  };

  // Validate collection name
  const idField = COLLECTION_ID_FIELDS[collection];
  if (!idField) {
    return emptyResult;
  }

  const fullCollectionName = `${prefix}${collection}`;

  // Build the aggregation pipeline:
  // 1. Match the fact by its id field + agentId (multi-tenant isolation)
  // 2. $lookup source events from the events collection
  const pipeline: Document[] = [
    { $match: { [idField]: factId, agentId } },
    {
      $lookup: {
        from: `${prefix}events`,
        let: { sourceIds: { $ifNull: ["$sourceEventIds", []] } },
        pipeline: [
          {
            $match: {
              $expr: { $in: ["$eventId", "$$sourceIds"] },
              agentId,
            },
          },
          { $sort: { timestamp: 1 } },
        ],
        as: "sourceEvents",
      },
    },
  ];

  const col = db.collection(fullCollectionName);
  const results = await col.aggregate(pipeline).toArray();

  if (results.length === 0) {
    return emptyResult;
  }

  const factDoc = results[0];
  const sourceEventIds: string[] = factDoc.sourceEventIds ?? [];
  const sourceEvents: Document[] = factDoc.sourceEvents ?? [];

  const nodes: ReasoningChainNode[] = [];

  // Build event nodes (already sorted by timestamp ascending from pipeline)
  const resolvedEventIds = new Set(sourceEvents.map((e: Document) => e.eventId as string));

  for (const evt of sourceEvents) {
    nodes.push({
      type: "event",
      id: evt.eventId as string,
      collection: "events",
      body: evt.body as string | undefined,
      role: evt.role as string | undefined,
      timestamp: evt.timestamp instanceof Date ? evt.timestamp : undefined,
      depth: 0,
    });
  }

  // Add gap nodes for sourceEventIds that didn't resolve
  let chainComplete = true;
  for (const sid of sourceEventIds) {
    if (!resolvedEventIds.has(sid)) {
      chainComplete = false;
      nodes.push({
        type: "gap",
        id: sid,
        collection: "events",
        depth: 0,
        reason: "deleted",
      });
    }
  }

  // The fact itself is the last node in the chain
  nodes.push({
    type: "fact",
    id: factId,
    collection,
    body: factDoc.value as string | undefined,
    timestamp: factDoc.updatedAt instanceof Date ? factDoc.updatedAt : undefined,
    depth: maxDepth === 0 ? 0 : 1,
  });

  // If no sourceEventIds at all, the chain is still complete (fact is self-contained)
  if (sourceEventIds.length === 0) {
    chainComplete = true;
  }

  return {
    factId,
    collection,
    nodes,
    chainComplete,
    maxDepthReached: maxDepth === 0,
    agentId,
  };
}
