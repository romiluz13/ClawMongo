/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import {
  upsertEntity,
  upsertRelation,
  findEntitiesByName,
  getEntitiesByType,
  expandGraph,
  deleteEntity,
  type Entity,
  type Relation,
} from "./mongodb-graph.js";

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(overrides: Partial<Record<string, unknown>> = {}): Collection {
  return {
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1, matchedCount: 0, modifiedCount: 0 }),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
      toArray: vi.fn().mockResolvedValue([]),
    }),
    aggregate: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    ...overrides,
  } as unknown as Collection;
}

function createMockDb(collections: Record<string, Collection>): Db {
  return {
    collection: vi.fn((name: string) => {
      return collections[name] ?? createMockCollection();
    }),
  } as unknown as Db;
}

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    entityId: "ent-1",
    name: "Alice",
    type: "person",
    agentId: "agent-1",
    scope: "agent",
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeRelation(overrides: Partial<Relation> = {}): Relation {
  return {
    fromEntityId: "ent-1",
    toEntityId: "ent-2",
    type: "works_on",
    agentId: "agent-1",
    scope: "agent",
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

const PREFIX = "test_";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-graph", () => {
  describe("upsertEntity", () => {
    it("creates a new entity", async () => {
      const entitiesCol = createMockCollection();
      const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol });
      const entity = makeEntity();

      const result = await upsertEntity({ db, prefix: PREFIX, entity });

      expect(result.upserted).toBe(true);
      expect(entitiesCol.updateOne).toHaveBeenCalledOnce();
      const [filter, update, opts] = (entitiesCol.updateOne as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(filter).toEqual({ entityId: "ent-1" });
      expect(update.$set).toBeDefined();
      expect(update.$set.name).toBe("Alice");
      expect(update.$set.type).toBe("person");
      expect(update.$set.agentId).toBe("agent-1");
      expect(update.$set.scope).toBe("agent");
      expect(update.$setOnInsert).toBeDefined();
      expect(opts).toEqual({ upsert: true });
    });

    it("updates existing entity (same entityId)", async () => {
      const entitiesCol = createMockCollection({
        updateOne: vi
          .fn()
          .mockResolvedValue({ upsertedCount: 0, matchedCount: 1, modifiedCount: 1 }),
      });
      const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol });
      const entity = makeEntity({ name: "Alice Updated" });

      const result = await upsertEntity({ db, prefix: PREFIX, entity });

      expect(result.upserted).toBe(false);
      const [, update] = (entitiesCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(update.$set.name).toBe("Alice Updated");
    });
  });

  describe("upsertRelation", () => {
    it("creates a relation between two entities", async () => {
      const relationsCol = createMockCollection();
      const db = createMockDb({ [`${PREFIX}relations`]: relationsCol });
      const relation = makeRelation();

      const result = await upsertRelation({ db, prefix: PREFIX, relation });

      expect(result.upserted).toBe(true);
      expect(relationsCol.updateOne).toHaveBeenCalledOnce();
      const [filter, update, opts] = (relationsCol.updateOne as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(filter).toEqual({
        fromEntityId: "ent-1",
        toEntityId: "ent-2",
        type: "works_on",
      });
      expect(update.$set.agentId).toBe("agent-1");
      expect(update.$set.scope).toBe("agent");
      expect(opts).toEqual({ upsert: true });
    });
  });

  describe("findEntitiesByName", () => {
    it("returns matching entities", async () => {
      const entityDoc = {
        entityId: "ent-1",
        name: "Alice",
        type: "person",
        agentId: "agent-1",
        scope: "agent",
        updatedAt: new Date("2026-01-01"),
      };
      const findResult = {
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([entityDoc]),
          }),
        }),
      };
      const entitiesCol = createMockCollection({
        find: vi.fn().mockReturnValue(findResult),
      });
      const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol });

      const results = await findEntitiesByName({
        db,
        prefix: PREFIX,
        query: "Alice",
        agentId: "agent-1",
      });

      expect(results).toHaveLength(1);
      expect(results[0].entityId).toBe("ent-1");
      expect(results[0].name).toBe("Alice");
      // Verify regex search on name/aliases
      const [filter] = (entitiesCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter.agentId).toBe("agent-1");
      expect(filter.$or).toBeDefined();
    });
  });

  describe("getEntitiesByType", () => {
    it("returns all entities of a given type", async () => {
      const docs = [
        {
          entityId: "ent-1",
          name: "Alice",
          type: "person",
          agentId: "agent-1",
          scope: "agent",
          updatedAt: new Date(),
        },
        {
          entityId: "ent-2",
          name: "Bob",
          type: "person",
          agentId: "agent-1",
          scope: "agent",
          updatedAt: new Date(),
        },
      ];
      const findResult = {
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(docs),
          }),
        }),
      };
      const entitiesCol = createMockCollection({
        find: vi.fn().mockReturnValue(findResult),
      });
      const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol });

      const results = await getEntitiesByType({
        db,
        prefix: PREFIX,
        type: "person",
        agentId: "agent-1",
      });

      expect(results).toHaveLength(2);
      const [filter] = (entitiesCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter).toEqual({ agentId: "agent-1", type: "person" });
    });
  });

  describe("expandGraph", () => {
    it("uses $graphLookup to find connected entities within maxDepth", async () => {
      const rootEntity = makeEntity();
      const connectedRelation = {
        fromEntityId: "ent-1",
        toEntityId: "ent-2",
        type: "works_on",
        agentId: "agent-1",
        scope: "agent",
        updatedAt: new Date("2026-01-01"),
        depth: 0,
      };
      const connectedEntity = makeEntity({ entityId: "ent-2", name: "ProjectX", type: "project" });

      // entities collection: findOne for root, find for connected entity lookup
      const entitiesCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([connectedEntity]),
        }),
      });
      // Override aggregate on entities for the root lookup, and relations for $graphLookup
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi
        .fn()
        .mockResolvedValue(rootEntity);

      const relationsCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([connectedRelation]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
      });

      const result = await expandGraph({
        db,
        prefix: PREFIX,
        entityId: "ent-1",
        agentId: "agent-1",
        maxDepth: 2,
      });

      expect(result).not.toBeNull();
      expect(result!.rootEntity.entityId).toBe("ent-1");
      expect(result!.connections).toHaveLength(1);
      expect(result!.connections[0].entity.entityId).toBe("ent-2");
      expect(result!.connections[0].relation.type).toBe("works_on");
      expect(result!.connections[0].depth).toBe(0);

      // Verify $graphLookup was used on relations collection
      expect(relationsCol.aggregate).toHaveBeenCalledOnce();
      const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>).mock.calls[0];
      // Find the $graphLookup stage
      const graphLookupStage = pipeline.find((s: Document) => s.$graphLookup);
      expect(graphLookupStage).toBeDefined();
      // maxDepth is (requested - 1) because the initial $match already captures direct edges
      expect(graphLookupStage.$graphLookup.maxDepth).toBe(1);
      expect(graphLookupStage.$graphLookup.restrictSearchWithMatch.agentId).toBe("agent-1");
    });

    it("respects agentId filter", async () => {
      // Root entity not found for different agent
      const entitiesCol = createMockCollection();
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi.fn().mockResolvedValue(null);
      const relationsCol = createMockCollection();

      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
      });

      const result = await expandGraph({
        db,
        prefix: PREFIX,
        entityId: "ent-1",
        agentId: "agent-other",
        maxDepth: 2,
      });

      // Should return null when root entity not found for agent
      expect(result).toBeNull();
    });
  });

  describe("deleteEntity", () => {
    it("removes entity and its relations scoped by agentId", async () => {
      const entitiesCol = createMockCollection({
        deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      });
      const relationsCol = createMockCollection({
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      });
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
      });

      const result = await deleteEntity({
        db,
        prefix: PREFIX,
        entityId: "ent-1",
        agentId: "agent-1",
      });

      expect(result.deletedEntity).toBe(true);
      expect(result.deletedRelations).toBe(3);
      // Verify entity deletion includes agentId
      expect(entitiesCol.deleteOne).toHaveBeenCalledWith({ entityId: "ent-1", agentId: "agent-1" });
      // Verify cascade deletion of relations includes agentId
      const [relFilter] = (relationsCol.deleteMany as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(relFilter.$or).toEqual([{ fromEntityId: "ent-1" }, { toEntityId: "ent-1" }]);
      expect(relFilter.agentId).toBe("agent-1");
    });
  });

  describe("error handling", () => {
    it("upsertEntity wraps and re-throws errors", async () => {
      const entitiesCol = createMockCollection({
        updateOne: vi.fn().mockRejectedValue(new Error("db write failed")),
      });
      const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol });

      await expect(upsertEntity({ db, prefix: PREFIX, entity: makeEntity() })).rejects.toThrow(
        "db write failed",
      );
    });

    it("deleteEntity wraps and re-throws errors", async () => {
      const entitiesCol = createMockCollection({
        deleteOne: vi.fn().mockRejectedValue(new Error("db delete failed")),
      });
      const db = createMockDb({ [`${PREFIX}entities`]: entitiesCol });

      await expect(
        deleteEntity({ db, prefix: PREFIX, entityId: "ent-1", agentId: "agent-1" }),
      ).rejects.toThrow("db delete failed");
    });
  });
});
