import { createHash } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordProjectionRun } from "./mongodb-ops.js";
import {
  entitiesCollection,
  entityLinksCollection,
  relationsCollection,
} from "./mongodb-schema.js";
import { resolveScopeRef } from "./mongodb-scope.js";

const log = createSubsystemLogger("memory:mongodb:graph");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType =
  | "person"
  | "org"
  | "project"
  | "topic"
  | "feature"
  | "issue"
  | "document"
  | "custom";

export type Entity = {
  entityId: string;
  name: string;
  type: EntityType;
  aliases?: string[];
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  metadata?: Record<string, unknown>;
  sourceEventIds?: string[];
  updatedAt: Date;
};

export type RelationType =
  | "works_on"
  | "owns"
  | "depends_on"
  | "blocked_by"
  | "decided"
  | "mentioned_with"
  | "reported_by"
  | "related_to";

export type Relation = {
  fromEntityId: string;
  toEntityId: string;
  type: RelationType;
  weight?: number;
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  sourceEventIds?: string[];
  updatedAt: Date;
};

export type EntityLinkType = "confirmed_same" | "candidate_same" | "related_mention";
export type EntityLinkStatus = "active" | "rejected";

export type EntityLink = {
  linkId: string;
  fromEntityId: string;
  toEntityId: string;
  linkType: EntityLinkType;
  status: EntityLinkStatus;
  confidence: number;
  agentId: string;
  scope: MemoryScope;
  scopeRef?: string;
  sourceEventIds?: string[];
  provenance?: Record<string, unknown>;
  updatedAt: Date;
};

export type GraphExpansionResult = {
  rootEntity: Entity;
  connections: Array<{
    entity: Entity;
    relation: Relation;
    depth: number;
  }>;
};

function relationPriority(type: RelationType): number {
  switch (type) {
    case "works_on":
    case "owns":
    case "depends_on":
    case "blocked_by":
    case "decided":
    case "reported_by":
      return 3;
    case "related_to":
      return 2;
    case "mentioned_with":
    default:
      return 1;
  }
}

function relationRecency(value: unknown): number {
  return value instanceof Date ? value.getTime() : 0;
}

function canonicalizeEntityPair(left: string, right: string) {
  return left <= right
    ? { fromEntityId: left, toEntityId: right }
    : { fromEntityId: right, toEntityId: left };
}

function makeEntityLinkId(params: {
  fromEntityId: string;
  toEntityId: string;
  linkType: EntityLinkType;
  agentId: string;
  scope: MemoryScope;
  scopeRef: string;
}): string {
  return createHash("sha256")
    .update(
      `${params.agentId}:${params.scope}:${params.scopeRef}:${params.fromEntityId}:${params.toEntityId}:${params.linkType}`,
    )
    .digest("hex")
    .slice(0, 24);
}

function normalizeEntityNameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function inferEntityLinkType(
  left: ExtractedEntity,
  right: ExtractedEntity,
): { linkType: EntityLinkType; confidence: number; provenance?: Record<string, unknown> } {
  const leftTokens = normalizeEntityNameTokens(left.name);
  const rightTokens = normalizeEntityNameTokens(right.name);
  const sharedTokens = leftTokens.filter((token) => rightTokens.includes(token));

  if (
    left.type === right.type &&
    left.type === "person" &&
    sharedTokens.length > 0 &&
    left.entityId !== right.entityId
  ) {
    return {
      linkType: "candidate_same",
      confidence: 0.65,
      provenance: { heuristic: "shared-name-tokens", sharedTokens },
    };
  }

  return {
    linkType: "related_mention",
    confidence: 0.2,
    provenance: { heuristic: "co-mentioned" },
  };
}

// ---------------------------------------------------------------------------
// Upsert entity
// ---------------------------------------------------------------------------

export async function upsertEntity(params: {
  db: Db;
  prefix: string;
  entity: Entity;
}): Promise<{ upserted: boolean }> {
  const { db, prefix, entity } = params;
  try {
    const collection = entitiesCollection(db, prefix);

    const now = new Date();
    const scopeRef = resolveScopeRef({
      scope: entity.scope,
      scopeRef: entity.scopeRef,
      agentId: entity.agentId,
    });
    const setDoc: Document = {
      entityId: entity.entityId,
      name: entity.name,
      type: entity.type,
      agentId: entity.agentId,
      scope: entity.scope,
      scopeRef,
      updatedAt: now,
    };
    if (entity.aliases !== undefined) {
      setDoc.aliases = entity.aliases;
    }
    if (entity.metadata !== undefined) {
      setDoc.metadata = entity.metadata;
    }
    if (entity.sourceEventIds !== undefined) {
      setDoc.sourceEventIds = entity.sourceEventIds;
    }

    const result = await collection.updateOne(
      { entityId: entity.entityId, agentId: entity.agentId, scope: entity.scope, scopeRef },
      { $set: setDoc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    const upserted = result.upsertedCount > 0;
    log.info(`entity ${upserted ? "created" : "updated"}: ${entity.entityId} name=${entity.name}`);
    return { upserted };
  } catch (err) {
    log.error(`upsertEntity failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Upsert relation
// ---------------------------------------------------------------------------

export async function upsertRelation(params: {
  db: Db;
  prefix: string;
  relation: Relation;
}): Promise<{ upserted: boolean }> {
  const { db, prefix, relation } = params;
  try {
    const collection = relationsCollection(db, prefix);

    const now = new Date();
    const scopeRef = resolveScopeRef({
      scope: relation.scope,
      scopeRef: relation.scopeRef,
      agentId: relation.agentId,
    });
    const setDoc: Document = {
      fromEntityId: relation.fromEntityId,
      toEntityId: relation.toEntityId,
      type: relation.type,
      agentId: relation.agentId,
      scope: relation.scope,
      scopeRef,
      updatedAt: now,
    };
    if (relation.weight !== undefined) {
      setDoc.weight = relation.weight;
    }
    if (relation.sourceEventIds !== undefined) {
      setDoc.sourceEventIds = relation.sourceEventIds;
    }

    const result = await collection.updateOne(
      {
        fromEntityId: relation.fromEntityId,
        toEntityId: relation.toEntityId,
        type: relation.type,
        agentId: relation.agentId,
        scope: relation.scope,
        scopeRef,
      },
      { $set: setDoc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    const upserted = result.upsertedCount > 0;
    log.info(
      `relation ${upserted ? "created" : "updated"}: ${relation.fromEntityId} -[${relation.type}]-> ${relation.toEntityId}`,
    );
    return { upserted };
  } catch (err) {
    log.error(`upsertRelation failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Upsert entity link
// ---------------------------------------------------------------------------

export async function upsertEntityLink(params: {
  db: Db;
  prefix: string;
  link: Omit<EntityLink, "linkId" | "updatedAt" | "scopeRef"> & {
    linkId?: string;
    updatedAt?: Date;
    scopeRef?: string;
  };
}): Promise<{ upserted: boolean; linkId: string }> {
  const { db, prefix, link } = params;
  try {
    const collection = entityLinksCollection(db, prefix);
    const scopeRef = resolveScopeRef({
      scope: link.scope,
      scopeRef: link.scopeRef,
      agentId: link.agentId,
    });
    const pair = canonicalizeEntityPair(link.fromEntityId, link.toEntityId);
    const linkId =
      link.linkId ??
      makeEntityLinkId({
        ...pair,
        linkType: link.linkType,
        agentId: link.agentId,
        scope: link.scope,
        scopeRef,
      });
    const now = link.updatedAt ?? new Date();
    const setDoc: Document = {
      linkId,
      ...pair,
      linkType: link.linkType,
      status: link.status,
      confidence: link.confidence,
      agentId: link.agentId,
      scope: link.scope,
      scopeRef,
      updatedAt: now,
    };
    if (link.sourceEventIds !== undefined) {
      setDoc.sourceEventIds = link.sourceEventIds;
    }
    if (link.provenance !== undefined) {
      setDoc.provenance = link.provenance;
    }

    const result = await collection.updateOne(
      {
        agentId: link.agentId,
        scope: link.scope,
        scopeRef,
        fromEntityId: pair.fromEntityId,
        toEntityId: pair.toEntityId,
        linkType: link.linkType,
      },
      { $set: setDoc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    return { upserted: result.upsertedCount > 0, linkId };
  } catch (err) {
    log.error(`upsertEntityLink failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

export async function setEntityLinkStatus(params: {
  db: Db;
  prefix: string;
  agentId: string;
  scope: MemoryScope;
  fromEntityId: string;
  toEntityId: string;
  linkType: EntityLinkType;
  scopeRef?: string;
  status: EntityLinkStatus;
}): Promise<boolean> {
  const { db, prefix, agentId, scope, linkType, status } = params;
  const collection = entityLinksCollection(db, prefix);
  const scopeRef = resolveScopeRef({ scope, scopeRef: params.scopeRef, agentId });
  const pair = canonicalizeEntityPair(params.fromEntityId, params.toEntityId);
  const result = await collection.updateOne(
    {
      agentId,
      scope,
      scopeRef,
      fromEntityId: pair.fromEntityId,
      toEntityId: pair.toEntityId,
      linkType,
    },
    { $set: { status, updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}

export async function getEntityLinks(params: {
  db: Db;
  prefix: string;
  agentId: string;
  entityId: string;
  scope?: MemoryScope;
  scopeRef?: string;
  status?: EntityLinkStatus;
  linkTypes?: EntityLinkType[];
  limit?: number;
}): Promise<EntityLink[]> {
  const { db, prefix, agentId, entityId, scope, scopeRef, status, linkTypes, limit } = params;
  const collection = entityLinksCollection(db, prefix);
  const filter: Document = {
    agentId,
    $or: [{ fromEntityId: entityId }, { toEntityId: entityId }],
  };
  if (scope) {
    filter.scope = scope;
  }
  if (scopeRef) {
    filter.scopeRef = scopeRef;
  }
  if (status) {
    filter.status = status;
  }
  if (linkTypes && linkTypes.length > 0) {
    filter.linkType = { $in: linkTypes };
  }

  const docs = await collection
    .find(filter)
    .sort({ confidence: -1, updatedAt: -1 })
    .limit(limit ?? 50)
    .toArray();
  return docs as unknown as EntityLink[];
}

// ---------------------------------------------------------------------------
// Find entities by name (regex search on name/aliases)
// ---------------------------------------------------------------------------

export async function findEntitiesByName(params: {
  db: Db;
  prefix: string;
  query: string;
  agentId: string;
  scope?: MemoryScope;
  scopeRef?: string;
  limit?: number;
}): Promise<Entity[]> {
  const { db, prefix, query, agentId, scope, scopeRef, limit } = params;
  try {
    const collection = entitiesCollection(db, prefix);

    // Case-insensitive regex search on name and aliases
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedQuery, "i");

    const filter: Document = {
      agentId,
      $or: [{ name: { $regex: regex } }, { aliases: { $regex: regex } }],
    };
    if (scope) {
      filter.scope = scope;
    }
    if (scopeRef) {
      filter.scopeRef = scopeRef;
    }

    const docs = await collection
      .find(filter)
      // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
      .sort({ updatedAt: -1 })
      .limit(limit ?? 50)
      .toArray();

    return docs as unknown as Entity[];
  } catch (err) {
    log.error(`findEntitiesByName failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Get entities by type
// ---------------------------------------------------------------------------

export async function getEntitiesByType(params: {
  db: Db;
  prefix: string;
  type: EntityType;
  agentId: string;
  scope?: MemoryScope;
  scopeRef?: string;
  limit?: number;
}): Promise<Entity[]> {
  const { db, prefix, type, agentId, scope, scopeRef, limit } = params;
  try {
    const collection = entitiesCollection(db, prefix);

    const docs = await collection
      .find({
        agentId,
        type,
        ...(scope ? { scope } : {}),
        ...(scopeRef ? { scopeRef } : {}),
      })
      // oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
      .sort({ updatedAt: -1 })
      .limit(limit ?? 50)
      .toArray();

    return docs as unknown as Entity[];
  } catch (err) {
    log.error(`getEntitiesByType failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Graph expansion using $graphLookup
// NOTE: Traversal is outbound-only (fromEntityId -> toEntityId). The
// $graphLookup follows toEntityId -> fromEntityId edges, meaning it walks
// forward through the directed relation graph. Bidirectional expansion
// (also following toEntityId -> toEntityId reverse edges) can be added in
// a future phase if needed.
// ---------------------------------------------------------------------------

export async function expandGraph(params: {
  db: Db;
  prefix: string;
  entityId: string;
  agentId: string;
  scope?: MemoryScope;
  scopeRef?: string;
  maxDepth?: number;
  bidirectional?: boolean;
  maxConnections?: number;
}): Promise<GraphExpansionResult | null> {
  const {
    db,
    prefix,
    entityId,
    agentId,
    scope,
    scopeRef,
    maxDepth,
    bidirectional,
    maxConnections,
  } = params;
  try {
    const entCol = entitiesCollection(db, prefix);
    const relCol = relationsCollection(db, prefix);

    // 1. Find root entity
    const rootEntity = (await entCol.findOne({
      entityId,
      agentId,
      ...(scope ? { scope } : {}),
      ...(scopeRef ? { scopeRef } : {}),
    })) as unknown as Entity | null;
    if (!rootEntity) {
      return null;
    }

    const graphLookupDepth = Math.max(0, (maxDepth ?? 2) - 1);

    // 3. Collect all unique relations with their depths
    // Direct relations are depth 0, transitive relations come from $graphLookup
    const relationsByKey = new Map<string, { relation: Document; depth: number }>();

    function collectRelations(rels: Document[]): void {
      for (const directRel of rels) {
        const key = `${directRel.fromEntityId}:${directRel.toEntityId}:${directRel.type}`;
        if (!relationsByKey.has(key)) {
          relationsByKey.set(key, { relation: directRel, depth: 0 });
        }
        // Process transitive relations from $graphLookup
        const transitive = (directRel.transitiveRelations ?? []) as Document[];
        for (const transRel of transitive) {
          const tKey = `${transRel.fromEntityId}:${transRel.toEntityId}:${transRel.type}`;
          const depth = ((transRel.depth as number) ?? 0) + 1;
          if (!relationsByKey.has(tKey)) {
            relationsByKey.set(tKey, { relation: transRel, depth });
          }
        }
      }
    }

    if (bidirectional) {
      // 2b. Use $facet for parallel forward + reverse traversal in one aggregation
      const facetPipeline: Document[] = [
        {
          $facet: {
            forward: [
              {
                $match: {
                  fromEntityId: entityId,
                  agentId,
                  ...(scope ? { scope } : {}),
                  ...(scopeRef ? { scopeRef } : {}),
                },
              },
              {
                $graphLookup: {
                  from: `${prefix}relations`,
                  startWith: "$toEntityId",
                  connectFromField: "toEntityId",
                  connectToField: "fromEntityId",
                  as: "transitiveRelations",
                  maxDepth: graphLookupDepth,
                  depthField: "depth",
                  restrictSearchWithMatch: {
                    agentId,
                    ...(scope ? { scope } : {}),
                    ...(scopeRef ? { scopeRef } : {}),
                  },
                },
              },
            ],
            reverse: [
              {
                $match: {
                  toEntityId: entityId,
                  agentId,
                  ...(scope ? { scope } : {}),
                  ...(scopeRef ? { scopeRef } : {}),
                },
              },
              {
                $graphLookup: {
                  from: `${prefix}relations`,
                  startWith: "$fromEntityId",
                  connectFromField: "fromEntityId",
                  connectToField: "toEntityId",
                  as: "transitiveRelations",
                  maxDepth: graphLookupDepth,
                  depthField: "depth",
                  restrictSearchWithMatch: {
                    agentId,
                    ...(scope ? { scope } : {}),
                    ...(scopeRef ? { scopeRef } : {}),
                  },
                },
              },
            ],
          },
        },
      ];

      const [facetResult] = await relCol.aggregate(facetPipeline).toArray();
      const forwardRels = (facetResult?.forward ?? []) as Document[];
      const reverseRels = (facetResult?.reverse ?? []) as Document[];
      collectRelations(forwardRels);
      collectRelations(reverseRels);
    } else {
      // 2a. Outbound-only pipeline (original behavior)
      const relPipeline: Document[] = [
        {
          $match: {
            fromEntityId: entityId,
            agentId,
            ...(scope ? { scope } : {}),
            ...(scopeRef ? { scopeRef } : {}),
          },
        },
        {
          $graphLookup: {
            from: `${prefix}relations`,
            startWith: "$toEntityId",
            connectFromField: "toEntityId",
            connectToField: "fromEntityId",
            as: "transitiveRelations",
            maxDepth: graphLookupDepth,
            depthField: "depth",
            restrictSearchWithMatch: {
              agentId,
              ...(scope ? { scope } : {}),
              ...(scopeRef ? { scopeRef } : {}),
            },
          },
        },
      ];

      const relResults = await relCol.aggregate(relPipeline).toArray();
      collectRelations(relResults);
    }

    // 4. Collect all connected entity IDs
    const connectedEntityIds = new Set<string>();
    const entries = Array.from(relationsByKey.values());
    for (const { relation } of entries) {
      if (relation.toEntityId !== entityId) {
        connectedEntityIds.add(relation.toEntityId as string);
      }
      if (relation.fromEntityId !== entityId) {
        connectedEntityIds.add(relation.fromEntityId as string);
      }
    }

    // 5. Look up connected entity details (scoped by agentId)
    const entityMap = new Map<string, Entity>();
    if (connectedEntityIds.size > 0) {
      const entityDocs = await entCol
        .find({
          entityId: { $in: Array.from(connectedEntityIds) },
          agentId,
          ...(scope ? { scope } : {}),
          ...(scopeRef ? { scopeRef } : {}),
        })
        .toArray();
      for (const doc of entityDocs) {
        entityMap.set(doc.entityId as string, doc as unknown as Entity);
      }
    }

    // 6. Build connections array
    const connections: GraphExpansionResult["connections"] = [];
    for (const { relation, depth } of entries) {
      const targetEntityId =
        relation.toEntityId === entityId
          ? (relation.fromEntityId as string)
          : (relation.toEntityId as string);
      const targetEntity = entityMap.get(targetEntityId);
      if (targetEntity) {
        connections.push({
          entity: targetEntity,
          relation: relation as unknown as Relation,
          depth,
        });
      }
    }

    connections.sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      const priorityDiff = relationPriority(b.relation.type) - relationPriority(a.relation.type);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const weightDiff = (b.relation.weight ?? 0) - (a.relation.weight ?? 0);
      if (weightDiff !== 0) {
        return weightDiff;
      }
      const recencyDiff =
        relationRecency(b.relation.updatedAt) - relationRecency(a.relation.updatedAt);
      if (recencyDiff !== 0) {
        return recencyDiff;
      }
      return a.entity.name.localeCompare(b.entity.name);
    });

    // 7. Apply maxConnections limit
    const connectionLimit = maxConnections ?? 100;
    const limitedConnections = connections.slice(0, connectionLimit);
    if (connections.length > connectionLimit) {
      log.warn(
        `expandGraph: truncated ${connections.length} connections to maxConnections=${connectionLimit} for entity=${entityId}`,
      );
    }

    return { rootEntity, connections: limitedConnections };
  } catch (err) {
    log.error(`expandGraph failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delete entity (cascade delete relations)
// ---------------------------------------------------------------------------

export async function deleteEntity(params: {
  db: Db;
  prefix: string;
  entityId: string;
  agentId: string;
}): Promise<{ deletedEntity: boolean; deletedRelations: number }> {
  const { db, prefix, entityId, agentId } = params;
  try {
    const entCol = entitiesCollection(db, prefix);
    const relCol = relationsCollection(db, prefix);

    // Delete entity scoped by agentId
    const entityResult = await entCol.deleteOne({ entityId, agentId });

    // Cascade delete all relations involving this entity, scoped by agentId
    const relResult = await relCol.deleteMany({
      $or: [{ fromEntityId: entityId }, { toEntityId: entityId }],
      agentId,
    });

    log.info(
      `deleted entity=${entityId} (found=${entityResult.deletedCount > 0}, relations=${relResult.deletedCount})`,
    );

    return {
      deletedEntity: entityResult.deletedCount > 0,
      deletedRelations: relResult.deletedCount,
    };
  } catch (err) {
    log.error(`deleteEntity failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rule-based entity extraction
// ---------------------------------------------------------------------------

// Stop words for quoted name filtering
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "must",
  "need",
  "not",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "him",
  "her",
  "they",
  "them",
  "their",
]);

// Regex patterns for structural entity extraction
const MENTION_REGEX = /@(\w{3,})/g;
const TAG_REGEX = /#(\w{3,})/g;
const URL_REGEX = /https?:\/\/[^\s)]+/g;
const FILE_PATH_REGEX = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
const QUOTED_NAME_REGEX = /"([^"]{3,})"/g;

function makeEntityId(
  name: string,
  type: string,
  agentId: string,
  scope: MemoryScope,
  scopeRef: string,
): string {
  return createHash("sha256")
    .update(`${agentId}:${scope}:${scopeRef}:${name.toLowerCase()}:${type}`)
    .digest("hex")
    .slice(0, 16);
}

type ExtractedEntity = { entityId: string; name: string; type: EntityType };

/**
 * Extract structural entities from event content and upsert them.
 * Regex patterns: @mentions->person, #tags->topic, URLs->document,
 * file paths->document, "quoted names"->person.
 *
 * Deterministic entityIds via hash of name.toLowerCase() + type.
 * Fire-and-forget: caller decides whether to await.
 * SEPARATE from writeEvent -- not called automatically.
 */
export async function extractAndUpsertEntities(params: {
  db: Db;
  prefix: string;
  agentId: string;
  eventContent: string;
  scope: MemoryScope;
  scopeRef?: string;
  sourceEventId?: string;
}): Promise<{ entities: ExtractedEntity[]; relationsCreated: number }> {
  const { db, prefix, agentId, eventContent, scope, sourceEventId } = params;
  const startMs = Date.now();
  const scopeRef = resolveScopeRef({ scope, scopeRef: params.scopeRef, agentId });

  const extracted: ExtractedEntity[] = [];
  const seen = new Set<string>(); // dedup by entityId

  // Helper to add an entity (dedup by entityId)
  function addEntity(name: string, type: EntityType): void {
    const entityId = makeEntityId(name, type, agentId, scope, scopeRef);
    if (!seen.has(entityId)) {
      seen.add(entityId);
      extracted.push({ entityId, name, type });
    }
  }

  // 1. @mentions -> person
  for (const match of eventContent.matchAll(MENTION_REGEX)) {
    const name = match[1];
    if (name && !STOP_WORDS.has(name.toLowerCase())) {
      addEntity(name, "person");
    }
  }

  // 2. #tags -> topic
  for (const match of eventContent.matchAll(TAG_REGEX)) {
    const name = match[1];
    if (name && !STOP_WORDS.has(name.toLowerCase())) {
      addEntity(name, "topic");
    }
  }

  // 3. URLs -> document
  for (const match of eventContent.matchAll(URL_REGEX)) {
    addEntity(match[0], "document");
  }

  // 4. File paths -> document
  for (const match of eventContent.matchAll(FILE_PATH_REGEX)) {
    const filePath = match[1];
    if (filePath) {
      addEntity(filePath, "document");
    }
  }

  // 5. "Quoted names" -> person (min 3 chars, stop-word filtered)
  for (const match of eventContent.matchAll(QUOTED_NAME_REGEX)) {
    const name = match[1];
    if (name && name.trim().length >= 3 && !STOP_WORDS.has(name.toLowerCase().trim())) {
      addEntity(name.trim(), "person");
    }
  }

  if (extracted.length === 0) {
    await Promise.allSettled([
      recordProjectionRun({
        db,
        prefix,
        run: {
          agentId,
          projectionType: "entities",
          status: "ok",
          itemsProjected: 0,
          durationMs: Date.now() - startMs,
        },
      }),
      recordProjectionRun({
        db,
        prefix,
        run: {
          agentId,
          projectionType: "relations",
          status: "ok",
          itemsProjected: 0,
          durationMs: Date.now() - startMs,
        },
      }),
    ]);
    return { entities: [], relationsCreated: 0 };
  }

  // Upsert entities
  try {
    for (const entity of extracted) {
      await upsertEntity({
        db,
        prefix,
        entity: {
          entityId: entity.entityId,
          name: entity.name,
          type: entity.type,
          agentId,
          scope,
          scopeRef,
          updatedAt: new Date(),
          ...(sourceEventId && { sourceEventIds: [sourceEventId] }),
        },
      });
    }

    // Create relationship edges and explicit, auditable entity-link records
    // without collapsing identity into one hidden canonical entity.
    let relationsCreated = 0;
    if (extracted.length >= 2) {
      for (let i = 0; i < extracted.length - 1 && i < 5; i++) {
        for (let j = i + 1; j < extracted.length && j < 6; j++) {
          const link = inferEntityLinkType(extracted[i], extracted[j]);
          await upsertEntityLink({
            db,
            prefix,
            link: {
              fromEntityId: extracted[i].entityId,
              toEntityId: extracted[j].entityId,
              linkType: link.linkType,
              status: "active",
              confidence: link.confidence,
              provenance: link.provenance,
              agentId,
              scope,
              scopeRef,
              ...(sourceEventId ? { sourceEventIds: [sourceEventId] } : {}),
            },
          });
          await upsertRelation({
            db,
            prefix,
            relation: {
              fromEntityId: extracted[i].entityId,
              toEntityId: extracted[j].entityId,
              type: "mentioned_with",
              weight: 0.2,
              agentId,
              scope,
              scopeRef,
              updatedAt: new Date(),
              ...(sourceEventId && { sourceEventIds: [sourceEventId] }),
            },
          });
          relationsCreated++;
        }
      }
    }

    log.info(
      `extracted ${extracted.length} entities and ${relationsCreated} relations from event content for agent=${agentId}`,
    );
    await Promise.allSettled([
      recordProjectionRun({
        db,
        prefix,
        run: {
          agentId,
          projectionType: "entities",
          status: "ok",
          itemsProjected: extracted.length,
          durationMs: Date.now() - startMs,
        },
      }),
      recordProjectionRun({
        db,
        prefix,
        run: {
          agentId,
          projectionType: "relations",
          status: "ok",
          itemsProjected: relationsCreated,
          durationMs: Date.now() - startMs,
        },
      }),
    ]);
    return { entities: extracted, relationsCreated };
  } catch (err) {
    await Promise.allSettled([
      recordProjectionRun({
        db,
        prefix,
        run: {
          agentId,
          projectionType: "entities",
          status: "failed",
          itemsProjected: 0,
          durationMs: Date.now() - startMs,
        },
      }),
      recordProjectionRun({
        db,
        prefix,
        run: {
          agentId,
          projectionType: "relations",
          status: "failed",
          itemsProjected: 0,
          durationMs: Date.now() - startMs,
        },
      }),
    ]);
    log.error(
      `extractAndUpsertEntities failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
