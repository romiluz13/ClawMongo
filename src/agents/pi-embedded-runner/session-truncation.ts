import fs from "node:fs/promises";
import path from "node:path";
import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { log } from "./logger.js";

/**
 * Rewrites a session transcript after compaction so compacted message entries
 * do not accumulate forever on disk.
 *
 * This only trims transcript artifacts. It never touches ClawMongo's
 * canonical MongoDB memory, which is written through the runtime event path.
 */
export async function truncateSessionAfterCompaction(params: {
  sessionFile: string;
  archivePath?: string;
}): Promise<TruncationResult> {
  const { sessionFile } = params;

  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(sessionFile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`[session-truncation] Failed to open session file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const header = sessionManager.getHeader();
  if (!header) {
    return { truncated: false, entriesRemoved: 0, reason: "missing session header" };
  }

  const branch = sessionManager.getBranch();
  if (branch.length === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "empty session" };
  }

  let latestCompactionIdx = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index].type === "compaction") {
      latestCompactionIdx = index;
      break;
    }
  }

  if (latestCompactionIdx < 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no compaction entry found" };
  }

  if (latestCompactionIdx === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "compaction already at root" };
  }

  const compactionEntry = branch[latestCompactionIdx] as CompactionEntry;
  const summarizedBranchIds = new Set<string>();
  for (let index = 0; index < latestCompactionIdx; index++) {
    if (compactionEntry.firstKeptEntryId && branch[index].id === compactionEntry.firstKeptEntryId) {
      break;
    }
    summarizedBranchIds.add(branch[index].id);
  }

  const allEntries = sessionManager.getEntries();
  const removedIds = new Set<string>();
  for (const entry of allEntries) {
    if (summarizedBranchIds.has(entry.id) && entry.type === "message") {
      removedIds.add(entry.id);
    }
  }

  for (const entry of allEntries) {
    if (entry.type === "label" && removedIds.has(entry.targetId)) {
      removedIds.add(entry.id);
      continue;
    }
    if (
      entry.type === "branch_summary" &&
      entry.parentId !== null &&
      removedIds.has(entry.parentId)
    ) {
      removedIds.add(entry.id);
    }
  }

  if (removedIds.size === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no entries to remove" };
  }

  const entryById = new Map<string, SessionEntry>();
  for (const entry of allEntries) {
    entryById.set(entry.id, entry);
  }

  const keptEntries: SessionEntry[] = [];
  for (const entry of allEntries) {
    if (removedIds.has(entry.id)) {
      continue;
    }

    let newParentId = entry.parentId;
    while (newParentId !== null && removedIds.has(newParentId)) {
      const parent = entryById.get(newParentId);
      newParentId = parent?.parentId ?? null;
    }

    keptEntries.push(newParentId !== entry.parentId ? { ...entry, parentId: newParentId } : entry);
  }

  let bytesBefore = 0;
  try {
    const stat = await fs.stat(sessionFile);
    bytesBefore = stat.size;
  } catch {
    // Best-effort metric only.
  }

  if (params.archivePath) {
    try {
      await fs.mkdir(path.dirname(params.archivePath), { recursive: true });
      await fs.copyFile(sessionFile, params.archivePath);
      log.info(`[session-truncation] Archived pre-truncation file to ${params.archivePath}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(`[session-truncation] Failed to archive transcript: ${reason}`);
    }
  }

  const content =
    [JSON.stringify(header), ...keptEntries.map((entry) => JSON.stringify(entry))].join("\n") +
    "\n";
  const tmpFile = `${sessionFile}.truncate-tmp`;

  try {
    await fs.writeFile(tmpFile, content, "utf-8");
    await fs.rename(tmpFile, sessionFile);
  } catch (error) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore temp cleanup failures.
    }
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`[session-truncation] Failed to write truncated file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const bytesAfter = Buffer.byteLength(content, "utf-8");
  log.info(
    `[session-truncation] Truncated session file: entriesBefore=${allEntries.length} ` +
      `entriesAfter=${keptEntries.length} removed=${removedIds.size} ` +
      `bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
      `reduction=${bytesBefore > 0 ? ((1 - bytesAfter / bytesBefore) * 100).toFixed(1) : "?"}%`,
  );

  return {
    truncated: true,
    entriesRemoved: removedIds.size,
    bytesBefore,
    bytesAfter,
  };
}

export type TruncationResult = {
  truncated: boolean;
  entriesRemoved: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reason?: string;
};
