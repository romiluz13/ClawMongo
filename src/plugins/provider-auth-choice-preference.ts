import type { OpenClawConfig } from "../config/config.js";
import {
  resolveProviderPluginChoice,
  resolvePluginProviders,
} from "./provider-auth-choice.runtime.js";
import { resolveManifestProviderAuthChoice } from "./provider-auth-choices.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<string, string>> = {
  chutes: "chutes",
  "litellm-api-key": "litellm",
  "custom-api-key": "custom",
};

function normalizeLegacyAuthChoice(choice: string): string {
  if (choice === "oauth") {
    return "setup-token";
  }
  if (choice === "claude-cli") {
    return "setup-token";
  }
  if (choice === "codex-cli") {
    return "openai-codex";
  }
  return choice;
}

export async function resolvePreferredProviderForAuthChoice(params: {
  choice: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const choice = normalizeLegacyAuthChoice(params.choice) ?? params.choice;
  const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
  if (manifestResolved) {
    return manifestResolved.providerId;
  }

  const preferred = PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
  if (preferred) {
    return preferred;
  }
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  const pluginResolved = resolveProviderPluginChoice({
    providers,
    choice,
  });
  if (pluginResolved) {
    return pluginResolved.provider.id;
  }
  return undefined;
}
