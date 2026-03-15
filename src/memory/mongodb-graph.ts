import type { Db, Document } from "mongodb";
import type { MemoryScope } from "../config/types.memory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { entitiesCollection, relationsCollection } from "./mongodb-schema.js";

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
  sourceEventIds?: string[];
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
    const setDoc: Document = {
      entityId: entity.entityId,
      name: entity.name,
      type: entity.type,
      agentId: entity.agentId,
      scope: entity.scope,
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
      { entityId: entity.entityId },
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
    const setDoc: Document = {
      fromEntityId: relation.fromEntityId,
      toEntityId: relation.toEntityId,
      type: relation.type,
      agentId: relation.agentId,
      scope: relation.scope,
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
// Find entities by name (regex search on name/aliases)
// ---------------------------------------------------------------------------

export async function findEntitiesByName(params: {
  db: Db;
  prefix: string;
  query: string;
  agentId: string;
  limit?: number;
}): Promise<Entity[]> {
  const { db, prefix, query, agentId, limit } = params;
  try {
    const collection = entitiesCollection(db, prefix);

    // Case-insensitive regex search on name and aliases
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escapedQuery, "i");

    const filter: Document = {
      agentId,
      $or: [{ name: { $regex: regex } }, { aliases: { $regex: regex } }],
    };

    const docs = await collection
      .find(filter)
      .toSorted({ updatedAt: -1 })
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
  limit?: number;
}): Promise<Entity[]> {
  const { db, prefix, type, agentId, limit } = params;
  try {
    const collection = entitiesCollection(db, prefix);

    const docs = await collection
      .find({ agentId, type })
      .toSorted({ updatedAt: -1 })
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
  maxDepth?: number;
}): Promise<GraphExpansionResult | null> {
  const { db, prefix, entityId, agentId, maxDepth } = params;
  try {
    const entCol = entitiesCollection(db, prefix);
    const relCol = relationsCollection(db, prefix);

    // 1. Find root entity
    const rootEntity = (await entCol.findOne({
      entityId,
      agentId,
    })) as unknown as Entity | null;
    if (!rootEntity) {
      return null;
    }

    // 2. Run $graphLookup on relations collection starting from relations
    //    that originate from the root entity, then follow edges recursively.
    //    $graphLookup does recursive self-joins on the relations collection:
    //    - Start with relations where fromEntityId matches root entityId
    //    - Follow toEntityId -> fromEntityId edges for subsequent hops
    const relPipeline: Document[] = [
      { $match: { fromEntityId: entityId, agentId } },
      {
        $graphLookup: {
          from: `${prefix}relations`,
          startWith: "$toEntityId",
          connectFromField: "toEntityId",
          connectToField: "fromEntityId",
          as: "transitiveRelations",
          maxDepth: Math.max(0, (maxDepth ?? 2) - 1),
          depthField: "depth",
          restrictSearchWithMatch: { agentId },
        },
      },
    ];

    const relResults = await relCol.aggregate(relPipeline).toArray();

    // 3. Collect all unique relations with their depths
    // Direct relations are depth 0, transitive relations come from $graphLookup
    const relationsByKey = new Map<string, { relation: Document; depth: number }>();

    for (const directRel of relResults) {
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
        .find({ entityId: { $in: Array.from(connectedEntityIds) }, agentId })
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

    return { rootEntity, connections };
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
