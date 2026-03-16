#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Options = {
  baseRef: string;
  targetRef: string;
  protectedPathsPath: string;
  excludedPathsPath: string;
  writePath: string | null;
  maxCommits: number;
};

type CommitLine = {
  sha: string;
  subject: string;
};

const BACKEND_SPECIFIC_PATTERN = /\b(sqlite|qmd|lance(db)?|lancedb|qdrant|chroma)\b/i;
const IDEA_PORT_PATTERN =
  /\b(memory|context|compaction|transcript|session|prompt|search|yield|snapshot)\b/i;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    baseRef: "origin/main",
    targetRef: "upstream/main",
    protectedPathsPath: "scripts/upstream-protected-paths.txt",
    excludedPathsPath: "scripts/upstream-excluded-paths.txt",
    writePath: null,
    maxCommits: 20,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--base":
        if (!next) {
          throw new Error("Missing value for --base");
        }
        options.baseRef = next;
        index++;
        break;
      case "--target":
        if (!next) {
          throw new Error("Missing value for --target");
        }
        options.targetRef = next;
        index++;
        break;
      case "--protected-paths":
        if (!next) {
          throw new Error("Missing value for --protected-paths");
        }
        options.protectedPathsPath = next;
        index++;
        break;
      case "--excluded-paths":
        if (!next) {
          throw new Error("Missing value for --excluded-paths");
        }
        options.excludedPathsPath = next;
        index++;
        break;
      case "--write":
        if (!next) {
          throw new Error("Missing value for --write");
        }
        options.writePath = next;
        index++;
        break;
      case "--max-commits":
        if (!next || Number.isNaN(Number(next))) {
          throw new Error("Missing/invalid value for --max-commits");
        }
        options.maxCommits = Number(next);
        index++;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage() {
  process.stdout.write(`Usage: node --import tsx scripts/upstream-sync-report.ts [options]

Options:
  --base <git-ref>             Base ref for the sync wave (default: origin/main)
  --target <git-ref>           Target ref for the sync wave (default: upstream/main)
  --protected-paths <path>     Protected-path manifest
  --excluded-paths <path>      Excluded-path manifest
  --write <path>               Write the Markdown report to disk
  --max-commits <count>        Number of upstream commits to include (default: 20)
  --help                       Show this help
`);
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function gitLines(args: string[]): string[] {
  const output = git(args);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadPathList(path: string): string[] {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    return [];
  }

  return readFileSync(absolutePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function matchesConfiguredPath(filePath: string, configuredPath: string): boolean {
  return configuredPath.endsWith("/")
    ? filePath.startsWith(configuredPath)
    : filePath === configuredPath;
}

function classifyHotspot(filePath: string): string {
  if (filePath === "package.json") {
    return "release and dependency surface";
  }
  if (filePath.includes("pi-embedded-runner") || filePath.includes("runtime-write")) {
    return "runtime write path";
  }
  if (filePath.includes("transcript") || filePath.includes("chat")) {
    return "session or gateway persistence seam";
  }
  if (
    filePath.includes("system-prompt") ||
    filePath.includes("memory-tool") ||
    filePath.includes("pi-tools")
  ) {
    return "prompt or memory tool surface";
  }
  if (filePath.includes("config/")) {
    return "config or schema validation";
  }
  if (filePath.includes("search-manager") || filePath.includes("memory-search")) {
    return "retrieval and search behavior";
  }
  if (filePath.includes("deliver") || filePath.includes("outbound")) {
    return "outbound persistence seam";
  }
  if (filePath.includes("tools-invoke-http")) {
    return "tool invocation transport";
  }
  if (filePath.includes("mongodb-") || filePath.includes("src/memory/")) {
    return "MongoDB backend seam";
  }
  return "protected fork seam";
}

function parseCommitLines(baseRef: string, targetRef: string, maxCommits: number): CommitLine[] {
  const raw = gitLines([
    "log",
    "--no-merges",
    "--format=%H%x09%s",
    `${baseRef}..${targetRef}`,
    "-n",
    String(maxCommits),
  ]);

  return raw.map((line) => {
    const [sha, ...subjectParts] = line.split("\t");
    return {
      sha: sha.slice(0, 12),
      subject: subjectParts.join("\t"),
    };
  });
}

function describeRef(ref: string): string {
  return tryGit(["describe", "--tags", "--abbrev=0", ref]) ?? "(no tag)";
}

function formatBullets(items: string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function formatCommitBullets(commits: CommitLine[], emptyMessage: string): string {
  if (commits.length === 0) {
    return `- ${emptyMessage}`;
  }
  return commits.map((commit) => `- \`${commit.sha}\` ${commit.subject}`).join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headAhead = git(["rev-list", "--count", `${options.targetRef}..HEAD`]);
  const headBehind = git(["rev-list", "--count", `HEAD..${options.targetRef}`]);
  const baseAhead = git(["rev-list", "--count", `${options.targetRef}..${options.baseRef}`]);
  const baseBehind = git(["rev-list", "--count", `${options.baseRef}..${options.targetRef}`]);
  const diffSummary = git(["diff", "--shortstat", `${options.baseRef}...${options.targetRef}`]);
  const protectedPaths = loadPathList(options.protectedPathsPath);
  const excludedPaths = loadPathList(options.excludedPathsPath);
  const changedFiles = gitLines([
    "diff",
    "--name-only",
    `${options.baseRef}...${options.targetRef}`,
  ]);
  const protectedHotspots = protectedPaths
    .filter((filePath) => changedFiles.includes(filePath))
    .map((filePath) => `${filePath} (${classifyHotspot(filePath)})`);
  const excludedChanges = changedFiles.filter((filePath) =>
    excludedPaths.some((configuredPath) => matchesConfiguredPath(filePath, configuredPath)),
  );
  const recentCommits = parseCommitLines(options.baseRef, options.targetRef, options.maxCommits);
  const ideaPortCommits = recentCommits.filter(
    (commit) =>
      IDEA_PORT_PATTERN.test(commit.subject) && !BACKEND_SPECIFIC_PATTERN.test(commit.subject),
  );
  const backendSpecificCommits = recentCommits.filter((commit) =>
    BACKEND_SPECIFIC_PATTERN.test(commit.subject),
  );

  const report = `# Upstream Sync Report

## Range

- Base ref: \`${options.baseRef}\`
- Target ref: \`${options.targetRef}\`
- Base tag: \`${describeRef(options.baseRef)}\`
- Target tag: \`${describeRef(options.targetRef)}\`
- Current branch: \`${currentBranch}\`
- Diff summary: ${diffSummary || "no file changes"}

## Divergence

- \`${options.baseRef}\` is ${baseAhead} ahead and ${baseBehind} behind \`${options.targetRef}\`
- \`HEAD\` is ${headAhead} ahead and ${headBehind} behind \`${options.targetRef}\`

## Protected MongoDB-First Hotspots

${formatBullets(protectedHotspots, "No protected hotspots changed in this range.")}

## Excluded Backend Paths Changed Upstream

${formatBullets(excludedChanges, "No excluded backend paths changed in this range.")}

## Candidate Idea-Port Commits

${formatCommitBullets(ideaPortCommits, "No idea-port candidates matched the current heuristics.")}

## Likely Backend-Specific Commits to Ignore

${formatCommitBullets(
  backendSpecificCommits,
  "No obviously backend-specific upstream commits matched the current heuristics.",
)}

## Recent Upstream Commits

${formatCommitBullets(recentCommits, "No commits in the requested range.")}

## Validation Gate

- \`pnpm build\`
- \`pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose\`
- \`pnpm vitest run src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose\`
`;

  if (options.writePath) {
    writeFileSync(resolve(options.writePath), `${report}\n`);
  }

  process.stdout.write(`${report}\n`);
}

main();
