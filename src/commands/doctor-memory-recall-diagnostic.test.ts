import { describe, it, expect } from "vitest";

describe("noteMemoryRecallDiagnostic", () => {
  it("returns MongoDB-adapted failure mode guidance when backend is mongodb", async () => {
    const { noteMemoryRecallDiagnostic } = await import("./doctor-memory-search.js");
    const result = noteMemoryRecallDiagnostic({ backend: "mongodb" });
    expect(result).toBeDefined();
    expect(result!.title).toBe("Memory Recall Diagnostic");
    expect(result!.lines).toContain("Not Retrieved");
    expect(result!.lines).toContain("Compaction Lost It");
    expect(result!.lines).toContain("Never Stored");
  });

  it("returns null when backend is not mongodb", async () => {
    const { noteMemoryRecallDiagnostic } = await import("./doctor-memory-search.js");
    const result = noteMemoryRecallDiagnostic({ backend: "local" });
    expect(result).toBeNull();
  });

  it("returns null when backend is undefined", async () => {
    const { noteMemoryRecallDiagnostic } = await import("./doctor-memory-search.js");
    const result = noteMemoryRecallDiagnostic({});
    expect(result).toBeNull();
  });
});
