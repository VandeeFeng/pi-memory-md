import path from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { toTimestamp } from "../utils.js";

const HANDOFF_BOOST = 30;
const KEYWORD_HANDOFF_BOOST = 40;

export type MemoryPathStats = {
  count: number;
  lastAccess: number;
  score: number;
  readCount: number;
  editCount: number;
  writeCount: number;
  memoryReadCount: number;
  memoryWriteCount: number;
};

export type SupportedPathToolName = "memory_write" | "read" | "edit" | "write";

type AnchorWindow = {
  timestamp: string | null;
  windowEnd: number | null;
  boost: number;
};

type AnalyzePathAccessOptions = {
  scanHours: number;
  resolveTrackedPath: (toolName: SupportedPathToolName, entryPath: string) => string | null;
  pathExists: (filePath: string) => boolean;
  getLatestAnchor: (
    scanHours: number,
    match: (anchor: { type: string; meta?: { trigger?: string } }) => boolean,
  ) => { timestamp: string } | null;
  getAnchorWindowEndTimestamp: (anchor: { timestamp: string } | null, entries: SessionEntry[]) => number | null;
};

// type RangeToolName = "memory_read" | "read" | "edit";
type RangeToolName = "read" | "edit";

export type LineRange = {
  kind: "read" | "edit";
  start: number;
  end: number;
};

type AnalyzeLineRangesOptions = {
  targetPaths: string[];
  resolveTrackedPath: (toolName: RangeToolName, entryPath: string) => string | null;
  toAbsolutePath: (filePath: string) => string;
};

function createEmptyMemoryPathStats(): MemoryPathStats {
  return {
    count: 0,
    lastAccess: 0,
    score: 0,
    readCount: 0,
    editCount: 0,
    writeCount: 0,
    memoryReadCount: 0,
    memoryWriteCount: 0,
  };
}

export function analyzePathAccess(
  entries: SessionEntry[],
  options: AnalyzePathAccessOptions,
): { paths: Map<string, MemoryPathStats>; totalAccesses: number } {
  const pathStats = new Map<string, MemoryPathStats>();
  const anchorWindows = createAnchorWindows(entries, options);
  let totalAccesses = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const messageEntry = entry as SessionMessageEntry;
    if (messageEntry.message.role !== "assistant") continue;
    if (!Array.isArray(messageEntry.message.content)) continue;

    const accessTime = toTimestamp(entry.timestamp);
    for (const block of messageEntry.message.content) {
      if (block.type !== "toolCall") continue;

      const entryPath = block.arguments.path as string | undefined;
      const toolName = block.name as SupportedPathToolName;
      if (!entryPath) continue;

      const trackedPath = options.resolveTrackedPath(toolName, entryPath);
      if (!trackedPath || !options.pathExists(trackedPath)) continue;

      totalAccesses += 1;
      const stats = pathStats.get(trackedPath) ?? createEmptyMemoryPathStats();
      const multiplier = getDiminishingReturnsMultiplier(stats.count);
      const accessScore = getAccessScore(toolName);
      const boost = anchorWindows.reduce((total, anchorWindow) => total + getAnchorBoost(accessTime, anchorWindow), 0);

      stats.count += 1;
      stats.lastAccess = Math.max(stats.lastAccess, accessTime);
      stats.score += (accessScore + boost) * multiplier;
      recordToolAccess(stats, toolName);
      pathStats.set(trackedPath, stats);
    }
  }

  return { paths: pathStats, totalAccesses };
}

export function sortPathsByStats(pathStats: Map<string, MemoryPathStats>): string[] {
  return Array.from(pathStats.entries())
    .sort(([, left], [, right]) => {
      const leftFinalScore = getFinalScore(left);
      const rightFinalScore = getFinalScore(right);

      return rightFinalScore - leftFinalScore || right.score - left.score || right.lastAccess - left.lastAccess;
    })
    .map(([memoryPath]) => memoryPath);
}

export function analyzeRecentLineRanges(
  entries: SessionEntry[],
  options: AnalyzeLineRangesOptions,
): Map<string, LineRange[]> {
  const targetPaths = new Set(options.targetPaths.map((filePath) => path.resolve(options.toAbsolutePath(filePath))));
  const pendingEditPaths = new Map<string, string>();
  const rangeMap = new Map<string, LineRange[]>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const messageEntry = entry as SessionMessageEntry & {
      message: {
        role: string;
        toolCallId?: string;
        toolName?: string;
        details?: { firstChangedLine?: number; diff?: string };
        content?: Array<{
          type: string;
          id?: string;
          name?: string;
          arguments?: { path?: string; offset?: number; limit?: number };
        }>;
      };
    };

    if (messageEntry.message.role === "assistant" && Array.isArray(messageEntry.message.content)) {
      for (const block of messageEntry.message.content) {
        if (block.type !== "toolCall") continue;

        const toolName = block.name as RangeToolName;
        const entryPath = block.arguments?.path;
        const trackedPath = entryPath ? options.resolveTrackedPath(toolName, entryPath) : null;
        if (!trackedPath) continue;

        const resolvedPath = path.resolve(options.toAbsolutePath(trackedPath));
        if (!targetPaths.has(resolvedPath)) continue;

        // if (toolName === "read" || toolName === "memory_read") {
        if (toolName === "read") {
          const range = createReadRange(block.arguments?.offset, block.arguments?.limit);
          if (range) pushLineRange(rangeMap, resolvedPath, range);
        }

        if (toolName === "edit" && block.id) {
          pendingEditPaths.set(block.id, resolvedPath);
        }
      }
    }

    if (messageEntry.message.role !== "toolResult" || messageEntry.message.toolName !== "edit") {
      continue;
    }

    const toolCallId = messageEntry.message.toolCallId;
    const trackedPath = toolCallId ? pendingEditPaths.get(toolCallId) : null;
    if (!trackedPath) continue;

    for (const range of extractEditRanges(messageEntry.message.details)) {
      pushLineRange(rangeMap, trackedPath, range);
    }
    pendingEditPaths.delete(toolCallId);
  }

  for (const [filePath, ranges] of rangeMap) {
    rangeMap.set(filePath, mergeLineRanges(ranges).slice(0, 5));
  }

  return rangeMap;
}

function createReadRange(offset: number | undefined, limit: number | undefined): LineRange | null {
  const normalizedOffset = offset ?? 0;
  const normalizedLimit = limit ?? 0;
  const start = Number.isFinite(normalizedOffset) && normalizedOffset > 0 ? Math.floor(normalizedOffset) : 1;
  if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) return null;
  return { kind: "read", start, end: start + Math.floor(normalizedLimit) - 1 };
}

function extractEditRanges(details: { firstChangedLine?: number; diff?: string } | undefined): LineRange[] {
  const firstChangedLine = details?.firstChangedLine;
  if (!details?.diff) {
    return typeof firstChangedLine === "number"
      ? [{ kind: "edit", start: firstChangedLine, end: firstChangedLine }]
      : [];
  }

  const sections = details.diff.split(/\n\s*\.\.\.\s*\n/g);
  const ranges: LineRange[] = [];

  for (const section of sections) {
    const lineNumbers = [...section.matchAll(/^\s*[+\- ]?\s*(\d+)\s/gm)]
      .map((match) => match[1])
      .filter((lineNumber): lineNumber is string => lineNumber !== undefined)
      .map((lineNumber) => Number.parseInt(lineNumber, 10));
    if (lineNumbers.length === 0) continue;
    ranges.push({
      kind: "edit",
      start: Math.min(...lineNumbers),
      end: Math.max(...lineNumbers),
    });
  }

  if (ranges.length > 0) return ranges;
  if (typeof firstChangedLine !== "number") return [];
  return [{ kind: "edit", start: firstChangedLine, end: firstChangedLine }];
}

function pushLineRange(rangeMap: Map<string, LineRange[]>, filePath: string, range: LineRange): void {
  const ranges = rangeMap.get(filePath) ?? [];
  ranges.push(range);
  rangeMap.set(filePath, ranges);
}

function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  const merged: LineRange[] = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || previous.kind !== range.kind || range.start > previous.end + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.end = Math.max(previous.end, range.end);
  }

  return merged.reverse();
}

function createAnchorWindows(entries: SessionEntry[], options: AnalyzePathAccessOptions): AnchorWindow[] {
  const recentHandoffAnchor = options.getLatestAnchor(options.scanHours, (anchor) => anchor.type === "handoff");
  const recentKeywordHandoffAnchor = options.getLatestAnchor(
    options.scanHours,
    (anchor) => anchor.type === "handoff" && anchor.meta?.trigger === "keyword",
  );

  return [
    {
      timestamp: recentHandoffAnchor?.timestamp ?? null,
      windowEnd: options.getAnchorWindowEndTimestamp(recentHandoffAnchor, entries),
      boost: HANDOFF_BOOST,
    },
    {
      timestamp: recentKeywordHandoffAnchor?.timestamp ?? null,
      windowEnd: options.getAnchorWindowEndTimestamp(recentKeywordHandoffAnchor, entries),
      boost: KEYWORD_HANDOFF_BOOST,
    },
  ];
}

function getAccessScore(toolName: SupportedPathToolName): number {
  switch (toolName) {
    case "memory_write":
      return 16;
    // case "memory_read":
    //   return 10;
    case "write":
      return 30;
    case "edit":
      return 28;
    case "read":
      return 20;
  }
}

function getDiminishingReturnsMultiplier(count: number): number {
  if (count === 0) return 1;
  if (count === 1) return 0.6;
  if (count === 2) return 0.35;
  return 0.15;
}

function recordToolAccess(stats: MemoryPathStats, toolName: SupportedPathToolName): void {
  switch (toolName) {
    // case "memory_read":
    //   stats.memoryReadCount += 1;
    //   return;
    case "memory_write":
      stats.memoryWriteCount += 1;
      return;
    case "read":
      stats.readCount += 1;
      return;
    case "edit":
      stats.editCount += 1;
      return;
    case "write":
      stats.writeCount += 1;
      return;
  }
}

function getFinalScore(stats: MemoryPathStats): number {
  const distinctToolKinds = [
    // stats.memoryReadCount > 0,
    stats.memoryWriteCount > 0,
    stats.readCount > 0,
    stats.editCount > 0,
    stats.writeCount > 0,
  ].filter(Boolean).length;
  const recencyBonus = getRecencyBonus(stats.lastAccess);
  const repeatPenalty = Math.max(0, stats.count - distinctToolKinds) * 2;

  return stats.score + recencyBonus - repeatPenalty;
}

function getRecencyBonus(lastAccess: number): number {
  const hoursSinceLastAccess = Math.max(0, (Date.now() - lastAccess) / (1000 * 60 * 60));

  if (hoursSinceLastAccess <= 6) return 12;
  if (hoursSinceLastAccess <= 24) return 8;
  if (hoursSinceLastAccess <= 72) return 4;
  return 0;
}

function getAnchorBoost(accessTime: number, anchorWindow: AnchorWindow): number {
  if (!anchorWindow.timestamp || anchorWindow.windowEnd === null) return 0;

  const anchorTime = toTimestamp(anchorWindow.timestamp);
  if (accessTime < anchorTime || accessTime > anchorWindow.windowEnd) return 0;

  const hoursSinceAnchor = (accessTime - anchorTime) / (1000 * 60 * 60);

  if (hoursSinceAnchor <= 6) return anchorWindow.boost;
  if (hoursSinceAnchor <= 24) return anchorWindow.boost * 0.6;
  if (hoursSinceAnchor <= 72) return anchorWindow.boost * 0.3;
  return 0;
}
