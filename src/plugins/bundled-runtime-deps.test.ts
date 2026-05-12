import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

function readJson(relativePath: string): PackageManifest {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as PackageManifest;
}

describe("bundled plugin runtime dependencies", () => {
  function expectPluginOwnsRuntimeDep(pluginPath: string, dependencyName: string) {
    const rootManifest = readJson("package.json");
    const pluginManifest = readJson(pluginPath);
    const pluginSpec = pluginManifest.dependencies?.[dependencyName];
    const rootSpec = rootManifest.dependencies?.[dependencyName];

    expect(pluginSpec).toBeTruthy();
    expect(rootSpec).toBeUndefined();
  }

  it("keeps bundled Feishu runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/feishu/package.json", "@larksuiteoapi/node-sdk");
  });

  it("keeps bundled Slack runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/slack/package.json", "@slack/bolt");
  });

  it("keeps bundled Telegram runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/telegram/package.json", "grammy");
  });

  it("keeps WhatsApp runtime deps plugin-local so packaged installs fetch them on demand", () => {
    expectPluginOwnsRuntimeDep("extensions/whatsapp/package.json", "baileys");
  });

  it("keeps WhatsApp image helper deps plugin-local so bundled builds resolve Baileys peers", () => {
    expectPluginOwnsRuntimeDep("extensions/whatsapp/package.json", "jimp");
  });

  it("keeps bundled Discord proxy-agent support plugin-local even though core also owns it", () => {
    const pluginManifest = readJson("extensions/discord/package.json");
    expect(pluginManifest.dependencies?.["https-proxy-agent"]).toBeTruthy();
  });
});
