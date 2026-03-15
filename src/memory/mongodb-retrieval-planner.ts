import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:planner");

export type RetrievalPath = "structured" | "raw-window" | "graph" | "hybrid" | "kb" | "episodic";

export type RetrievalPlan = {
  paths: RetrievalPath[];
  confidence: "high" | "medium" | "low";
  reasoning: string;
};

export type RetrievalContext = {
  /** Available sources based on config */
  availablePaths: Set<RetrievalPath>;
  /** Known entity names for graph matching */
  knownEntityNames?: string[];
  /** Whether episodes exist */
  hasEpisodes?: boolean;
  /** Whether graph has entities */
  hasGraphData?: boolean;
};

// ---------------------------------------------------------------------------
// Keyword lists and pre-compiled word-boundary regexes
// ---------------------------------------------------------------------------

function buildKeywordRegexes(keywords: string[]): RegExp[] {
  return keywords.map(
    (kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  );
}

// Structured memory keywords
const STRUCTURED_KEYWORDS = [
  "prefer",
  "preference",
  "decision",
  "decided",
  "rule",
  "convention",
  "remember that",
  "my name",
  "i like",
  "i don't like",
  "always",
  "never",
  "todo",
  "task",
  "remind me",
];
const STRUCTURED_REGEXES = buildKeywordRegexes(STRUCTURED_KEYWORDS);

// Time-related keywords for raw-window detection
const TIME_KEYWORDS = [
  "today",
  "yesterday",
  "this morning",
  "this afternoon",
  "this evening",
  "last hour",
  "last week",
  "this week",
  "last month",
  "this month",
  "recent",
  "recently",
  "earlier today",
  "just now",
  "latest",
];
const TIME_REGEXES = buildKeywordRegexes(TIME_KEYWORDS);

// KB keywords
const KB_KEYWORDS = [
  "docs",
  "documentation",
  "reference",
  "manual",
  "guide",
  "how to",
  "instructions",
  "spec",
  "specification",
];
const KB_REGEXES = buildKeywordRegexes(KB_KEYWORDS);

// Episodic / summary keywords
const EPISODIC_KEYWORDS = [
  "summarize",
  "summary",
  "overview",
  "recap",
  "what happened",
  "highlights",
  "review",
  "report on",
  "digest",
];
const EPISODIC_REGEXES = buildKeywordRegexes(EPISODIC_KEYWORDS);

// Deterministic tie-breaking priority (lower = higher priority)
const PATH_PRIORITY: Record<RetrievalPath, number> = {
  structured: 0,
  "raw-window": 1,
  graph: 2,
  episodic: 3,
  kb: 4,
  hybrid: 5,
};

/**
 * Plan retrieval paths based on keyword heuristics and available sources.
 * Returns paths sorted by score descending, filtered by availability.
 */
export function planRetrieval(query: string, context: RetrievalContext): RetrievalPlan {
  try {
    // Guard: empty or whitespace-only query
    if (!query.trim()) {
      return {
        paths: context.availablePaths.has("hybrid") ? ["hybrid"] : [],
        confidence: "low" as const,
        reasoning: "empty query",
      };
    }

    const reasons: string[] = [];

    // Score each path
    const scores: Record<RetrievalPath, number> = {
      structured: 0,
      "raw-window": 0,
      graph: 0,
      hybrid: 0,
      kb: 0,
      episodic: 0,
    };

    // Check structured signals (word-boundary regex)
    if (STRUCTURED_REGEXES.some((re) => re.test(query))) {
      scores.structured += 3;
      reasons.push("structured keywords detected");
    }

    // Check time signals (word-boundary regex)
    if (TIME_REGEXES.some((re) => re.test(query))) {
      scores["raw-window"] += 3;
      reasons.push("time-related keywords detected");
    }

    // Check entity/graph signals (filter empty names)
    const lower = query.toLowerCase();
    if (
      context.knownEntityNames
        ?.filter((n) => n.trim())
        .some((name) => lower.includes(name.toLowerCase()))
    ) {
      scores.graph += 3;
      reasons.push("known entity name detected");
    }
    if (lower.includes("who") || lower.includes("relationship") || lower.includes("connected")) {
      scores.graph += 2;
      reasons.push("relationship query detected");
    }

    // Check KB signals (word-boundary regex)
    if (KB_REGEXES.some((re) => re.test(query))) {
      scores.kb += 3;
      reasons.push("KB/documentation keywords detected");
    }

    // Check episodic signals (word-boundary regex)
    if (EPISODIC_REGEXES.some((re) => re.test(query))) {
      scores.episodic += 3;
      reasons.push("episodic/summary keywords detected");
    }

    // Hybrid is always baseline
    scores.hybrid += 1;

    // Sort by score descending, then by priority for deterministic tie-breaking
    const sorted = (Object.entries(scores) as [RetrievalPath, number][])
      .filter(([path]) => context.availablePaths.has(path))
      .toSorted((a, b) => b[1] - a[1] || PATH_PRIORITY[a[0]] - PATH_PRIORITY[b[0]])
      .map(([path]) => path);

    // Return empty paths if nothing available (do not inject unavailable hybrid)
    const finalPaths = sorted;

    // Confidence based on signal strength
    const topScore = scores[finalPaths[0]] ?? 0;
    const confidence = topScore >= 3 ? "high" : topScore >= 2 ? "medium" : "low";

    return {
      paths: finalPaths,
      confidence,
      reasoning:
        reasons.length > 0 ? reasons.join("; ") : "no strong signals, defaulting to hybrid",
    };
  } catch (err) {
    log.error("planRetrieval failed", { query, error: err });
    throw err;
  }
}
