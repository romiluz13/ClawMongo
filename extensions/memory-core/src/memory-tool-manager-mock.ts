import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { vi } from "vitest";

type SearchImpl = (opts?: {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  qmdSearchModeOverride?: "query" | "search" | "vsearch";
  onDebug?: (debug: MemorySearchRuntimeDebug) => void;
}) => Promise<unknown[]>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};
type MemoryBackend = "builtin" | "qmd";

let backend: MemoryBackend = "builtin";
let workspaceDir = "/workspace";
let customStatus: Record<string, unknown> | undefined;
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
  from: params.from ?? 1,
  lines: params.lines ?? 120,
});

const stubManager = {
  search: vi.fn(async (_query: string, opts?: Parameters<SearchImpl>[0]) => await searchImpl(opts)),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir,
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
    custom: customStatus,
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

const getMemorySearchManagerMock = vi.fn(async (_params: { cfg?: unknown; agentId?: string }) => ({
  manager: stubManager,
}));
const readAgentMemoryFileMock = vi.fn(
  async (params: MemoryReadParams) => await readFileImpl(params),
);

vi.mock("./tools.runtime.js", () => ({
  resolveMemoryBackendConfig: ({
    cfg,
  }: {
    cfg?: { memory?: { backend?: string; qmd?: unknown } };
  }) => ({
    backend: cfg?.memory?.backend === "mongodb" ? "mongodb" : backend,
    qmd: cfg?.memory?.qmd,
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
  backend = overrides?.backend ?? "builtin";
  workspaceDir = "/workspace";
  customStatus = undefined;
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
    (async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: params.lines ?? 120,
    }));
  vi.clearAllMocks();
}

export function getStubMemoryManager(): typeof stubManager {
  return stubManager;
}

export function getMemorySearchManagerMockCalls(): number {
  return getMemorySearchManagerMock.mock.calls.length;
}

export function getMemorySearchManagerMockConfigs(): unknown[] {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params.cfg);
}

export function getMemorySearchManagerMockParams(): Array<{ cfg?: unknown; agentId?: string }> {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params);
}

export function getReadAgentMemoryFileMockCalls(): number {
  return readAgentMemoryFileMock.mock.calls.length;
}
