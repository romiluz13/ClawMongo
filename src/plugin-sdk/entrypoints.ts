import pluginSdkEntryList from "../../scripts/lib/plugin-sdk-entrypoints.json" with { type: "json" };

// Keep ClawMongo aligned with upstream plugin-sdk entrypoints while refusing
// to surface the removed LanceDB memory backend from package exports/builds.
export const pluginSdkEntrypoints = pluginSdkEntryList.filter(
  (entry) => entry !== "memory-lancedb",
);

export const pluginSdkSubpaths = pluginSdkEntrypoints.filter((entry) => entry !== "index");

/** Map every SDK entrypoint name to its source file path inside the repo. */
export function buildPluginSdkEntrySources() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]),
  );
}

/** List the public package specifiers that should resolve to plugin SDK entrypoints. */
export function buildPluginSdkSpecifiers() {
  return pluginSdkEntrypoints.map((entry) =>
    entry === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entry}`,
  );
}

/** Build the package.json exports map for all plugin SDK subpaths. */
export function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [
      entry === "index" ? "./plugin-sdk" : `./plugin-sdk/${entry}`,
      {
        types: `./dist/plugin-sdk/${entry}.d.ts`,
        default: `./dist/plugin-sdk/${entry}.js`,
      },
    ]),
  );
}

/** List the dist artifacts expected for every generated plugin SDK entrypoint. */
export function listPluginSdkDistArtifacts() {
  return pluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}
