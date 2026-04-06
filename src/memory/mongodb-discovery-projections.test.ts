import type { Collection, Db, Document } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mongodb-schema.js", () => ({
  entitiesCollection: vi.fn(),
  episodesCollection: vi.fn(),
  eventsCollection: vi.fn(),
  proceduresCollection: vi.fn(),
  relationsCollection: vi.fn(),
  structuredMemCollection: vi.fn(),
  structuredMemRevisionsCollection: vi.fn(),
}));

vi.mock("./mongodb-ops.js", () => ({
  recordProjectionRun: vi.fn(async () => "run-1"),
}));

import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js";
import { recordProjectionRun } from "./mongodb-ops.js";
import {
  episodesCollection,
  eventsCollection,
  proceduresCollection,
  structuredMemCollection,
  structuredMemRevisionsCollection,
} from "./mongodb-schema.js";

function createFindCollection(docs: Document[]): Collection {
  const cursor = {
    sort: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue(docs),
  };
  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  return {
    find: vi.fn().mockReturnValue(cursor),
  } as unknown as Collection;
}

describe("mongodb-discovery-projections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a topic brief from episodes, durable memory, and procedures", async () => {
    vi.mocked(episodesCollection).mockReturnValue(
      createFindCollection([
        {
          episodeId: "ep-1",
          title: "Phoenix launch review",
          summary: "Launch timing and blockers were reviewed.",
          topics: ["phoenix"],
          scope: "workspace",
          scopeRef: "workspace:demo",
          timeRange: { end: new Date("2026-04-05T11:00:00.000Z") },
        },
      ]),
    );
    vi.mocked(structuredMemCollection).mockReturnValue(
      createFindCollection([
        {
          type: "project",
          key: "phoenix",
          value: "Phoenix remains blocked on Atlas Local preview validation.",
          state: "active",
          scope: "workspace",
          scopeRef: "workspace:demo",
          updatedAt: new Date("2026-04-05T10:00:00.000Z"),
        },
      ]),
    );
    vi.mocked(proceduresCollection).mockReturnValue(
      createFindCollection([
        {
          procedureId: "phoenix-rollback",
          name: "Phoenix rollback",
          searchText: "Phoenix rollback disable rollout restore stable image",
          steps: ["Disable rollout", "Restore stable image"],
          state: "active",
          scope: "workspace",
          scopeRef: "workspace:demo",
          updatedAt: new Date("2026-04-05T09:00:00.000Z"),
        },
      ]),
    );

    const projection = await buildDiscoveryProjection({
      db: {} as Db,
      prefix: "test_",
      agentId: "agent-1",
      kind: "topic-brief",
      query: "Phoenix",
      scope: "workspace",
      scopeRef: "workspace:demo",
      maxItems: 4,
    });

    expect(projection.title).toBe("Phoenix topic brief");
    expect(projection.sections.map((section) => section.title)).toEqual([
      "Recent episodes",
      "Durable memory",
      "Procedures",
    ]);
    expect(projection.metadata.evidenceCount).toBe(3);
    expect(recordProjectionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          projectionType: "topic-brief",
          status: "ok",
        }),
      }),
    );
  });

  it("builds a what-changed projection from revisions, procedure updates, and recent anchors", async () => {
    vi.mocked(structuredMemRevisionsCollection).mockReturnValue(
      createFindCollection([
        {
          type: "project",
          key: "phoenix",
          previousValue: "Phoenix is on track.",
          value: "Phoenix is blocked on validation.",
          supersededAt: new Date("2026-04-05T12:00:00.000Z"),
          scope: "workspace",
          scopeRef: "workspace:demo",
        },
      ]),
    );
    vi.mocked(structuredMemCollection).mockReturnValue(
      createFindCollection([
        {
          type: "project",
          key: "phoenix",
          value: "Phoenix is blocked on validation.",
          state: "active",
          updatedAt: new Date("2026-04-05T12:05:00.000Z"),
          scope: "workspace",
          scopeRef: "workspace:demo",
        },
      ]),
    );
    vi.mocked(proceduresCollection).mockReturnValue(
      createFindCollection([
        {
          procedureId: "phoenix-rollback",
          name: "Phoenix rollback",
          searchText: "Rollback if validation fails",
          updatedAt: new Date("2026-04-05T11:00:00.000Z"),
          scope: "workspace",
          scopeRef: "workspace:demo",
        },
      ]),
    );
    vi.mocked(eventsCollection).mockReturnValue(
      createFindCollection([
        {
          eventId: "evt-1",
          role: "assistant",
          body: "Validation is still blocking Phoenix.",
          timestamp: new Date("2026-04-05T12:10:00.000Z"),
          scope: "workspace",
          scopeRef: "workspace:demo",
        },
      ]),
    );

    const projection = await buildDiscoveryProjection({
      db: {} as Db,
      prefix: "test_",
      agentId: "agent-1",
      kind: "what-changed",
      query: "Phoenix",
      scope: "workspace",
      scopeRef: "workspace:demo",
      maxItems: 4,
      timeRange: { preset: "last-7d" },
    });

    expect(projection.title).toBe("What changed for Phoenix");
    expect(projection.sections.map((section) => section.title)).toEqual([
      "Structured changes",
      "Procedure changes",
      "Recent anchors",
    ]);
    expect(projection.metadata.evidenceCount).toBe(3);
    expect(projection.metadata.timeRange?.label).toBe("last-7d");
  });
});
