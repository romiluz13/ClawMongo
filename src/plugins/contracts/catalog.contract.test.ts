import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../types.js";
import { providerContractRegistry } from "./registry.js";

function requireProvider(providerId: string): ProviderPlugin {
  const provider = providerContractRegistry.find(
    (entry) => entry.provider.id === providerId,
  )?.provider;
  if (!provider) {
    throw new Error(`provider ${providerId} missing from contract registry`);
  }
  return provider;
}

function listPluginProviders(pluginId: string): ProviderPlugin[] {
  return providerContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider);
}

describe("provider catalog contract", () => {
  it("keeps codex-only missing-auth hints wired through the provider runtime", () => {
    const provider = requireProvider("openai");
    expect(
      provider.buildMissingAuthMessage?.({
        env: process.env,
        provider: "openai",
        listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
      }),
    ).toContain("openai-codex/gpt-5.4");
  });

  it("keeps built-in model suppression wired through the provider runtime", () => {
    const provider = requireProvider("openai");
    expect(
      provider.suppressBuiltInModel?.({
        env: process.env,
        provider: "azure-openai-responses",
        modelId: "gpt-5.3-codex-spark",
      }),
    ).toMatchObject({
      suppress: true,
      errorMessage: expect.stringContaining("openai-codex/gpt-5.3-codex-spark"),
    });
  });

  it("keeps bundled model augmentation wired through the provider runtime", async () => {
    const entries = [
      { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
      { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
      { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    ];
    const supplemental = (
      await Promise.all(
        listPluginProviders("openai").map(
          (provider) =>
            provider.augmentModelCatalog?.({
              env: process.env,
              entries,
            }) ?? [],
        ),
      )
    ).flat();

    expect(supplemental).toEqual([
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
      },
    ]);
  });
});
