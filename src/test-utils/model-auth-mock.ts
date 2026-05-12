import { vi } from "vitest";

export function createModelAuthMockModule() {
  return {
    requireApiKey: (auth: { apiKey?: string }, provider: string) => {
      if (auth.apiKey?.trim()) {
        return auth.apiKey.trim();
      }
      throw new Error(`No API key resolved for provider "${provider}".`);
    },
    resolveApiKeyForProvider: vi.fn(),
  };
}
