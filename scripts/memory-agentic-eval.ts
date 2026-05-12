import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { MongoClient } from "mongodb";
import { resolveDefaultAgentId } from "../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { readBestEffortConfig } from "../src/config/config.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "../src/memory/index.js";
import { upsertEntity, upsertRelation } from "../src/memory/mongodb-graph.js";
import { writeEventAndProject } from "../src/memory/mongodb-manager.js";
import { ensureCollections, ensureStandardIndexes } from "../src/memory/mongodb-schema.js";
import { writeStructuredMemory } from "../src/memory/mongodb-structured-memory.js";
import type {
  MemoryActiveSlate,
  MemoryContextBundle,
  MemoryContextBundleRequest,
  MemoryDiscoveryProjection,
  MemoryDiscoveryProjectionRequest,
  MemorySearchManager,
  MemorySearchRequest,
  MemorySearchResponse,
} from "../src/memory/types.js";

type EvalQuery =
  | string
  | {
      query: string;
      directRequest?: Omit<MemorySearchRequest, "query" | "searchMode" | "returnPlan">;
      agenticRequest?: Omit<MemorySearchRequest, "query" | "searchMode" | "returnPlan">;
    };

type EvalRow = {
  query: string;
  direct: Summary;
  agentic: Summary;
  delta: {
    behaviorChanged: boolean;
    improvedEvidence: boolean;
    extraQueriesTried: number;
    extraPaths: string[];
  };
};

type SeededLifecycleDemo = {
  defaultQueries: EvalQuery[];
  notes: string[];
  specializedChecks: SpecializedEvalCheck[];
};

type SpecializedEvalCheck =
  | {
      kind: "active-slate";
      label: string;
      params?: Parameters<NonNullable<MemorySearchManager["hydrateActiveSlate"]>>[0];
      expectContains: string[];
    }
  | {
      kind: "discovery-projection";
      label: string;
      request: MemoryDiscoveryProjectionRequest;
      expectContains: string[];
    }
  | {
      kind: "context-bundle";
      label: string;
      request: MemoryContextBundleRequest;
      expectContains: string[];
      expectSections?: string[];
    };

type SpecializedEvalRow = {
  kind: SpecializedEvalCheck["kind"];
  label: string;
  summary: string;
  partial: boolean;
  highlights: string[];
  sections?: string[];
};

type Summary = {
  classification?: string;
  passes: number;
  sourceOrder: string[];
  evidenceCoverage?: string;
  trustApplied?: boolean;
  corrections?: string[];
  pathsExecuted: string[];
  queriesTried: string[];
  topResults: Array<{
    path: string;
    score: number;
    source: string;
    trust?: number;
    state?: string;
  }>;
  noDirectEvidenceReason?: string;
};

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function extractDatabaseFromMongoUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    const dbName = parsed.pathname.replace(/^\/+/, "").trim();
    return dbName || undefined;
  } catch {
    return undefined;
  }
}

async function resolveEvalConfig(): Promise<OpenClawConfig> {
  const cfg = await readBestEffortConfig();
  const mongodbUriOverride = readFlag("--mongodb-uri");
  if (!mongodbUriOverride) {
    return cfg;
  }
  const databaseOverride = extractDatabaseFromMongoUri(mongodbUriOverride);
  return {
    ...cfg,
    memory: {
      ...cfg.memory,
      backend: "mongodb",
      mongodb: {
        ...cfg.memory?.mongodb,
        ...(databaseOverride ? { database: databaseOverride } : {}),
        uri: mongodbUriOverride,
      },
    },
  };
}

async function loadQueries(defaultQueries?: EvalQuery[]): Promise<EvalQuery[]> {
  const file = readFlag("--queries");
  if (file) {
    const raw = await fs.readFile(file, "utf8");
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry).trim()).filter(Boolean);
      }
    }
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const query = readFlag("--query");
  if (query) {
    return [query];
  }

  return (
    defaultQueries ?? [
      "what happened today with the deployment?",
      "what are the open source eval tools family?",
      "compare the memory routing approaches",
      "which procedure do we use for incident rollback?",
    ]
  );
}

function requireMongoEvalTarget(cfg: OpenClawConfig): {
  uri: string;
  database?: string;
  prefix: string;
  embeddingMode: "automated" | "legacy";
} {
  if (cfg.memory?.backend !== "mongodb" || !cfg.memory.mongodb?.uri) {
    throw new Error("seeded lifecycle demo requires MongoDB memory backend with a configured URI");
  }

  return {
    uri: cfg.memory.mongodb.uri,
    database: cfg.memory.mongodb.database,
    prefix: cfg.memory.mongodb.collectionPrefix ?? "",
    embeddingMode: cfg.memory.mongodb.embeddingMode === "legacy" ? "legacy" : "automated",
  };
}

async function seedLifecycleDemo(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<SeededLifecycleDemo> {
  const target = requireMongoEvalTarget(cfg);
  const client = new MongoClient(target.uri, {
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();
  try {
    const db = client.db(target.database);
    await ensureCollections(db, target.prefix);
    await ensureStandardIndexes(db, target.prefix, target.embeddingMode);

    const suffix = randomUUID().slice(0, 8);
    const rescueSuffix = randomUUID().slice(0, 8);
    const contradictionSuffix = randomUUID().slice(0, 8);
    const now = new Date();
    const graphRootName = `Orpheus${suffix}`;
    const staleGraphTarget = `AtlasOwner${suffix}`;
    const currentGraphTarget = `PhoenixOwner${suffix}`;
    const rescueSubject = `phoenix-rescue-${rescueSuffix}`;
    const contradictionSubject = `phoenix-conflict-${contradictionSuffix}`;
    const activeSlateMarker = `phoenix-active-${suffix}`;
    const handoffMarker = `phoenix-handoff-${suffix}`;
    const handoffSessionId = `eval-handoff-${suffix}`;
    const handoffScopeRef = `session:${handoffSessionId}`;

    await upsertEntity({
      db,
      prefix: target.prefix,
      entity: {
        entityId: `ent-root-${suffix}`,
        name: graphRootName,
        type: "system",
        agentId,
        scope: "agent",
        updatedAt: now,
      },
    });
    await upsertEntity({
      db,
      prefix: target.prefix,
      entity: {
        entityId: `ent-stale-${suffix}`,
        name: staleGraphTarget,
        type: "org",
        agentId,
        scope: "agent",
        updatedAt: now,
      },
    });
    await upsertEntity({
      db,
      prefix: target.prefix,
      entity: {
        entityId: `ent-current-${suffix}`,
        name: currentGraphTarget,
        type: "org",
        agentId,
        scope: "agent",
        updatedAt: now,
      },
    });
    await upsertRelation({
      db,
      prefix: target.prefix,
      relation: {
        fromEntityId: `ent-root-${suffix}`,
        toEntityId: `ent-stale-${suffix}`,
        type: "owns",
        agentId,
        scope: "agent",
        updatedAt: new Date(now.getTime() - 60_000),
        weight: 0.55,
      },
    });
    await upsertRelation({
      db,
      prefix: target.prefix,
      relation: {
        fromEntityId: `ent-root-${suffix}`,
        toEntityId: `ent-current-${suffix}`,
        type: "owns",
        agentId,
        scope: "agent",
        updatedAt: now,
        weight: 0.95,
      },
    });

    await writeStructuredMemory({
      db,
      prefix: target.prefix,
      entry: {
        type: "project",
        key: `active-slate-current-${suffix}`,
        value: `${activeSlateMarker} is blocked on Atlas Local validation and currently owned by Sarah.`,
        confidence: 0.97,
        agentId,
        scope: "agent",
        state: "active",
        salience: "critical",
        temporalScope: "ongoing",
        sourceEventIds: [`evt-active-slate-${suffix}`],
        sourceReliability: 0.96,
        reinforcementCount: 3,
        lastConfirmedAt: now,
      },
      embeddingMode: target.embeddingMode,
    });
    await writeStructuredMemory({
      db,
      prefix: target.prefix,
      entry: {
        type: "fact",
        key: `lifecycle-current-${suffix}`,
        value: `Lifecycle authority marker ${suffix} is Sarah.`,
        confidence: 0.96,
        agentId,
        scope: "agent",
        salience: "high",
        temporalScope: "ongoing",
        sourceEventIds: [`evt-current-a-${suffix}`, `evt-current-b-${suffix}`],
        sourceReliability: 0.95,
        reinforcementCount: 4,
        lastConfirmedAt: now,
        reviewAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
      embeddingMode: target.embeddingMode,
    });
    await writeStructuredMemory({
      db,
      prefix: target.prefix,
      entry: {
        type: "fact",
        key: `lifecycle-stale-${suffix}`,
        value: `Lifecycle authority marker ${suffix} is Mike.`,
        confidence: 0.5,
        agentId,
        scope: "agent",
        salience: "high",
        temporalScope: "ongoing",
        sourceEventIds: [`evt-stale-${suffix}`],
        sourceReliability: 0.35,
        reinforcementCount: 1,
        lastConfirmedAt: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000),
        reviewAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      },
      embeddingMode: target.embeddingMode,
    });
    await writeStructuredMemory({
      db,
      prefix: target.prefix,
      entry: {
        type: "fact",
        key: `freshness-rescue-stale-${suffix}`,
        value: `Current owner of ${rescueSubject} production database is Mike.`,
        confidence: 0.6,
        agentId,
        scope: "agent",
        salience: "high",
        temporalScope: "ongoing",
        sourceEventIds: [`evt-rescue-stale-${suffix}`],
        sourceReliability: 0.45,
        reinforcementCount: 1,
        lastConfirmedAt: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000),
        reviewAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      },
      embeddingMode: target.embeddingMode,
    });
    await writeEventAndProject(db, target.prefix, {
      agentId,
      role: "assistant",
      body: `Handoff update for ${rescueSubject}: Sarah owns the production database right now after the cutover.`,
      scope: "agent",
      sessionId: `eval-freshness-rescue-${suffix}`,
      metadata: { evalDemo: "freshness-rescue", rescueSubject },
    });
    await writeStructuredMemory({
      db,
      prefix: target.prefix,
      entry: {
        type: "fact",
        key: `contradiction-conflicted-${suffix}`,
        value: `Current owner of ${contradictionSubject} production database is Mike.`,
        confidence: 0.58,
        agentId,
        scope: "agent",
        salience: "high",
        temporalScope: "ongoing",
        state: "conflicted",
        sourceEventIds: [`evt-contradiction-${suffix}`],
        sourceReliability: 0.45,
        reinforcementCount: 1,
        lastConfirmedAt: now,
      },
      embeddingMode: target.embeddingMode,
    });
    await writeEventAndProject(db, target.prefix, {
      agentId,
      role: "assistant",
      body: `Ownership clarification for ${contradictionSubject}: Sarah owns the production database right now after Mike handed it off.`,
      scope: "agent",
      sessionId: `eval-contradiction-resolution-${suffix}`,
      metadata: { evalDemo: "contradiction-correction", contradictionSubject },
    });
    await writeStructuredMemory({
      db,
      prefix: target.prefix,
      entry: {
        type: "project",
        key: `handoff-blocker-${suffix}`,
        value: `${handoffMarker} is blocked on Atlas Local validation before rollout.`,
        confidence: 0.99,
        agentId,
        scope: "session",
        scopeRef: handoffScopeRef,
        state: "active",
        salience: "critical",
        temporalScope: "ongoing",
        sourceEventIds: [`evt-handoff-${suffix}`],
      },
      embeddingMode: target.embeddingMode,
    });
    await writeEventAndProject(db, target.prefix, {
      agentId,
      role: "user",
      body: `Prepare a compact handoff for ${handoffMarker}. The blocker is Atlas Local validation and the release window is Friday afternoon.`,
      scope: "session",
      sessionId: handoffSessionId,
      metadata: { evalDemo: "context-bundle", handoffMarker },
    });
    await writeEventAndProject(db, target.prefix, {
      agentId,
      role: "assistant",
      body: `Current handoff for ${handoffMarker}: still blocked on Atlas Local validation, with the next release window on Friday afternoon.`,
      scope: "session",
      sessionId: handoffSessionId,
      metadata: { evalDemo: "context-bundle", handoffMarker },
    });

    return {
      defaultQueries: [
        `who owns ${graphRootName}?`,
        `lifecycle authority marker ${suffix}`,
        {
          query: `who owns the ${rescueSubject} production database right now`,
          directRequest: {
            sourcePreference: ["structured"],
            maxPasses: 2,
            maxResults: 5,
          },
          agenticRequest: {
            sourcePreference: ["structured"],
            maxPasses: 2,
            maxResults: 5,
          },
        },
        {
          query: `who owns the ${contradictionSubject} production database right now`,
          directRequest: {
            sourcePreference: ["structured"],
            maxPasses: 2,
            maxResults: 5,
          },
          agenticRequest: {
            sourcePreference: ["structured"],
            maxPasses: 2,
            maxResults: 5,
          },
        },
      ],
      notes: [
        `Seeded graph current-state demo: ${graphRootName} should resolve to ${currentGraphTarget}, not ${staleGraphTarget}.`,
        `Seeded structured current-state demo: lifecycle authority marker ${suffix} should prefer Sarah over stale Mike.`,
        `Seeded freshness-rescue demo: ${rescueSubject} should be rescued from stale Mike structured memory to fresh Sarah event evidence.`,
        `Seeded contradiction demo: ${contradictionSubject} should require a conflict-evidence correction pass and resolve to Sarah.`,
        `Seeded active-slate demo: ${activeSlateMarker} should surface as active current state owned by Sarah.`,
        `Seeded context-bundle demo: ${handoffMarker} should assemble a handoff with active state, evidence, and recent events under budget.`,
      ],
      specializedChecks: [
        {
          kind: "active-slate",
          label: "current-state and blocker slate",
          params: { scope: "agent", maxItems: 5 },
          expectContains: [activeSlateMarker, "Sarah"],
        },
        {
          kind: "discovery-projection",
          label: "what changed projection",
          request: {
            kind: "what-changed",
            query: contradictionSubject,
            scope: "agent",
            maxItems: 5,
          },
          expectContains: [contradictionSubject, "Sarah"],
        },
        {
          kind: "context-bundle",
          label: "prompt-ready handoff bundle",
          request: {
            query: handoffMarker,
            scope: "session",
            sessionId: handoffSessionId,
            tokenBudget: 320,
            maxActiveItems: 4,
            maxRecentEvents: 4,
            maxEvidenceItems: 4,
            includeDiscoveryProjection: true,
            discoveryKind: "what-changed",
          },
          expectContains: [handoffMarker, "Atlas Local validation", "Friday afternoon"],
          expectSections: ["active-slate", "query-evidence", "recent-events"],
        },
      ],
    };
  } finally {
    await client.close();
  }
}

function summarize(response: MemorySearchResponse): Summary {
  return {
    classification: response.metadata.classification,
    passes: response.metadata.passes.length,
    sourceOrder: response.metadata.sourceOrder,
    evidenceCoverage: response.metadata.evidenceCoverage,
    trustApplied: response.metadata.trustApplied,
    corrections: response.metadata.passes
      .map((pass) => pass.correctionApplied)
      .filter((value): value is string => typeof value === "string"),
    pathsExecuted: response.metadata.pathsExecuted,
    queriesTried: response.metadata.queriesTried,
    noDirectEvidenceReason: response.metadata.noDirectEvidenceReason,
    topResults: response.results.slice(0, 5).map((result) => {
      const entry: {
        path: string;
        score: number;
        source: string;
        state?: string;
        trust?: number;
      } = {
        path: result.path,
        score: result.score,
        source: result.source,
      };
      if (typeof result.signals?.state === "string") {
        entry.state = result.signals.state;
      }
      if (typeof result.trust?.score === "number") {
        entry.trust = result.trust.score;
      }
      return entry;
    }),
  };
}

function compareResults(
  direct: MemorySearchResponse,
  agentic: MemorySearchResponse,
): EvalRow["delta"] {
  const directPaths = new Set(direct.metadata.pathsExecuted);
  const extraPaths = agentic.metadata.pathsExecuted.filter((path) => !directPaths.has(path));
  const evidenceRank = { none: 0, indirect: 1, partial: 2, direct: 3 } as const;
  return {
    behaviorChanged:
      JSON.stringify(direct.metadata.pathsExecuted) !==
        JSON.stringify(agentic.metadata.pathsExecuted) ||
      JSON.stringify(direct.metadata.queriesTried) !==
        JSON.stringify(agentic.metadata.queriesTried),
    improvedEvidence:
      evidenceRank[agentic.metadata.evidenceCoverage] >
      evidenceRank[direct.metadata.evidenceCoverage],
    extraQueriesTried: Math.max(
      0,
      agentic.metadata.queriesTried.length - direct.metadata.queriesTried.length,
    ),
    extraPaths,
  };
}

function collectActiveSlateText(slate: MemoryActiveSlate): string {
  return [
    ...slate.items.flatMap((item) => [item.title, item.summary, item.path]),
    ...Object.keys(slate.metadata.countsByKind),
  ].join("\n");
}

function collectProjectionText(projection: MemoryDiscoveryProjection): string {
  return [
    projection.title,
    projection.summary,
    ...projection.sections.flatMap((section) => [
      section.title,
      section.summary,
      ...section.evidence.flatMap((evidence) => [evidence.title, evidence.summary, evidence.path]),
    ]),
  ].join("\n");
}

function collectContextBundleText(bundle: MemoryContextBundle): string {
  return [
    bundle.rendered,
    ...bundle.sections.flatMap((section) => [
      section.title,
      section.summary ?? "",
      ...section.items.flatMap((item) => [item.title, item.summary, item.path ?? ""]),
    ]),
  ].join("\n");
}

function assertContainsAll(params: { label: string; haystack: string; expected: string[] }): void {
  const haystack = params.haystack.toLowerCase();
  for (const expected of params.expected) {
    if (!haystack.includes(expected.toLowerCase())) {
      throw new Error(`${params.label} missing expected content: ${expected}`);
    }
  }
}

async function runSpecializedChecks(
  manager: MemorySearchManager,
  checks: SpecializedEvalCheck[],
): Promise<SpecializedEvalRow[]> {
  const rows: SpecializedEvalRow[] = [];
  for (const check of checks) {
    switch (check.kind) {
      case "active-slate": {
        if (typeof manager.hydrateActiveSlate !== "function") {
          throw new Error("hydrateActiveSlate() is unavailable on the active memory manager");
        }
        const slate = await manager.hydrateActiveSlate(check.params);
        assertContainsAll({
          label: check.label,
          haystack: collectActiveSlateText(slate),
          expected: check.expectContains,
        });
        rows.push({
          kind: check.kind,
          label: check.label,
          summary: `Hydrated ${slate.items.length} active-slate items for ${slate.scope}:${slate.scopeRef}.`,
          partial: slate.metadata.partial,
          highlights: slate.items
            .slice(0, 4)
            .map((item) => `${item.kind}: ${item.title} — ${item.summary}`),
        });
        break;
      }
      case "discovery-projection": {
        if (typeof manager.buildDiscoveryProjection !== "function") {
          throw new Error("buildDiscoveryProjection() is unavailable on the active memory manager");
        }
        const projection = await manager.buildDiscoveryProjection(check.request);
        assertContainsAll({
          label: check.label,
          haystack: collectProjectionText(projection),
          expected: check.expectContains,
        });
        rows.push({
          kind: check.kind,
          label: check.label,
          summary: projection.summary,
          partial: projection.metadata.partial,
          sections: projection.sections.map((section) => section.title),
          highlights: projection.sections.flatMap((section) =>
            section.evidence
              .slice(0, 2)
              .map((evidence) => `${section.title}: ${evidence.title} — ${evidence.summary}`),
          ),
        });
        break;
      }
      case "context-bundle": {
        if (typeof manager.buildContextBundle !== "function") {
          throw new Error("buildContextBundle() is unavailable on the active memory manager");
        }
        const bundle = await manager.buildContextBundle(check.request);
        assertContainsAll({
          label: check.label,
          haystack: collectContextBundleText(bundle),
          expected: check.expectContains,
        });
        for (const expectedSection of check.expectSections ?? []) {
          if (!bundle.metadata.sectionsIncluded.includes(expectedSection as never)) {
            throw new Error(`${check.label} missing expected section: ${expectedSection}`);
          }
        }
        rows.push({
          kind: check.kind,
          label: check.label,
          summary: `Built ${bundle.sections.length} sections using ${bundle.metadata.estimatedTokensUsed}/${bundle.metadata.tokenBudget} estimated tokens.`,
          partial: bundle.metadata.partial,
          sections: bundle.metadata.sectionsIncluded,
          highlights: bundle.sections
            .slice(0, 4)
            .map((section) => `${section.kind}: ${section.title} (${section.items.length} items)`),
        });
        break;
      }
    }
  }
  return rows;
}

function renderMarkdown(
  rows: EvalRow[],
  notes: string[] = [],
  specializedRows: SpecializedEvalRow[] = [],
): string {
  const lines: string[] = ["# ClawMongo Agentic Internal Search Eval", ""];
  if (notes.length > 0) {
    for (const note of notes) {
      lines.push(`> ${note}`);
    }
    lines.push("");
  }
  for (const row of rows) {
    lines.push(`## ${row.query}`);
    lines.push("");
    lines.push(`- Direct classification: ${row.direct.classification ?? "unknown"}`);
    lines.push(`- Agentic classification: ${row.agentic.classification ?? "unknown"}`);
    lines.push(`- Direct passes: ${row.direct.passes}`);
    lines.push(`- Agentic passes: ${row.agentic.passes}`);
    lines.push(`- Direct evidence: ${row.direct.evidenceCoverage ?? "unknown"}`);
    lines.push(`- Agentic evidence: ${row.agentic.evidenceCoverage ?? "unknown"}`);
    lines.push(`- Direct trust applied: ${row.direct.trustApplied ? "yes" : "no"}`);
    lines.push(`- Agentic trust applied: ${row.agentic.trustApplied ? "yes" : "no"}`);
    lines.push(
      `- Direct corrections: ${row.direct.corrections?.length ? row.direct.corrections.join(", ") : "none"}`,
    );
    lines.push(
      `- Agentic corrections: ${row.agentic.corrections?.length ? row.agentic.corrections.join(", ") : "none"}`,
    );
    lines.push(`- Extra agentic queries: ${row.delta.extraQueriesTried}`);
    lines.push(
      `- Extra agentic paths: ${row.delta.extraPaths.length > 0 ? row.delta.extraPaths.join(", ") : "none"}`,
    );
    lines.push(`- Behavior changed: ${row.delta.behaviorChanged ? "yes" : "no"}`);
    lines.push(`- Evidence improved: ${row.delta.improvedEvidence ? "yes" : "no"}`);
    lines.push("");
    lines.push("Direct top results:");
    for (const result of row.direct.topResults) {
      lines.push(
        `- ${result.source} | ${result.score.toFixed(3)} | trust ${result.trust?.toFixed(3) ?? "n/a"} | state ${result.state ?? "n/a"} | ${result.path}`,
      );
    }
    if (row.direct.topResults.length === 0) {
      lines.push("- none");
    }
    lines.push("");
    lines.push("Agentic top results:");
    for (const result of row.agentic.topResults) {
      lines.push(
        `- ${result.source} | ${result.score.toFixed(3)} | trust ${result.trust?.toFixed(3) ?? "n/a"} | state ${result.state ?? "n/a"} | ${result.path}`,
      );
    }
    if (row.agentic.topResults.length === 0) {
      lines.push("- none");
    }
    if (row.agentic.noDirectEvidenceReason) {
      lines.push("");
      lines.push(`No direct evidence reason: ${row.agentic.noDirectEvidenceReason}`);
    }
    lines.push("");
  }
  if (specializedRows.length > 0) {
    lines.push("# Specialized MongoDB Memory Capabilities", "");
    for (const row of specializedRows) {
      lines.push(`## ${row.label}`);
      lines.push("");
      lines.push(`- Capability: ${row.kind}`);
      lines.push(`- Summary: ${row.summary}`);
      lines.push(`- Partial: ${row.partial ? "yes" : "no"}`);
      if (row.sections && row.sections.length > 0) {
        lines.push(`- Sections: ${row.sections.join(", ")}`);
      }
      lines.push("");
      lines.push("Highlights:");
      if (row.highlights.length === 0) {
        lines.push("- none");
      } else {
        for (const highlight of row.highlights) {
          lines.push(`- ${highlight}`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main() {
  const cfg = await resolveEvalConfig();
  const agentId = readFlag("--agent") ?? resolveDefaultAgentId(cfg);
  const seededDemo = hasFlag("--seed-lifecycle-demo")
    ? await seedLifecycleDemo(cfg, agentId)
    : undefined;
  const queries = await loadQueries(seededDemo?.defaultQueries);
  const { manager, error } = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
  if (!manager) {
    throw new Error(error ?? "memory manager unavailable");
  }
  if (typeof manager.searchDetailed !== "function") {
    throw new Error("searchDetailed() is unavailable on the active memory manager");
  }

  const rows: EvalRow[] = [];
  const specializedRows =
    seededDemo?.specializedChecks && seededDemo.specializedChecks.length > 0
      ? await runSpecializedChecks(manager, seededDemo.specializedChecks)
      : [];
  for (const entry of queries) {
    const query = typeof entry === "string" ? entry : entry.query;
    const direct = await manager.searchDetailed({
      query,
      searchMode: "direct",
      returnPlan: true,
      ...(typeof entry === "string" ? {} : (entry.directRequest ?? {})),
    });
    const agentic = await manager.searchDetailed({
      query,
      searchMode: "agentic",
      returnPlan: true,
      ...(typeof entry === "string" ? {} : (entry.agenticRequest ?? {})),
    });
    rows.push({
      query,
      direct: summarize(direct),
      agentic: summarize(agentic),
      delta: compareResults(direct, agentic),
    });
  }

  if (hasFlag("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        specializedRows.length > 0 ? { searchRows: rows, specializedRows } : rows,
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${renderMarkdown(rows, seededDemo?.notes ?? [], specializedRows)}\n`);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await closeAllMemorySearchManagers();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`closeAllMemorySearchManagers failed: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

void run();
