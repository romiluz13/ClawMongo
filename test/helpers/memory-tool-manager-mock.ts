import { vi } from "vitest";

export type SearchImpl = () => Promise<unknown[]>;
export type SearchDetailedImpl = () => Promise<unknown>;
export type KBSearchImpl = () => Promise<unknown[]>;
export type ActiveSlateImpl = () => Promise<unknown>;
export type DiscoveryProjectionImpl = () => Promise<unknown>;
export type ContextBundleImpl = () => Promise<unknown>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
export type MemoryReadResult = { text: string; path: string };
type MemoryBackend = "mongodb";

let backend: MemoryBackend = "mongodb";
let workspaceDir = "/workspace";
let searchImpl: SearchImpl = async () => [];
let searchDetailedImpl: SearchDetailedImpl | null = null;
let kbSearchImpl: KBSearchImpl = async () => [];
let activeSlateImpl: ActiveSlateImpl = async () => ({ items: [], metadata: { partial: false } });
let discoveryProjectionImpl: DiscoveryProjectionImpl = async () => ({
  kind: "topic-brief",
  target: null,
  sections: [],
  metadata: { partial: false, truncated: false, sourceCount: 0 },
});
let contextBundleImpl: ContextBundleImpl = async () => ({
  sections: [],
  rendered: "",
  metadata: {
    partial: false,
    truncated: false,
    tokenBudget: 0,
    estimatedTokensUsed: 0,
    pathsExecuted: [],
  },
});
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
});

const searchSpy = vi.fn(async () => await searchImpl());
const searchDetailedSpy = vi.fn(async () => await searchDetailedImpl?.());
const searchKBSpy = vi.fn(async () => await kbSearchImpl());
const activeSlateSpy = vi.fn(async () => await activeSlateImpl());
const discoveryProjectionSpy = vi.fn(async () => await discoveryProjectionImpl());
const contextBundleSpy = vi.fn(async () => await contextBundleImpl());
const readFileSpy = vi.fn(async (params: MemoryReadParams) => await readFileImpl(params));

const stubManager: Record<string, unknown> = {
  search: searchSpy,
  searchKB: searchKBSpy,
  hydrateActiveSlate: activeSlateSpy,
  buildDiscoveryProjection: discoveryProjectionSpy,
  buildContextBundle: contextBundleSpy,
  readFile: readFileSpy,
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir,
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "mongodb",
    model: "mongodb",
    requestedProvider: "mongodb",
    sources: ["conversation" as const],
    sourceCounts: [{ source: "conversation" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

function syncOptionalManagerMethods(): void {
  stubManager.searchDetailed = searchDetailedImpl ? searchDetailedSpy : undefined;
}

syncOptionalManagerMethods();

const getMemorySearchManagerMock = vi.fn(async () => ({ manager: stubManager }));
const readAgentMemoryFileMock = vi.fn(
  async (params: MemoryReadParams) => await readFileImpl(params),
);

const { memoryIndexModuleId, memoryToolsRuntimeModuleId } = vi.hoisted(() => ({
  memoryIndexModuleId: "../../src/memory/index.js",
  memoryToolsRuntimeModuleId: "../../src/agents/tools/memory-tool.runtime.js",
}));

vi.mock(memoryIndexModuleId, () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("../../src/memory-host-sdk/host/read-file.js", () => ({
  readAgentMemoryFile: readAgentMemoryFileMock,
}));

vi.mock(memoryToolsRuntimeModuleId, () => ({
  resolveMemoryBackendConfig: ({
    cfg,
  }: {
    cfg?: { memory?: { backend?: string } };
  }) => ({
    backend: cfg?.memory?.backend === "mongodb" ? "mongodb" : backend,
  }),
  getMemorySearchManager: getMemorySearchManagerMock,
  hasWriteCapability: () => true,
  readAgentMemoryFile: readAgentMemoryFileMock,
}));

export function setMemoryBackend(next: MemoryBackend): void {
  backend = next;
}

export function setMemoryWorkspaceDir(next: string): void {
  workspaceDir = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setMemorySearchDetailedImpl(next: SearchDetailedImpl | null): void {
  searchDetailedImpl = next;
  syncOptionalManagerMethods();
}

export function setKBSearchImpl(next: KBSearchImpl): void {
  kbSearchImpl = next;
}

export function setMemoryActiveSlateImpl(next: ActiveSlateImpl): void {
  activeSlateImpl = next;
}

export function setMemoryDiscoveryProjectionImpl(next: DiscoveryProjectionImpl): void {
  discoveryProjectionImpl = next;
}

export function setMemoryContextBundleImpl(next: ContextBundleImpl): void {
  contextBundleImpl = next;
}

export function setMemoryReadFileImpl(
  next: (params: MemoryReadParams) => Promise<MemoryReadResult>,
): void {
  readFileImpl = next;
}

export function resetMemoryToolMockState(overrides?: {
  backend?: MemoryBackend;
  searchImpl?: SearchImpl;
  searchDetailedImpl?: SearchDetailedImpl | null;
  kbSearchImpl?: KBSearchImpl;
  activeSlateImpl?: ActiveSlateImpl;
  discoveryProjectionImpl?: DiscoveryProjectionImpl;
  contextBundleImpl?: ContextBundleImpl;
  readFileImpl?: (params: MemoryReadParams) => Promise<MemoryReadResult>;
}): void {
  backend = overrides?.backend ?? "mongodb";
  workspaceDir = "/workspace";
  searchImpl = overrides?.searchImpl ?? (async () => []);
  searchDetailedImpl = overrides?.searchDetailedImpl ?? null;
  kbSearchImpl = overrides?.kbSearchImpl ?? (async () => []);
  activeSlateImpl =
    overrides?.activeSlateImpl ?? (async () => ({ items: [], metadata: { partial: false } }));
  discoveryProjectionImpl =
    overrides?.discoveryProjectionImpl ??
    (async () => ({
      kind: "topic-brief",
      target: null,
      sections: [],
      metadata: { partial: false, truncated: false, sourceCount: 0 },
    }));
  contextBundleImpl =
    overrides?.contextBundleImpl ??
    (async () => ({
      sections: [],
      rendered: "",
      metadata: {
        partial: false,
        truncated: false,
        tokenBudget: 0,
        estimatedTokensUsed: 0,
        pathsExecuted: [],
      },
    }));
  readFileImpl =
    overrides?.readFileImpl ??
    (async (params: MemoryReadParams) => ({ text: "", path: params.relPath }));
  syncOptionalManagerMethods();
  vi.clearAllMocks();
}

export function getStubMemoryManager(): typeof stubManager {
  return stubManager;
}

export function getMemorySearchManagerMockCalls(): number {
  return getMemorySearchManagerMock.mock.calls.length;
}

export function getReadAgentMemoryFileMockCalls(): number {
  return readAgentMemoryFileMock.mock.calls.length;
}
