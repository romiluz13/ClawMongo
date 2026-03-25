/* eslint-disable @typescript-eslint/unbound-method */
import type { Collection, Db } from "mongodb";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock telemetry (imported by mongodb-graph.ts)
vi.mock("./mongodb-telemetry.js", () => ({
  emitTelemetry: vi.fn(),
}));

import { upsertEntity, upsertRelation, type Entity, type Relation } from "./mongodb-graph.js";
import { writeStructuredMemory, type StructuredMemoryEntry } from "./mongodb-structured-memory.js";

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(overrides: Partial<Record<string, unknown>> = {}): Collection {
  return {
    findOne: vi.fn(async () => null),
    updateOne: vi.fn(async () => ({
      upsertedCount: 1,
      upsertedId: "new-id",
      modifiedCount: 0,
    })),
    insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "rev-1" })),
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
    find: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
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
// Tests: P4 — Mutation Audit Integration
// ---------------------------------------------------------------------------

describe("P4: audit integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("writeStructuredMemory records mutation", () => {
    it("fires recordMutation after creating a new structured memory entry", async () => {
      const col = createMockCollection();
      const revisionsCol = createMockCollection();
      const mutationsCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}structured_mem`]: col,
        [`${PREFIX}structured_mem_revisions`]: revisionsCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });

      const entry: StructuredMemoryEntry = {
        type: "decision",
        key: "framework-choice",
        value: "Using React",
        agentId: "main",
      };

      await writeStructuredMemory({
        db,
        prefix: PREFIX,
        entry,
        embeddingMode: "automated",
      });

      expect(mutationsCol.insertOne).toHaveBeenCalledOnce();
      const [doc] = (mutationsCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(doc.collectionName).toBe("structured_mem");
      expect(doc.operation).toBe("create");
      expect(doc.agentId).toBe("main");
      expect(doc.oldValue).toBeNull();
      expect(doc.newValue).toBeDefined();
      expect(doc.actorRole).toBe("system");
    });

    it("records 'update' operation with changedFields when value changes", async () => {
      const col = createMockCollection({
        findOne: vi.fn().mockResolvedValue({
          type: "preference",
          key: "editor",
          value: "VSCode",
          agentId: "main",
          scope: "agent",
          scopeRef: "agent:main",
          revision: 1,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        }),
        updateOne: vi.fn(async () => ({
          upsertedCount: 0,
          matchedCount: 1,
          modifiedCount: 1,
        })),
      });
      const revisionsCol = createMockCollection();
      const mutationsCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}structured_mem`]: col,
        [`${PREFIX}structured_mem_revisions`]: revisionsCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });

      const entry: StructuredMemoryEntry = {
        type: "preference",
        key: "editor",
        value: "Neovim",
        agentId: "main",
      };

      await writeStructuredMemory({
        db,
        prefix: PREFIX,
        entry,
        embeddingMode: "automated",
      });

      expect(mutationsCol.insertOne).toHaveBeenCalledOnce();
      const [doc] = (mutationsCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(doc.operation).toBe("update");
      expect(doc.changedFields).toContain("value");
    });
  });

  describe("upsertEntity records mutation", () => {
    it("fires recordMutation after creating a new entity", async () => {
      const entitiesCol = createMockCollection();
      const mutationsCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });
      const entity = makeEntity();

      await upsertEntity({ db, prefix: PREFIX, entity });

      expect(mutationsCol.insertOne).toHaveBeenCalledOnce();
      const [doc] = (mutationsCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(doc.collectionName).toBe("entities");
      expect(doc.operation).toBe("create");
      expect(doc.documentId).toBe("ent-1");
      expect(doc.agentId).toBe("agent-1");
      expect(doc.oldValue).toBeNull();
      expect(doc.actorRole).toBe("system");
    });

    it("fires recordMutation with 'update' when entity already exists", async () => {
      const entitiesCol = createMockCollection({
        updateOne: vi
          .fn()
          .mockResolvedValue({ upsertedCount: 0, matchedCount: 1, modifiedCount: 1 }),
      });
      const mutationsCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });
      const entity = makeEntity({ name: "Alice Updated" });

      await upsertEntity({ db, prefix: PREFIX, entity });

      expect(mutationsCol.insertOne).toHaveBeenCalledOnce();
      const [doc] = (mutationsCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(doc.operation).toBe("update");
    });
  });

  describe("upsertRelation records mutation", () => {
    it("fires recordMutation after creating a new relation", async () => {
      const relationsCol = createMockCollection();
      const mutationsCol = createMockCollection();
      const db = createMockDb({
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });
      const relation = makeRelation();

      await upsertRelation({ db, prefix: PREFIX, relation });

      expect(mutationsCol.insertOne).toHaveBeenCalledOnce();
      const [doc] = (mutationsCol.insertOne as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(doc.collectionName).toBe("relations");
      expect(doc.operation).toBe("create");
      expect(doc.documentId).toContain("ent-1");
      expect(doc.agentId).toBe("agent-1");
      expect(doc.oldValue).toBeNull();
      expect(doc.actorRole).toBe("system");
    });
  });

  describe("audit failure does not break primary write", () => {
    it("writeStructuredMemory succeeds even when recordMutation throws", async () => {
      const col = createMockCollection();
      const revisionsCol = createMockCollection();
      const mutationsCol = createMockCollection({
        insertOne: vi.fn().mockRejectedValueOnce(new Error("audit db down")),
      });
      const db = createMockDb({
        [`${PREFIX}structured_mem`]: col,
        [`${PREFIX}structured_mem_revisions`]: revisionsCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });

      const entry: StructuredMemoryEntry = {
        type: "fact",
        key: "test",
        value: "Still works",
        agentId: "main",
      };

      const result = await writeStructuredMemory({
        db,
        prefix: PREFIX,
        entry,
        embeddingMode: "automated",
      });

      // Primary write still succeeds
      expect(result.upserted).toBe(true);
      expect(result.id).toBeDefined();
    });

    it("upsertEntity succeeds even when recordMutation throws", async () => {
      const entitiesCol = createMockCollection();
      const mutationsCol = createMockCollection({
        insertOne: vi.fn().mockRejectedValueOnce(new Error("audit db down")),
      });
      const db = createMockDb({
        [`${PREFIX}entities`]: entitiesCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });
      const entity = makeEntity();

      const result = await upsertEntity({ db, prefix: PREFIX, entity });

      // Primary write still succeeds
      expect(result.upserted).toBe(true);
    });

    it("upsertRelation succeeds even when recordMutation throws", async () => {
      const relationsCol = createMockCollection();
      const mutationsCol = createMockCollection({
        insertOne: vi.fn().mockRejectedValueOnce(new Error("audit db down")),
      });
      const db = createMockDb({
        [`${PREFIX}relations`]: relationsCol,
        [`${PREFIX}memory_mutations`]: mutationsCol,
      });
      const relation = makeRelation();

      const result = await upsertRelation({ db, prefix: PREFIX, relation });

      // Primary write still succeeds
      expect(result.upserted).toBe(true);
    });
  });
});
