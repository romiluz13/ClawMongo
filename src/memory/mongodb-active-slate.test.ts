import type { Collection, Db, Document } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mongodb-schema.js", () => ({
  eventsCollection: vi.fn(),
  proceduresCollection: vi.fn(),
  structuredMemCollection: vi.fn(),
}));

vi.mock("./mongodb-telemetry.js", () => ({
  emitTelemetry: vi.fn(),
}));

import { hydrateActiveSlate } from "./mongodb-active-slate.js";
import {
  eventsCollection,
  proceduresCollection,
  structuredMemCollection,
} from "./mongodb-schema.js";
import { emitTelemetry } from "./mongodb-telemetry.js";

const PREFIX = "test_";
const AGENT_ID = "agent-1";
const SCOPE = "workspace" as const;
const SCOPE_REF = "workspace:demo";

function createMockFindCollection(docs: Document[]): Collection {
  const cursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    project: vi.fn(),
    toArray: vi.fn().mockResolvedValue(docs),
  };
  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  cursor.project.mockReturnValue(cursor);
  return {
    find: vi.fn().mockReturnValue(cursor),
  } as unknown as Collection;
}

function defaultParams() {
  return {
    db: {} as Db,
    prefix: PREFIX,
    agentId: AGENT_ID,
    scope: SCOPE,
    scopeRef: SCOPE_REF,
  };
}

describe("mongodb-active-slate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates a prioritized slate from active memory, procedures, and recent anchors", async () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    vi.mocked(structuredMemCollection)
      .mockReturnValueOnce(
        createMockFindCollection([
          {
            type: "todo",
            key: "blocker-db-migration",
            value: "Database migration is blocked on rollout approval.",
            salience: "critical",
            state: "active",
            updatedAt: new Date("2026-04-05T11:30:00.000Z"),
            scope: SCOPE,
            scopeRef: SCOPE_REF,
            sourceEventIds: ["evt-1"],
          },
        ]),
      )
      .mockReturnValueOnce(
        createMockFindCollection([
          {
            type: "decision",
            key: "decision-memory-routing",
            value: "Use trust-aware routing for current-state recall.",
            salience: "high",
            state: "active",
            updatedAt: new Date("2026-04-05T10:00:00.000Z"),
            scope: SCOPE,
            scopeRef: SCOPE_REF,
            sourceEventIds: ["evt-2"],
          },
        ]),
      );
    vi.mocked(proceduresCollection).mockReturnValue(
      createMockFindCollection([
        {
          procedureId: "rollback-memory",
          name: "Rollback memory routing changes",
          steps: ["Disable flag", "Re-run proof pack", "Restore prior policy"],
          state: "active",
          updatedAt: new Date("2026-04-05T11:00:00.000Z"),
          scope: SCOPE,
          scopeRef: SCOPE_REF,
          sourceEventIds: ["evt-3"],
        },
      ]),
    );
    vi.mocked(eventsCollection).mockReturnValue(
      createMockFindCollection([
        {
          eventId: "evt-4",
          role: "user",
          body: "We still need seeded proof before rollout.",
          timestamp: new Date("2026-04-05T11:45:00.000Z"),
          scope: SCOPE,
          scopeRef: SCOPE_REF,
        },
      ]),
    );

    const slate = await hydrateActiveSlate({
      ...defaultParams(),
      maxItems: 4,
    });

    expect(slate.agentId).toBe(AGENT_ID);
    expect(slate.scope).toBe(SCOPE);
    expect(slate.scopeRef).toBe(SCOPE_REF);
    expect(slate.items).toHaveLength(4);
    expect(slate.items.map((item) => item.kind)).toEqual([
      "active-critical",
      "procedure",
      "decision",
      "recent-anchor",
    ]);
    expect(slate.items.map((item) => item.path)).toEqual([
      `structured:todo:blocker-db-migration?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
      "procedure:rollback-memory",
      `structured:decision:decision-memory-routing?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
      "events/evt-4",
    ]);
    expect(slate.metadata.maxItems).toBe(4);
    expect(slate.metadata.truncated).toBe(false);
    expect(slate.metadata.countsByKind).toEqual({
      "active-critical": 1,
      procedure: 1,
      decision: 1,
      "recent-anchor": 1,
    });
    expect(emitTelemetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        meta: expect.objectContaining({
          operation: "active-slate-hydration",
        }),
      }),
    );

    vi.useRealTimers();
  });

  it("returns partial results when one source query fails", async () => {
    const failingStructured = {
      find: vi.fn(() => {
        throw new Error("structured timeout");
      }),
    } as unknown as Collection;
    vi.mocked(structuredMemCollection)
      .mockReturnValueOnce(failingStructured)
      .mockReturnValueOnce(createMockFindCollection([]));
    vi.mocked(proceduresCollection).mockReturnValue(
      createMockFindCollection([
        {
          procedureId: "keep-running",
          name: "Keep running proof pack",
          steps: ["Seed", "Run", "Compare"],
          state: "active",
          updatedAt: new Date("2026-04-05T11:00:00.000Z"),
          scope: SCOPE,
          scopeRef: SCOPE_REF,
        },
      ]),
    );
    vi.mocked(eventsCollection).mockReturnValue(createMockFindCollection([]));

    const slate = await hydrateActiveSlate(defaultParams());

    expect(slate.items).toHaveLength(1);
    expect(slate.items[0]?.kind).toBe("procedure");
    expect(slate.metadata.partial).toBe(true);
  });
});
