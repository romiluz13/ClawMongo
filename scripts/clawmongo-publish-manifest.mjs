#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packagePath = path.join(root, "package.json");
const outputPath = path.join(root, ".artifacts", "clawmongo-package.json");

const raw = await fs.readFile(packagePath, "utf8");
const manifest = JSON.parse(raw);

manifest.name = "@romiluz/clawmongo";
manifest.description =
  "MongoDB-native fork of OpenClaw with MongoDB-only memory for multi-channel AI agents";
manifest.homepage = "https://github.com/romiluz13/ClawMongo#readme";
manifest.bugs = { url: "https://github.com/romiluz13/ClawMongo/issues" };
manifest.repository = {
  type: "git",
  url: "git+https://github.com/romiluz13/ClawMongo.git",
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outputPath)}`);
