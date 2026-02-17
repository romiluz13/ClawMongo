import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the subsystem logger
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

type MockDbOptions = {
  adminCommand?: ReturnType<typeof vi.fn>;
  listSearchIndexesSucceeds?: boolean;
  collectionNames?: string[];
};

function createMockDb(opts: MockDbOptions = {}) {
  const adminCmd = opts.adminCommand ?? vi.fn().mockRejectedValue(new Error("not configured"));
  const listSearchIndexesSucceeds = opts.listSearchIndexesSucceeds ?? false;
  const collectionNames = opts.collectionNames ?? ["test_collection"];

  return {
    admin: () => ({
      command: adminCmd,
    }),
    listCollections: () => ({
      toArray: vi.fn(async () => collectionNames.map((name) => ({ name }))),
    }),
    collection: () => ({
      listSearchIndexes: () => ({
        toArray: listSearchIndexesSucceeds
          ? vi.fn(async () => [{ name: "default" }])
          : vi.fn(async () => {
              throw new Error("Search indexes are not supported");
            }),
      }),
    }),
  } as unknown;
}

describe("detectTopology", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects replica set when replSetGetStatus succeeds", async () => {
    const { detectTopology } = await import("./mongodb-topology.js");
    const db = createMockDb({
      adminCommand: vi
        .fn()
        .mockResolvedValueOnce({ set: "rs0", members: [{}] }) // replSetGetStatus
        .mockResolvedValueOnce({ version: "8.2.0" }), // buildInfo
    });
    const result = await detectTopology(db as import("mongodb").Db);
    expect(result.isReplicaSet).toBe(true);
    expect(result.replicaSetName).toBe("rs0");
  });

  it("detects standalone when replSetGetStatus fails", async () => {
    const { detectTopology } = await import("./mongodb-topology.js");
    const db = createMockDb({
      adminCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error("not running with --replSet"))
        .mockResolvedValueOnce({ version: "8.2.0" }),
    });
    const result = await detectTopology(db as import("mongodb").Db);
    expect(result.isReplicaSet).toBe(false);
    expect(result.replicaSetName).toBeUndefined();
  });

  it("detects mongot when listSearchIndexes succeeds", async () => {
    const { detectTopology } = await import("./mongodb-topology.js");
    const db = createMockDb({
      adminCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error("not running with --replSet"))
        .mockResolvedValueOnce({ version: "8.2.0" }),
      listSearchIndexesSucceeds: true,
    });
    const result = await detectTopology(db as import("mongodb").Db);
    expect(result.hasMongot).toBe(true);
  });

  it("detects no mongot when listSearchIndexes fails", async () => {
    const { detectTopology } = await import("./mongodb-topology.js");
    const db = createMockDb({
      adminCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error("not running with --replSet"))
        .mockResolvedValueOnce({ version: "8.2.0" }),
      listSearchIndexesSucceeds: false,
    });
    const result = await detectTopology(db as import("mongodb").Db);
    expect(result.hasMongot).toBe(false);
  });

  it("extracts server version from buildInfo", async () => {
    const { detectTopology } = await import("./mongodb-topology.js");
    const db = createMockDb({
      adminCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error("not running with --replSet"))
        .mockResolvedValueOnce({ version: "8.2.5" }),
    });
    const result = await detectTopology(db as import("mongodb").Db);
    expect(result.serverVersion).toBe("8.2.5");
  });

  it("returns safe defaults when all probes fail", async () => {
    const { detectTopology } = await import("./mongodb-topology.js");
    const db = createMockDb({
      adminCommand: vi.fn().mockRejectedValue(new Error("connection closed")),
      collectionNames: [],
    });
    const result = await detectTopology(db as import("mongodb").Db);
    expect(result.isReplicaSet).toBe(false);
    expect(result.hasMongot).toBe(false);
    expect(result.serverVersion).toBe("unknown");
  });
});

describe("topologyToTier", () => {
  it("maps full stack topology to tier fullstack", async () => {
    const { topologyToTier } = await import("./mongodb-topology.js");
    expect(topologyToTier({ isReplicaSet: true, hasMongot: true, serverVersion: "8.2.0" })).toBe(
      "fullstack",
    );
  });

  it("maps replica set without mongot to tier replicaset", async () => {
    const { topologyToTier } = await import("./mongodb-topology.js");
    expect(topologyToTier({ isReplicaSet: true, hasMongot: false, serverVersion: "8.2.0" })).toBe(
      "replicaset",
    );
  });

  it("maps standalone to tier standalone", async () => {
    const { topologyToTier } = await import("./mongodb-topology.js");
    expect(topologyToTier({ isReplicaSet: false, hasMongot: false, serverVersion: "8.2.0" })).toBe(
      "standalone",
    );
  });

  it("maps standalone with mongot (unusual) to standalone", async () => {
    const { topologyToTier } = await import("./mongodb-topology.js");
    // mongot without replica set is unusual but possible; still standalone
    expect(topologyToTier({ isReplicaSet: false, hasMongot: true, serverVersion: "8.2.0" })).toBe(
      "standalone",
    );
  });
});

describe("suggestConnectionString", () => {
  it("suggests replicaSet in connection string for replica set", async () => {
    const { suggestConnectionString } = await import("./mongodb-topology.js");
    const suggestion = suggestConnectionString(
      { isReplicaSet: true, hasMongot: true, serverVersion: "8.2.0", replicaSetName: "rs0" },
      "mongodb://admin:admin@localhost:27017/?authSource=admin",
    );
    expect(suggestion).toContain("replicaSet=rs0");
  });

  it("does not modify URI if replicaSet already present", async () => {
    const { suggestConnectionString } = await import("./mongodb-topology.js");
    const uri = "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0";
    const suggestion = suggestConnectionString(
      { isReplicaSet: true, hasMongot: true, serverVersion: "8.2.0", replicaSetName: "rs0" },
      uri,
    );
    expect(suggestion).toBe(uri);
  });

  it("returns URI unchanged for standalone", async () => {
    const { suggestConnectionString } = await import("./mongodb-topology.js");
    const uri = "mongodb://localhost:27017";
    const suggestion = suggestConnectionString(
      { isReplicaSet: false, hasMongot: false, serverVersion: "8.2.0" },
      uri,
    );
    expect(suggestion).toBe(uri);
  });
});

describe("tierFeatures", () => {
  it("fullstack has no unavailable features", async () => {
    const { tierFeatures } = await import("./mongodb-topology.js");
    const features = tierFeatures("fullstack");
    expect(features.available.length).toBeGreaterThan(0);
    expect(features.unavailable.length).toBe(0);
  });

  it("replicaset lists missing vector search features", async () => {
    const { tierFeatures } = await import("./mongodb-topology.js");
    const features = tierFeatures("replicaset");
    expect(features.available.length).toBeGreaterThan(0);
    expect(features.unavailable.length).toBeGreaterThan(0);
    expect(features.unavailable.some((f) => f.includes("vectorSearch"))).toBe(true);
  });

  it("standalone lists most features as unavailable", async () => {
    const { tierFeatures } = await import("./mongodb-topology.js");
    const features = tierFeatures("standalone");
    expect(features.unavailable.length).toBeGreaterThan(features.available.length);
    expect(features.unavailable.some((f) => f.includes("transactions"))).toBe(true);
  });
});
