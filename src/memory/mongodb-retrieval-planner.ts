import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:planner");

export type RetrievalPath = "structured" | "raw-window" | "graph" | "hybrid" | "kb" | "episodic";

export type RetrievalTimeRangePreset =
  | "today"
  | "yesterday"
  | "last-24h"
  | "last-7d"
  | "this-week"
  | "last-30d"
  | "this-month";

export type RetrievalConstraints = {
  timeRange?: {
    preset: RetrievalTimeRangePreset;
    hard: boolean;
    reason: string;
  };
  structured?: {
    type?: string;
    hard: boolean;
    reason: string;
  };
  kb?: {
    source?: "api" | "manual" | "file" | "url";
    hard: boolean;
    reason: string;
  };
  entities?: {
    names: string[];
    hard: boolean;
    reason: string;
  };
};

export type RetrievalPlan = {
  paths: RetrievalPath[];
  confidence: "high" | "medium" | "low";
  reasoning: string;
  constraints?: RetrievalConstraints;
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

const STRUCTURED_TYPE_MATCHERS: Array<{ type: string; regexes: RegExp[] }> = [
  { type: "decision", regexes: buildKeywordRegexes(["decision", "decided", "choose", "chose"]) },
  {
    type: "preference",
    regexes: buildKeywordRegexes(["prefer", "preference", "i like", "i don't like"]),
  },
  { type: "todo", regexes: buildKeywordRegexes(["todo", "task", "remind me", "follow up"]) },
  { type: "person", regexes: buildKeywordRegexes(["who is", "person", "contact"]) },
  {
    type: "project",
    regexes: buildKeywordRegexes(["project plan", "project status", "project decision", "roadmap"]),
  },
  {
    type: "architecture",
    regexes: buildKeywordRegexes(["architecture", "design", "system design"]),
  },
  { type: "fact", regexes: buildKeywordRegexes(["fact", "remember that", "note that"]) },
];

const KB_SOURCE_MATCHERS: Array<{ source: "api" | "manual" | "file" | "url"; regexes: RegExp[] }> =
  [
    { source: "api", regexes: buildKeywordRegexes(["api", "endpoint", "rest api"]) },
    { source: "manual", regexes: buildKeywordRegexes(["manual"]) },
    { source: "file", regexes: buildKeywordRegexes(["file", "files"]) },
    { source: "url", regexes: buildKeywordRegexes(["url", "link", "website"]) },
  ];

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function startOfUtcMonth(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), 1));
}

function startOfUtcWeek(input: Date): Date {
  const day = input.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = startOfUtcDay(input);
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

export function resolveTimeRangePreset(
  preset: RetrievalTimeRangePreset,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const end = new Date(now);
  switch (preset) {
    case "today":
      return { start: startOfUtcDay(now), end };
    case "yesterday": {
      const todayStart = startOfUtcDay(now);
      const start = new Date(todayStart);
      start.setUTCDate(start.getUTCDate() - 1);
      const yesterdayEnd = new Date(todayStart.getTime() - 1);
      return { start, end: yesterdayEnd };
    }
    case "last-24h":
      return { start: new Date(end.getTime() - 24 * 60 * 60 * 1000), end };
    case "last-7d":
      return { start: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000), end };
    case "this-week":
      return { start: startOfUtcWeek(now), end };
    case "last-30d":
      return { start: new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000), end };
    case "this-month":
      return { start: startOfUtcMonth(now), end };
  }
}

function extractTimeConstraint(query: string): RetrievalConstraints["timeRange"] | undefined {
  const lower = query.toLowerCase();
  if (/\byesterday\b/.test(lower)) {
    return { preset: "yesterday", hard: true, reason: "explicit yesterday constraint" };
  }
  if (/\b(today|this morning|this afternoon|this evening|earlier today)\b/.test(lower)) {
    return { preset: "today", hard: true, reason: "explicit same-day constraint" };
  }
  if (/\b(last hour|recent|recently|just now|latest)\b/.test(lower)) {
    return { preset: "last-24h", hard: true, reason: "explicit recentness constraint" };
  }
  if (/\blast week\b/.test(lower)) {
    return { preset: "last-7d", hard: true, reason: "explicit last-week constraint" };
  }
  if (/\bthis week\b/.test(lower)) {
    return { preset: "this-week", hard: true, reason: "explicit this-week constraint" };
  }
  if (/\blast month\b/.test(lower)) {
    return { preset: "last-30d", hard: true, reason: "explicit last-month constraint" };
  }
  if (/\bthis month\b/.test(lower)) {
    return { preset: "this-month", hard: true, reason: "explicit this-month constraint" };
  }
  return undefined;
}

function extractStructuredConstraint(
  query: string,
): RetrievalConstraints["structured"] | undefined {
  for (const matcher of STRUCTURED_TYPE_MATCHERS) {
    if (matcher.regexes.some((re) => re.test(query))) {
      return {
        type: matcher.type,
        hard: true,
        reason: `structured ${matcher.type} constraint detected`,
      };
    }
  }
  if (STRUCTURED_REGEXES.some((re) => re.test(query))) {
    return {
      hard: false,
      reason: "generic structured-memory signal detected",
    };
  }
  return undefined;
}

function extractKBConstraint(query: string): RetrievalConstraints["kb"] | undefined {
  for (const matcher of KB_SOURCE_MATCHERS) {
    if (matcher.regexes.some((re) => re.test(query))) {
      return {
        source: matcher.source,
        hard: true,
        reason: `KB source constraint detected (${matcher.source})`,
      };
    }
  }
  if (KB_REGEXES.some((re) => re.test(query))) {
    return {
      hard: false,
      reason: "generic KB/documentation signal detected",
    };
  }
  return undefined;
}

function extractEntityConstraint(
  query: string,
  knownEntityNames?: string[],
): RetrievalConstraints["entities"] | undefined {
  const lower = query.toLowerCase();
  const names =
    knownEntityNames
      ?.map((name) => name.trim())
      .filter((name) => name.length > 0 && lower.includes(name.toLowerCase())) ?? [];
  if (names.length === 0) {
    return undefined;
  }
  return {
    names: Array.from(new Set(names)),
    hard: true,
    reason: "matched known entity names in query",
  };
}

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
    const constraints: RetrievalConstraints = {};

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
    const structuredConstraint = extractStructuredConstraint(query);
    if (structuredConstraint) {
      scores.structured += 3;
      constraints.structured = structuredConstraint;
      reasons.push(structuredConstraint.reason);
    }

    // Check time signals (word-boundary regex)
    const timeConstraint = extractTimeConstraint(query);
    if (timeConstraint ?? TIME_REGEXES.some((re) => re.test(query))) {
      scores["raw-window"] += 3;
      if (timeConstraint) {
        constraints.timeRange = timeConstraint;
        reasons.push(timeConstraint.reason);
      } else {
        reasons.push("time-related keywords detected");
      }
    }

    // Check entity/graph signals (filter empty names)
    const lower = query.toLowerCase();
    const entityConstraint = extractEntityConstraint(query, context.knownEntityNames);
    if (entityConstraint) {
      scores.graph += 3;
      constraints.entities = entityConstraint;
      reasons.push(entityConstraint.reason);
    }
    if (lower.includes("who") || lower.includes("relationship") || lower.includes("connected")) {
      scores.graph += 2;
      reasons.push("relationship query detected");
    }

    // Check KB signals (word-boundary regex)
    const kbConstraint = extractKBConstraint(query);
    if (kbConstraint) {
      scores.kb += 3;
      constraints.kb = kbConstraint;
      reasons.push(kbConstraint.reason);
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
      ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    };
  } catch (err) {
    log.error("planRetrieval failed", { query, error: err });
    throw err;
  }
}
