#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const distRoot = path.join(cwd, "dist");
const stampPath = path.join(distRoot, ".buildstamp");

let head = null;
try {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    const value = (result.stdout ?? "").trim();
    if (value) {
      head = value;
    }
  }
} catch {
  // Best effort only.
}

fs.mkdirSync(distRoot, { recursive: true });
fs.writeFileSync(stampPath, `${JSON.stringify({ builtAt: Date.now(), head })}\n`, "utf8");
