import { vi } from "vitest";

export type SearchImpl = () => Promise<unknown[]>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
export type MemoryReadResult = { text: string; path: string; locator?: string; disabled?: boolean };
type MemoryBackend = "mongodb";

let backend: MemoryBackend = "mongodb";
let searchImpl: SearchImpl = async () => [];
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
});
let searchKBImpl: SearchImpl = async () => [];
type MemoryWriteImpl = (...args: unknown[]) => Promise<{ upserted: boolean; id: string }>;
let writeStructuredMemoryImpl: MemoryWriteImpl = vi.fn(async () => ({
  upserted: true,
  id: "mock-id",
}));

const stubManager = {
  search: vi.fn(async () => await searchImpl()),
  searchKB: vi.fn(async () => await searchKBImpl()),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
  writeStructuredMemory: vi.fn(
    async (...args: unknown[]) => await writeStructuredMemoryImpl(...args),
  ),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    provider: "mongodb-automated",
    model: "automated (server-managed)",
    requestedProvider: "mongodb-automated",
    sources: ["memory" as const, "sessions" as const, "kb" as const, "structured" as const],
    sourceCounts: [
      { source: "memory" as const, files: 1, chunks: 1 },
      { source: "sessions" as const, files: 1, chunks: 1 },
      { source: "kb" as const, files: 1, chunks: 1 },
      { source: "structured" as const, files: 1, chunks: 1 },
    ],
  }),
  sync: vi.fn(),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../src/memory/index.js", () => ({
  getMemorySearchManager: async () => ({ manager: stubManager }),
}));

export function setMemoryBackend(next: MemoryBackend): void {
  backend = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setKBSearchImpl(next: SearchImpl): void {
  searchKBImpl = next;
}

export function setMemoryReadFileImpl(
  next: (params: MemoryReadParams) => Promise<MemoryReadResult>,
): void {
  readFileImpl = next;
}

export function setMemoryWriteImpl(next: MemoryWriteImpl): void {
  writeStructuredMemoryImpl = next;
}

export function resetMemoryToolMockState(overrides?: {
  backend?: MemoryBackend;
  searchImpl?: SearchImpl;
  searchKBImpl?: SearchImpl;
  readFileImpl?: (params: MemoryReadParams) => Promise<MemoryReadResult>;
  writeStructuredMemoryImpl?: MemoryWriteImpl;
}): void {
  backend = overrides?.backend ?? "mongodb";
  searchImpl = overrides?.searchImpl ?? (async () => []);
  searchKBImpl = overrides?.searchKBImpl ?? (async () => []);
  readFileImpl =
    overrides?.readFileImpl ??
    (async (params: MemoryReadParams) => ({ text: "", path: params.relPath }));
  writeStructuredMemoryImpl =
    overrides?.writeStructuredMemoryImpl ??
    (vi.fn(async () => ({ upserted: true, id: "mock-id" })) as MemoryWriteImpl);
  vi.clearAllMocks();
}
