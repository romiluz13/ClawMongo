import { vi, type Mock } from "vitest";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
type EmbeddingMock = Mock<(...args: unknown[]) => Promise<number[] | number[][]>>;

const hoisted = vi.hoisted(() => ({
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  embedQuery: vi.fn(async () => [0, 1, 0]),
}));

export function getEmbedBatchMock(): EmbeddingMock {
  return hoisted.embedBatch as EmbeddingMock;
}

export function getEmbedQueryMock(): EmbeddingMock {
  return hoisted.embedQuery as EmbeddingMock;
}

export function resetEmbeddingMocks(): void {
  hoisted.embedBatch.mockReset();
  hoisted.embedQuery.mockReset();
  hoisted.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
  hoisted.embedQuery.mockImplementation(async () => [0, 1, 0]);
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      maxInputTokens: 8192,
      embedQuery: hoisted.embedQuery,
      embedBatch: hoisted.embedBatch,
    },
  }),
}));
