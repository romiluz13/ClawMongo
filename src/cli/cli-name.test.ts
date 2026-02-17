import { describe, expect, it } from "vitest";
import { replaceCliName, resolveCliName } from "./cli-name.js";

describe("resolveCliName", () => {
  it("detects openclaw binary name", () => {
    const name = resolveCliName(["node", "/usr/local/bin/openclaw"]);
    expect(name).toBe("openclaw");
  });

  it("detects clawmongo binary name", () => {
    const name = resolveCliName(["node", "/usr/local/bin/clawmongo"]);
    expect(name).toBe("clawmongo");
  });

  it("falls back to openclaw for unknown binary names", () => {
    const name = resolveCliName(["node", "/usr/local/bin/unknown-cli"]);
    expect(name).toBe("openclaw");
  });
});

describe("replaceCliName", () => {
  it("replaces openclaw commands with clawmongo when requested", () => {
    expect(replaceCliName("openclaw status", "clawmongo")).toBe("clawmongo status");
    expect(replaceCliName("pnpm openclaw status", "clawmongo")).toBe("pnpm clawmongo status");
  });

  it("normalizes clawmongo commands to openclaw when requested", () => {
    expect(replaceCliName("clawmongo status", "openclaw")).toBe("openclaw status");
    expect(replaceCliName("pnpm clawmongo status", "openclaw")).toBe("pnpm openclaw status");
  });
});
