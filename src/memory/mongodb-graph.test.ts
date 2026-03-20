/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb";
import { describe, it, expect, vi } from "vitest";
import {
  upsertEntity,
  upsertRelation,
  upsertEntityLink,
  setEntityLinkStatus,
  getEntityLinks,
  findEntitiesByName,
  getEntitiesByType,
  expandGraph,
  deleteEntity,
  extractAndUpsertEntities,
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
      expect(filter).toEqual({
        entityId: "ent-1",
        agentId: "agent-1",
        scope: "agent",
        scopeRef: "agent:agent-1",
      });
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
        agentId: "agent-1",
        scope: "agent",
        scopeRef: "agent:agent-1",
      });
      expect(update.$set.agentId).toBe("agent-1");
      expect(update.$set.scope).toBe("agent");
      expect(opts).toEqual({ upsert: true });
    });
  });

  describe("upsertEntityLink", () => {
    it("stores candidate links with a canonicalized entity pair", async () => {
      const entityLinksCol = createMockCollection();
      const db = createMockDb({ [`${PREFIX}entity_links`]: entityLinksCol });

      const result = await upsertEntityLink({
        db,
        prefix: PREFIX,
        link: {
          fromEntityId: "ent-z",
          toEntityId: "ent-a",
          linkType: "candidate_same",
          status: "active",
          confidence: 0.65,
          agentId: "agent-1",
          scope: "agent",
        },
      });

      expect(result.linkId).toBeTruthy();
      const [filter, update, opts] = (entityLinksCol.updateOne as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(filter).toEqual({
        agentId: "agent-1",
        scope: "agent",
        scopeRef: "agent:agent-1",
        fromEntityId: "ent-a",
        toEntityId: "ent-z",
        linkType: "candidate_same",
      });
      expect(update.$set.status).toBe("active");
      expect(update.$set.confidence).toBe(0.65);
      expect(opts).toEqual({ upsert: true });
    });
  });

  describe("setEntityLinkStatus", () => {
    it("marks an existing link as rejected without changing the pair identity", async () => {
      const entityLinksCol = createMockCollection({
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      });
      const db = createMockDb({ [`${PREFIX}entity_links`]: entityLinksCol });

      const changed = await setEntityLinkStatus({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        scope: "agent",
        fromEntityId: "ent-b",
        toEntityId: "ent-a",
        linkType: "candidate_same",
        status: "rejected",
      });

      expect(changed).toBe(true);
      const [filter, update] = (entityLinksCol.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter.fromEntityId).toBe("ent-a");
      expect(filter.toEntityId).toBe("ent-b");
      expect(update.$set.status).toBe("rejected");
    });
  });

  describe("getEntityLinks", () => {
    it("returns links touching the requested entity", async () => {
      const docs = [
        {
          linkId: "link-1",
          fromEntityId: "ent-1",
          toEntityId: "ent-2",
          linkType: "candidate_same",
          status: "active",
          confidence: 0.65,
          agentId: "agent-1",
          scope: "agent",
          scopeRef: "agent:agent-1",
          updatedAt: new Date(),
        },
      ];
      const entityLinksCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              toArray: vi.fn().mockResolvedValue(docs),
            }),
          }),
        }),
      });
      const db = createMockDb({ [`${PREFIX}entity_links`]: entityLinksCol });

      const results = await getEntityLinks({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        entityId: "ent-1",
        status: "active",
      });

      expect(results).toHaveLength(1);
      const [filter] = (entityLinksCol.find as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(filter.agentId).toBe("agent-1");
      expect(filter.status).toBe("active");
      expect(filter.$or).toEqual([{ fromEntityId: "ent-1" }, { toEntityId: "ent-1" }]);
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

  describe("expandGraph bidirectional", () => {
    it("backward compatible: bidirectional defaults to false (no $facet)", async () => {
      const rootEntity = makeEntity();
      const entitiesCol = createMockCollection();
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi
        .fn()
        .mockResolvedValue(rootEntity);

      const relationsCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
      });

      await expandGraph({
        db,
        prefix: PREFIX,
        entityId: "ent-1",
        agentId: "agent-1",
      });

      // Should NOT use $facet when bidirectional is not set
      const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>).mock.calls[0];
      const facetStage = pipeline.find((s: Document) => s.$facet);
      expect(facetStage).toBeUndefined();
    });

    it("bidirectional=true uses $facet for parallel traversal", async () => {
      const rootEntity = makeEntity();
      const entitiesCol = createMockCollection();
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi
        .fn()
        .mockResolvedValue(rootEntity);

      const relationsCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([{ forward: [], reverse: [] }]),
        }),
      });

      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
      });

      await expandGraph({
        db,
        prefix: PREFIX,
        entityId: "ent-1",
        agentId: "agent-1",
        bidirectional: true,
      });

      // Should use $facet when bidirectional=true
      const [pipeline] = (relationsCol.aggregate as ReturnType<typeof vi.fn>).mock.calls[0];
      const facetStage = pipeline.find((s: Document) => s.$facet);
      expect(facetStage).toBeDefined();
      expect(facetStage.$facet.forward).toBeDefined();
      expect(facetStage.$facet.reverse).toBeDefined();
    });

    it("maxConnections limits total connections returned", async () => {
      const rootEntity = makeEntity();
      const entities = Array.from({ length: 10 }, (_, i) =>
        makeEntity({ entityId: `ent-${i + 2}`, name: `Entity${i + 2}`, type: "project" }),
      );

      const entitiesCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(entities),
        }),
      });
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi
        .fn()
        .mockResolvedValue(rootEntity);

      // Create 10 forward relations
      const forwardRels = entities.map((e) => ({
        fromEntityId: "ent-1",
        toEntityId: e.entityId,
        type: "works_on",
        agentId: "agent-1",
        scope: "agent",
        updatedAt: new Date("2026-01-01"),
        transitiveRelations: [],
      }));

      const relationsCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(forwardRels),
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
        maxConnections: 5,
      });

      expect(result).not.toBeNull();
      expect(result!.connections.length).toBeLessThanOrEqual(5);
    });

    it("orders connections by depth and relation quality before truncation", async () => {
      const rootEntity = makeEntity();
      const entities = [
        makeEntity({ entityId: "ent-2", name: "RelatedDoc", type: "document" }),
        makeEntity({ entityId: "ent-3", name: "ProjectX", type: "project" }),
        makeEntity({ entityId: "ent-4", name: "DependencyY", type: "project" }),
      ];

      const entitiesCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(entities),
        }),
      });
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi
        .fn()
        .mockResolvedValue(rootEntity);

      const relationsCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            {
              fromEntityId: "ent-1",
              toEntityId: "ent-2",
              type: "mentioned_with",
              weight: 0.2,
              agentId: "agent-1",
              scope: "agent",
              updatedAt: new Date("2026-01-03"),
              transitiveRelations: [],
            },
            {
              fromEntityId: "ent-1",
              toEntityId: "ent-3",
              type: "works_on",
              weight: 0.1,
              agentId: "agent-1",
              scope: "agent",
              updatedAt: new Date("2026-01-02"),
              transitiveRelations: [],
            },
            {
              fromEntityId: "ent-1",
              toEntityId: "ent-4",
              type: "depends_on",
              weight: 0.1,
              agentId: "agent-1",
              scope: "agent",
              updatedAt: new Date("2026-01-01"),
              transitiveRelations: [
                { fromEntityId: "ent-3", toEntityId: "ent-4", type: "depends_on", depth: 0 },
              ],
            },
          ]),
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
        maxConnections: 2,
      });

      expect(result).not.toBeNull();
      expect(result!.connections).toHaveLength(2);
      expect(result!.connections[0]?.entity.name).toBe("ProjectX");
      expect(result!.connections[1]?.entity.name).toBe("DependencyY");
    });

    it("deduplicates connections from forward and reverse traversal", async () => {
      const rootEntity = makeEntity();
      const connectedEntity = makeEntity({ entityId: "ent-2", name: "ProjectX", type: "project" });

      const entitiesCol = createMockCollection({
        find: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([connectedEntity]),
        }),
      });
      (entitiesCol as unknown as Record<string, unknown>).findOne = vi
        .fn()
        .mockResolvedValue(rootEntity);

      // Same relation appears in both forward and reverse
      const facetResult = {
        forward: [
          {
            fromEntityId: "ent-1",
            toEntityId: "ent-2",
            type: "works_on",
            agentId: "agent-1",
            scope: "agent",
            updatedAt: new Date("2026-01-01"),
            transitiveRelations: [],
          },
        ],
        reverse: [
          {
            fromEntityId: "ent-1",
            toEntityId: "ent-2",
            type: "works_on",
            agentId: "agent-1",
            scope: "agent",
            updatedAt: new Date("2026-01-01"),
            transitiveRelations: [],
          },
        ],
      };

      const relationsCol = createMockCollection({
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([facetResult]),
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
        bidirectional: true,
      });

      expect(result).not.toBeNull();
      // Same relation in forward and reverse should be deduped
      expect(result!.connections).toHaveLength(1);
      expect(result!.connections[0].entity.entityId).toBe("ent-2");
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

  describe("extractAndUpsertEntities", () => {
    it("extracts @mentions as person entities", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "Talked to @alice about the project",
        scope: "agent",
      });

      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "alice", type: "person" }),
      );
    });

    it("extracts #tags as topic entities", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "Working on #frontend #refactor today",
        scope: "agent",
      });

      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].type).toBe("topic");
      expect(result.entities[1].type).toBe("topic");
    });

    it("extracts URLs as document entities", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "See https://example.com/docs for details",
        scope: "agent",
      });

      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "https://example.com/docs", type: "document" }),
      );
    });

    it("extracts file paths as document entities", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "Modified src/memory/mongodb-graph.ts",
        scope: "agent",
      });

      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "src/memory/mongodb-graph.ts", type: "document" }),
      );
    });

    it("extracts 'quoted names' as person entities (min 3 chars)", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: 'Meeting with "John Smith" about the design',
        scope: "agent",
      });

      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "John Smith", type: "person" }),
      );
    });

    it("filters out stop words and short names", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: '"the" and "is" are not names. @me is too short',
        scope: "agent",
      });

      expect(result.entities).toHaveLength(0);
    });

    it("generates deterministic entityIds via hash", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result1 = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "Talked to @alice",
        scope: "agent",
      });
      const result2 = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "Met @alice again",
        scope: "agent",
      });

      // Same @alice -> same entityId
      const id1 = result1.entities.find((e) => e.name === "alice")?.entityId;
      const id2 = result2.entities.find((e) => e.name === "alice")?.entityId;
      expect(id1).toBe(id2);
    });

    it("returns empty result for content with no extractable entities", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      const result = await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: "Just a plain message with no entities",
        scope: "agent",
      });

      expect(result.entities).toHaveLength(0);
    });

    it("creates candidate_same links for ambiguous person mentions without merging them", async () => {
      const entitiesCol = createMockCollection();
      const relationsCol = createMockCollection();
      const entityLinksCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}entity_links`]: entityLinksCol,
      });

      await extractAndUpsertEntities({
        db,
        prefix: PREFIX,
        agentId: "agent-1",
        eventContent: 'Pair @sarah with "Sarah Chen" on the design review.',
        scope: "agent",
        sourceEventId: "evt-1",
      });

      const linkCalls = (entityLinksCol.updateOne as ReturnType<typeof vi.fn>).mock.calls;
      expect(linkCalls.length).toBeGreaterThan(0);
      const candidateCall = linkCalls.find(
        ([filter]: [Record<string, unknown>]) => filter.linkType === "candidate_same",
      );
      expect(candidateCall).toBeDefined();
      expect(candidateCall?.[1].$set.status).toBe("active");
      expect(candidateCall?.[1].$set.provenance.heuristic).toBe("shared-name-tokens");
    });
  });
});
