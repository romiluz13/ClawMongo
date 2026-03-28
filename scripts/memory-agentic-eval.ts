import fs from "node:fs/promises";
import { resolveDefaultAgentId } from "../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { loadConfig } from "../src/config/config.js";
import { getMemorySearchManager } from "../src/memory/index.js";
import type { MemorySearchResponse } from "../src/memory/types.js";

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

type Summary = {
  classification?: string;
  passes: number;
  sourceOrder: string[];
  evidenceCoverage?: string;
  pathsExecuted: string[];
  queriesTried: string[];
  topResults: Array<{ path: string; score: number; source: string }>;
  noDirectEvidenceReason?: string;
};

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function resolveEvalConfig(): OpenClawConfig {
  const cfg = loadConfig();
  const mongodbUriOverride = readFlag("--mongodb-uri");
  if (!mongodbUriOverride) {
    return cfg;
  }
  return {
    ...cfg,
    memory: {
      ...cfg.memory,
      backend: "mongodb",
      mongodb: {
        ...cfg.memory?.mongodb,
        uri: mongodbUriOverride,
      },
    },
  };
}

async function loadQueries(): Promise<string[]> {
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

  return [
    "what happened today with the deployment?",
    "what are the open source eval tools family?",
    "compare the memory routing approaches",
    "which procedure do we use for incident rollback?",
  ];
}

function summarize(response: MemorySearchResponse): Summary {
  return {
    classification: response.metadata.classification,
    passes: response.metadata.passes.length,
    sourceOrder: response.metadata.sourceOrder,
    evidenceCoverage: response.metadata.evidenceCoverage,
    pathsExecuted: response.metadata.pathsExecuted,
    queriesTried: response.metadata.queriesTried,
    noDirectEvidenceReason: response.metadata.noDirectEvidenceReason,
    topResults: response.results.slice(0, 5).map((result) => ({
      path: result.path,
      score: result.score,
      source: result.source,
    })),
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

function renderMarkdown(rows: EvalRow[]): string {
  const lines: string[] = ["# ClawMongo Agentic Internal Search Eval", ""];
  for (const row of rows) {
    lines.push(`## ${row.query}`);
    lines.push("");
    lines.push(`- Direct classification: ${row.direct.classification ?? "unknown"}`);
    lines.push(`- Agentic classification: ${row.agentic.classification ?? "unknown"}`);
    lines.push(`- Direct passes: ${row.direct.passes}`);
    lines.push(`- Agentic passes: ${row.agentic.passes}`);
    lines.push(`- Direct evidence: ${row.direct.evidenceCoverage ?? "unknown"}`);
    lines.push(`- Agentic evidence: ${row.agentic.evidenceCoverage ?? "unknown"}`);
    lines.push(`- Extra agentic queries: ${row.delta.extraQueriesTried}`);
    lines.push(
      `- Extra agentic paths: ${row.delta.extraPaths.length > 0 ? row.delta.extraPaths.join(", ") : "none"}`,
    );
    lines.push(`- Behavior changed: ${row.delta.behaviorChanged ? "yes" : "no"}`);
    lines.push(`- Evidence improved: ${row.delta.improvedEvidence ? "yes" : "no"}`);
    lines.push("");
    lines.push("Direct top results:");
    for (const result of row.direct.topResults) {
      lines.push(`- ${result.source} | ${result.score.toFixed(3)} | ${result.path}`);
    }
    if (row.direct.topResults.length === 0) {
      lines.push("- none");
    }
    lines.push("");
    lines.push("Agentic top results:");
    for (const result of row.agentic.topResults) {
      lines.push(`- ${result.source} | ${result.score.toFixed(3)} | ${result.path}`);
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
  return lines.join("\n");
}

async function main() {
  const cfg = resolveEvalConfig();
  const agentId = readFlag("--agent") ?? resolveDefaultAgentId(cfg);
  const queries = await loadQueries();
  const { manager, error } = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
  if (!manager) {
    throw new Error(error ?? "memory manager unavailable");
  }
  if (typeof manager.searchDetailed !== "function") {
    throw new Error("searchDetailed() is unavailable on the active memory manager");
  }

  const rows: EvalRow[] = [];
  for (const query of queries) {
    const direct = await manager.searchDetailed({
      query,
      searchMode: "direct",
      returnPlan: true,
    });
    const agentic = await manager.searchDetailed({
      query,
      searchMode: "agentic",
      returnPlan: true,
    });
    rows.push({
      query,
      direct: summarize(direct),
      agentic: summarize(agentic),
      delta: compareResults(direct, agentic),
    });
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderMarkdown(rows)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
