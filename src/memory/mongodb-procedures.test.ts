/* eslint-disable @typescript-eslint/unbound-method */

import type { Collection, Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { searchProcedures, writeProcedure, type ProcedureEntry } from "./mongodb-procedures.js";
import type { DetectedCapabilities } from "./mongodb-schema.js";

function createMockProcedureCol(): Collection {
  return {
    findOne: vi.fn(async () => null),
    updateOne: vi.fn(async () => ({
      upsertedCount: 1,
      upsertedId: "proc-1",
      modifiedCount: 0,
    })),
    insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "proc-rev-1" })),
    aggregate: vi.fn(() => ({
      toArray: vi.fn(async () => []),
    })),
  } as unknown as Collection;
}

function mockDb(collections: Record<string, Collection> = {}): Db {
  return {
    collection: vi.fn((name: string) => collections[name] ?? createMockProcedureCol()),
  } as unknown as Db;
}

const baseCapabilities: DetectedCapabilities = {
  vectorSearch: true,
  textSearch: true,
  scoreFusion: false,
  rankFusion: false,
};

describe("mongodb-procedures", () => {
  it("creates a procedure entry with derived search text", async () => {
    const col = createMockProcedureCol();
    const revisions = createMockProcedureCol();
    const entry: ProcedureEntry = {
      procedureId: "rotate-auth",
      name: "Rotate auth keys",
      intentTags: ["auth", "runbook"],
      triggerQueries: ["how do we rotate auth keys"],
      steps: ["Pause issuance", "Rotate keys", "Validate clients"],
      successSignals: ["All clients reconnect"],
      agentId: "main",
    };

    await writeProcedure({
      db: mockDb({
        test_procedures: col,
        test_procedure_revisions: revisions,
      }),
      prefix: "test_",
      entry,
      embeddingMode: "automated",
    });

    const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[0]).toEqual({
      procedureId: "rotate-auth",
      agentId: "main",
      scope: "agent",
      scopeRef: "agent:main",
    });
    expect(updateCall[1].$set.searchText).toContain("Rotate auth keys");
    expect(updateCall[1].$set.searchText).toContain("Validate clients");
  });

  it("searches procedures and returns procedure locators", async () => {
    const col = createMockProcedureCol();
    vi.mocked(col.aggregate).mockReturnValue({
      toArray: vi.fn(async () => [
        { procedureId: "rotate-auth", searchText: "Rotate auth keys", score: 0.92 },
      ]),
    } as ReturnType<typeof col.aggregate>);

    const results = await searchProcedures(col, "rotate auth", null, {
      maxResults: 5,
      filter: { agentId: "main", state: "active" },
      capabilities: baseCapabilities,
      vectorIndexName: "test_procedures_vector",
      embeddingMode: "automated",
    });

    expect(results).toEqual([
      expect.objectContaining({
        path: "procedure:rotate-auth",
        source: "structured",
      }),
    ]);
  });
});
