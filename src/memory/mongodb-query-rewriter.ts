import type { Db } from "mongodb";
import * as mongodbTelemetry from "./mongodb-telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryRewriteConfig = {
  enabled: boolean;
  method: "synonym-expansion";
  maxTokens: number;
};

export type QueryRewriteResult = {
  originalQuery: string;
  rewrittenQuery: string;
  rewritten: boolean;
  method: string;
};

// ---------------------------------------------------------------------------
// Synonym and abbreviation maps
// ---------------------------------------------------------------------------

/**
 * Domain-specific synonym map for agent memory queries.
 * Bidirectional: each key expands to its values.
 */
const SYNONYM_MAP: Record<string, string[]> = {
  auth: ["authentication", "login", "oauth"],
  db: ["database", "mongodb", "collection"],
  // H7 audit fix: removed cross-domain expansions for "api" and "ui"
  // "api" is not a synonym of "route"/"rest"; "ui" is not a synonym of "frontend"/"component"
  bug: ["issue", "error", "defect"],
  perf: ["performance", "latency", "speed"],
  config: ["configuration", "settings", "options"],
  deps: ["dependencies", "packages", "modules"],
  deploy: ["deployment", "release", "publish"],
  docs: ["documentation", "readme", "guide"],
  test: ["testing", "tests", "spec"],
  refactor: ["restructure", "reorganize", "cleanup"],
};

/** Abbreviation expansions (unidirectional: abbreviation -> full form) */
const ABBREVIATION_MAP: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  env: "environment",
  var: "variable",
  fn: "function",
  cb: "callback",
  req: "request",
  res: "response",
  err: "error",
  msg: "message",
  ctx: "context",
  impl: "implementation",
  repo: "repository",
};

// ---------------------------------------------------------------------------
// Synonym expansion (deterministic, zero latency)
// ---------------------------------------------------------------------------

/**
 * Deterministic synonym expansion.
 * For each word in the query:
 *   1. Check if it is an abbreviation -- add full form
 *   2. Check if it matches a synonym group -- add all synonyms
 * Original words are always preserved.
 */
export function expandSynonyms(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = new Set(words);
  // H7 audit fix: cap total expanded words at 3x the original word count.
  // Original words always survive; the cap limits new additions.
  const maxTotal = words.length * 3;
  const expansionBuckets: string[][] = [];

  for (const word of words) {
    const bucket: string[] = [];
    // Abbreviation expansion
    const abbr = ABBREVIATION_MAP[word];
    if (abbr) {
      bucket.push(abbr);
    }
    // Synonym expansion
    const syns = SYNONYM_MAP[word];
    if (syns) {
      bucket.push(...syns);
    }
    if (bucket.length > 0) {
      expansionBuckets.push(bucket);
    }
  }

  // Distribute additions fairly across query terms so later terms are not starved
  // when the expansion cap is reached.
  let bucketIndex = 0;
  while (expanded.size < maxTotal && expansionBuckets.some((bucket) => bucket.length > 0)) {
    const bucket = expansionBuckets[bucketIndex % expansionBuckets.length];
    const next = bucket.shift();
    if (next && !expanded.has(next)) {
      expanded.add(next);
    }
    bucketIndex++;
  }

  return [...expanded].join(" ");
}

// ---------------------------------------------------------------------------
// Query rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a query for improved vector search recall.
 *
 * CRITICAL: The retrieval planner must ALWAYS see the ORIGINAL query.
 * This function is called AFTER planRetrieval() and BEFORE search execution.
 * The cache key must also use the ORIGINAL query.
 *
 * Tier 1 (synonym-expansion): Deterministic, zero latency.
 *   - Expand known abbreviations
 *   - Add synonyms for recognized terms
 *   - Preserve original terms (expansion, not replacement)
 */
export async function rewriteQuery(params: {
  db: Db;
  prefix: string;
  agentId: string;
  query: string;
  config: QueryRewriteConfig;
}): Promise<QueryRewriteResult> {
  const { db, prefix, agentId, query, config } = params;
  const rewriteStart = Date.now();

  if (!config.enabled || !query.trim()) {
    return { originalQuery: query, rewrittenQuery: query, rewritten: false, method: "none" };
  }

  let rewritten: string;
  let method: string;

  switch (config.method) {
    case "synonym-expansion":
      rewritten = expandSynonyms(query);
      method = "synonym-expansion";
      break;
    default:
      throw new Error(
        `Unsupported query rewrite method "${String(config.method)}". ` +
          'Supported values: "synonym-expansion".',
      );
  }

  const wasRewritten = rewritten !== query;
  if (wasRewritten) {
    // Truncate to maxTokens (rough approximation: 1 token ~ 4 chars)
    const maxChars = config.maxTokens * 4;
    if (rewritten.length > maxChars) {
      rewritten = rewritten.slice(0, maxChars).trimEnd();
    }
  }

  mongodbTelemetry.emitTelemetry(db, prefix, {
    meta: { agentId, operation: "query-rewrite" },
    durationMs: Date.now() - rewriteStart,
    ok: true,
    queryRewritten: wasRewritten,
    rewriteMethod: method,
  });

  return { originalQuery: query, rewrittenQuery: rewritten, rewritten: wasRewritten, method };
}
