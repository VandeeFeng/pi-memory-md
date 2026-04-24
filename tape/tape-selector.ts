import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import matter from "gray-matter";
import { formatTimeSuffix, hoursAgoIso, resolveFrom, toRelativeIfInside, toTimestamp } from "../utils.js";
import type { TapeService } from "./tape-service.js";
import type { TapeKeywordConfig } from "./tape-types.js";

const CHARS_PER_TOKEN = 4;

export interface TapeMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export function extractMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text || "").join("");
  return "";
}

function entryToMessage(entry: SessionEntry): TapeMessage | null {
  switch (entry.type) {
    case "message": {
      const messageEntry = entry as { message: { role: string; content?: unknown } };
      return {
        role: messageEntry.message.role === "user" ? "user" : "assistant",
        content: extractMessageContent(messageEntry.message.content),
      };
    }
    case "custom": {
      const customEntry = entry as { customType?: string; data?: unknown };
      return {
        role: "assistant",
        content: `[${customEntry.customType?.split("/").pop() ?? "custom"}] ${customEntry.data ? JSON.stringify(customEntry.data, null, 2) : ""}`,
      };
    }
    case "thinking_level_change":
      return { role: "assistant", content: `[Thinking level: ${entry.thinkingLevel}]` };
    case "model_change":
      return { role: "assistant", content: `[Model: ${entry.provider}/${entry.modelId}]` };
    case "compaction":
      return { role: "assistant", content: `[Compaction] ${entry.summary}` };
    default:
      return null;
  }
}

export function formatEntriesAsMessages(entries: SessionEntry[]): TapeMessage[] {
  return entries.map(entryToMessage).filter((message): message is TapeMessage => message !== null);
}

function formatEntryLine(entry: SessionEntry): string | null {
  switch (entry.type) {
    case "message": {
      const messageEntry = entry as { message: { role: string; content?: unknown } };
      const content = extractMessageContent(messageEntry.message.content);
      const truncated = content.length > 80 ? `${content.substring(0, 80)}...` : content;
      return `${messageEntry.message.role === "user" ? "User" : "Assistant"}: ${truncated}`;
    }
    case "custom":
      return `-- ${(entry as { customType?: string }).customType ?? "custom"} --`;
    case "thinking_level_change":
      return `[Thinking: ${entry.thinkingLevel}]`;
    case "model_change":
      return `[Model: ${entry.provider}/${entry.modelId}]`;
    case "compaction":
      return `[Compaction] ${entry.summary?.substring(0, 50)}`;
    default:
      return null;
  }
}

// Conversation selection.
export class ConversationSelector {
  constructor(
    private tapeService: TapeService,
    private maxTokens = 1000,
    private maxEntries = 40,
  ) {}

  selectFromAnchor(anchorId?: string): SessionEntry[] {
    const entries = this.tapeService
      .query({ sinceAnchor: anchorId, scope: "session", anchorScope: "current-session" })
      .slice(-this.maxEntries);
    return this.filterByTokenBudget(entries);
  }

  buildFormattedContext(entries: SessionEntry[]): string {
    const lines = entries.map(formatEntryLine).filter((line): line is string => line !== null);
    return lines.length > 0 ? `${lines.join("\n")}\n\n---\n` : "";
  }

  private filterByTokenBudget(entries: SessionEntry[]): SessionEntry[] {
    let totalTokens = 0;
    const filtered: SessionEntry[] = [];

    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const tokens = Math.ceil(JSON.stringify(entry).length / CHARS_PER_TOKEN);
      if (totalTokens + tokens > this.maxTokens) {
        if (filtered.length === 0) {
          filtered.push(entry);
        }
        break;
      }

      totalTokens += tokens;
      filtered.push(entry);
    }

    return filtered.reverse();
  }
}

const DEFAULT_MEMORY_SCAN: [number, number] = [72, 168];
const MIN_SMART_ACCESS_SAMPLES = 5;
const HANDOFF_BOOST = 30;
const KEYWORD_HANDOFF_BOOST = 40;
const ANCHOR_ENTRY_BOOST_WINDOW = 15;
const MEMORY_ACCESS_SCORE = 10;
const PROJECT_FILE_ACCESS_SCORE = 20;
const MIN_KEYWORD_PROMPT_LENGTH = 10;
const MAX_KEYWORD_PROMPT_LENGTH = 300;
const DEFAULT_IGNORED_DIRS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".idea",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".svn",
  ".turbo",
  ".venv",
  ".vscode",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "temp",
  "tmp",
  "venv",
]);
const DEFAULT_IGNORED_FILES = new Set([
  ".DS_Store",
  "bun.lockb",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

// Keyword-triggered handoff.

function normalizeKeywordList(keywords?: string[]): string[] {
  if (!Array.isArray(keywords)) return [];

  return [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesKeyword(prompt: string, keyword: string): boolean {
  const pattern = `(^|[^\\p{L}\\p{N}_])${escapeRegex(keyword)}(?=$|[^\\p{L}\\p{N}_])`;
  return new RegExp(pattern, "iu").test(prompt);
}

function slugifyKeyword(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "detected";
}

export function normalizeTapeKeywords(config?: TapeKeywordConfig): TapeKeywordConfig {
  return {
    global: normalizeKeywordList(config?.global),
    project: normalizeKeywordList(config?.project),
  };
}

export type KeywordHandoffInstruction = {
  primary: string;
  matched: string[];
  anchorName: string;
  message: string;
};

export function detectKeywordHandoff(prompt: string, config?: TapeKeywordConfig): KeywordHandoffInstruction | null {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length < MIN_KEYWORD_PROMPT_LENGTH || normalizedPrompt.length > MAX_KEYWORD_PROMPT_LENGTH) {
    return null;
  }

  const keywords = [...normalizeKeywordList(config?.global), ...normalizeKeywordList(config?.project)];
  const matched = [...new Set(keywords.filter((keyword) => matchesKeyword(normalizedPrompt, keyword)))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );

  if (matched.length === 0) return null;

  const primary = matched[0];
  const anchorName = `handoff/keyword-${slugifyKeyword(primary)}-${formatTimeSuffix()}`;
  const message = [
    `Keyword detected: ${primary}.`,
    "",
    "Before continuing, call tape_handoff with:",
    `- name: "${anchorName}"`,
    "- summary: \"<brief intent summary of the user's current prompt in the user's language>\"",
    '- purpose: "<1-2 word label for the anchor\'s purpose>"',
    "",
    "Constraints:",
    "- Make the summary specific to the actual task.",
    "- Do not use a generic keyword-only summary.",
    "- Keep the summary under 18 words.",
    "",
    "Then continue the user's task normally.",
  ].join("\n");

  return { primary, matched, anchorName, message };
}

export function buildKeywordHandoffMessage(prompt: string, config?: TapeKeywordConfig): string | null {
  return detectKeywordHandoff(prompt, config)?.message ?? null;
}

function isInsideDirectory(parentDir: string, targetPath: string): boolean {
  const normalizedParent = path.resolve(parentDir);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget === normalizedParent || normalizedTarget.startsWith(`${normalizedParent}${path.sep}`);
}

export function matchesDefaultIgnoredPath(filePath: string, projectRoot?: string): boolean {
  const normalizedPath = path.resolve(filePath);
  const relativePath =
    projectRoot && isInsideDirectory(projectRoot, normalizedPath)
      ? path.relative(projectRoot, normalizedPath)
      : normalizedPath;
  const segments = relativePath.split(path.sep).filter(Boolean);
  const baseName = path.basename(normalizedPath);

  if (DEFAULT_IGNORED_FILES.has(baseName)) return true;
  if (baseName.startsWith(".")) return true;

  return segments.some((segment) => DEFAULT_IGNORED_DIRS.has(segment) || segment.startsWith("."));
}

function getRipgrepVisibleProjectPaths(projectRoot: string): Set<string> | null {
  const result = spawnSync("rg", ["--files"], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return null;
  }

  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((filePath) => path.resolve(projectRoot, filePath)),
  );
}

// Memory file selection.

type MemoryPathStats = {
  count: number;
  lastAccess: number;
  score: number;
  readCount: number;
  editCount: number;
  writeCount: number;
  memoryReadCount: number;
  memoryWriteCount: number;
};

type SupportedPathToolName = "memory_read" | "memory_write" | "read" | "edit" | "write";
type RangeToolName = "memory_read" | "read" | "edit";
type LineRange = {
  kind: "read" | "edit";
  start: number;
  end: number;
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

export class MemoryFileSelector {
  private readonly whitelist: string[];
  private readonly blacklist: string[];
  private lastSelectionScanHours: number | null = null;

  constructor(
    private tapeService: TapeService,
    private memoryDir: string,
    private projectRoot: string,
    options?: { whitelist?: string[]; blacklist?: string[] },
  ) {
    this.whitelist = [...new Set(options?.whitelist ?? [])];
    this.blacklist = [...new Set(options?.blacklist ?? [])];
  }

  selectFilesForContext(
    strategy: "recent-only" | "smart",
    limit: number,
    options?: { memoryScan?: [number, number] },
  ): string[] {
    if (strategy === "recent-only") {
      this.lastSelectionScanHours = null;
      return this.scanMemoryDirectory(limit);
    }

    return this.selectSmart(limit, options?.memoryScan ?? DEFAULT_MEMORY_SCAN);
  }

  finalizeContextFiles(filePaths: string[]): string[] {
    const selectedPaths = this.filterInjectedPaths(filePaths);
    const selectedPathSet = new Set(selectedPaths.map((filePath) => path.resolve(this.toAbsolutePath(filePath))));
    const whitelistedPaths = this.resolveListedPaths(this.whitelist).filter(
      (filePath) => !selectedPathSet.has(path.resolve(filePath)),
    );

    return [...whitelistedPaths, ...selectedPaths];
  }

  private selectSmart(limit: number, memoryScan: [number, number]): string[] {
    const [startHours, maxHours] = this.normalizeMemoryScan(memoryScan);
    let hours = startHours;
    let pathStats = new Map<string, MemoryPathStats>();
    let effectiveHours: number | null = null;

    while (hours <= maxHours) {
      const stats = this.analyzePathAccess(this.getEntriesWithinHours(hours), hours);
      if (stats.paths.size > 0) {
        pathStats = stats.paths;
        effectiveHours = hours;
        if (stats.totalAccesses >= MIN_SMART_ACCESS_SAMPLES) {
          break;
        }
      }
      hours += 24;
    }

    this.lastSelectionScanHours = effectiveHours;
    if (pathStats.size === 0) return this.scanMemoryDirectory(limit);

    return this.filterInjectedPaths(this.sortPathsByStats(pathStats)).slice(0, limit);
  }

  buildContextFromFiles(
    filePaths: string[],
    options?: { highlightedFiles?: string[]; lineRangeHours?: number },
  ): string {
    const existingPaths = [...new Set(filePaths.filter((filePath) => this.pathExists(filePath)))];
    if (existingPaths.length === 0) return "";

    const highlightedPaths = new Set(
      (options?.highlightedFiles ?? [])
        .filter((filePath) => this.pathExists(filePath))
        .map((filePath) => this.toMemoryRelativePath(filePath) ?? filePath),
    );
    const fileEntries = existingPaths.map((filePath) => {
      const absolutePath = path.resolve(this.toAbsolutePath(filePath));
      return {
        absolutePath,
        originalPath: filePath,
        displayPath: this.toMemoryRelativePath(filePath) ?? filePath,
      };
    });
    const rangeMap = this.collectRecentLineRanges(
      fileEntries.map((entry) => entry.originalPath),
      options?.lineRangeHours ?? this.lastSelectionScanHours,
    );
    const memoryEntries = fileEntries.filter((entry) => !path.isAbsolute(entry.displayPath));
    const projectEntries = fileEntries.filter((entry) => path.isAbsolute(entry.displayPath));
    const formatPathLabel = (filePath: string): string =>
      highlightedPaths.has(filePath) ? `${filePath} [high priority]` : filePath;
    const appendLineRanges = (targetLines: string[], absolutePath: string): void => {
      const lineRanges = rangeMap.get(absolutePath);
      if (!lineRanges || lineRanges.length === 0) return;
      targetLines.push(
        `  recent focus: ${lineRanges.map((range) => `${range.kind} ${range.start}-${range.end}`).join(", ")}`,
      );
    };
    const lines = ["# Project Memory", "", `Memory directory: ${this.memoryDir}`];

    if (memoryEntries.length > 0) {
      lines.push(
        "Paths below are relative to that directory.",
        "",
        "Available memory files (use memory_read to view full content):",
        "",
      );

      for (const entry of memoryEntries) {
        const { description, tags } = this.extractFrontmatter(entry.displayPath);
        lines.push(`- ${formatPathLabel(entry.displayPath)}`);
        appendLineRanges(lines, entry.absolutePath);
        lines.push(`  Description: ${description}`, `  Tags: ${tags}`, "");
      }
    }

    if (projectEntries.length > 0) {
      lines.push(
        ...(memoryEntries.length > 0 ? ["---", ""] : ["", ""]),
        "Recently active project files (full paths from read/edit/write tool usage):",
        "",
      );

      for (const entry of projectEntries) {
        lines.push(`- ${formatPathLabel(entry.displayPath)}`);
        appendLineRanges(lines, entry.absolutePath);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  private analyzePathAccess(
    entries: SessionEntry[],
    scanHours: number,
  ): { paths: Map<string, MemoryPathStats>; totalAccesses: number } {
    const pathStats = new Map<string, MemoryPathStats>();
    const recentHandoffAnchor = this.getLatestAnchor(scanHours, (anchor) => anchor.kind === "handoff");
    const recentKeywordHandoffAnchor = this.getLatestAnchor(
      scanHours,
      (anchor) => anchor.kind === "handoff" && anchor.meta?.trigger === "keyword",
    );
    const anchorWindows = [
      {
        timestamp: recentHandoffAnchor?.timestamp ?? null,
        windowEnd: this.getAnchorWindowEndTimestamp(recentHandoffAnchor, entries),
        boost: HANDOFF_BOOST,
      },
      {
        timestamp: recentKeywordHandoffAnchor?.timestamp ?? null,
        windowEnd: this.getAnchorWindowEndTimestamp(recentKeywordHandoffAnchor, entries),
        boost: KEYWORD_HANDOFF_BOOST,
      },
    ];
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

        const trackedPath = this.resolveTrackedPath(toolName, entryPath);
        if (!trackedPath || !this.pathExists(trackedPath)) continue;

        totalAccesses += 1;
        const stats = pathStats.get(trackedPath) ?? createEmptyMemoryPathStats();
        const multiplier = this.getDiminishingReturnsMultiplier(stats.count);
        const accessScore = this.getAccessScore(toolName);
        const boost = anchorWindows.reduce(
          (total, anchorWindow) =>
            total + this.getAnchorBoost(accessTime, anchorWindow.timestamp, anchorWindow.windowEnd, anchorWindow.boost),
          0,
        );

        stats.count += 1;
        stats.lastAccess = Math.max(stats.lastAccess, accessTime);
        stats.score += (accessScore + boost) * multiplier;
        this.recordToolAccess(stats, toolName);
        pathStats.set(trackedPath, stats);
      }
    }

    return { paths: pathStats, totalAccesses };
  }

  private sortPathsByStats(pathStats: Map<string, MemoryPathStats>): string[] {
    return Array.from(pathStats.entries())
      .sort(([, left], [, right]) => {
        const leftFinalScore = this.getFinalScore(left);
        const rightFinalScore = this.getFinalScore(right);

        return rightFinalScore - leftFinalScore || right.score - left.score || right.lastAccess - left.lastAccess;
      })
      .map(([memoryPath]) => memoryPath);
  }

  private resolveTrackedPath(toolName: SupportedPathToolName, entryPath: string): string | null {
    if (toolName === "memory_read" || toolName === "memory_write") {
      return entryPath;
    }

    if (toolName === "read" || toolName === "edit" || toolName === "write") {
      return resolveFrom(this.projectRoot, entryPath);
    }

    return null;
  }

  private getAccessScore(toolName: string): number {
    switch (toolName) {
      case "memory_write":
        return MEMORY_ACCESS_SCORE + 6;
      case "memory_read":
        return MEMORY_ACCESS_SCORE;
      case "write":
        return PROJECT_FILE_ACCESS_SCORE + 10;
      case "edit":
        return PROJECT_FILE_ACCESS_SCORE + 8;
      case "read":
        return PROJECT_FILE_ACCESS_SCORE;
      default:
        return 0;
    }
  }

  private getDiminishingReturnsMultiplier(count: number): number {
    if (count === 0) return 1;
    if (count === 1) return 0.6;
    if (count === 2) return 0.35;
    return 0.15;
  }

  private recordToolAccess(stats: MemoryPathStats, toolName: string): void {
    switch (toolName) {
      case "memory_read":
        stats.memoryReadCount += 1;
        return;
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

  private getFinalScore(stats: MemoryPathStats): number {
    const distinctToolKinds = [
      stats.memoryReadCount > 0,
      stats.memoryWriteCount > 0,
      stats.readCount > 0,
      stats.editCount > 0,
      stats.writeCount > 0,
    ].filter(Boolean).length;
    const recencyBonus = this.getRecencyBonus(stats.lastAccess);
    const repeatPenalty = Math.max(0, stats.count - distinctToolKinds) * 2;

    return stats.score + recencyBonus - repeatPenalty;
  }

  private getRecencyBonus(lastAccess: number): number {
    const hoursSinceLastAccess = Math.max(0, (Date.now() - lastAccess) / (1000 * 60 * 60));

    if (hoursSinceLastAccess <= 6) return 12;
    if (hoursSinceLastAccess <= 24) return 8;
    if (hoursSinceLastAccess <= 72) return 4;
    return 0;
  }

  private pathExists(filePath: string): boolean {
    const fullPath = this.toAbsolutePath(filePath);
    return fs.existsSync(fullPath);
  }

  private filterInjectedPaths(filePaths: string[]): string[] {
    const existingPaths = [...new Set(filePaths.filter((filePath) => this.pathExists(filePath)))];
    const projectPaths = existingPaths.filter(
      (filePath) => path.isAbsolute(filePath) && !this.toMemoryRelativePath(filePath),
    );
    const ripgrepVisiblePaths = projectPaths.some((filePath) => isInsideDirectory(this.projectRoot, filePath))
      ? getRipgrepVisibleProjectPaths(this.projectRoot)
      : new Set<string>();

    return existingPaths.filter((filePath) => {
      if (this.matchesListedPath(filePath, this.blacklist)) return false;
      if (this.matchesListedPath(filePath, this.whitelist)) return true;
      if (this.toMemoryRelativePath(filePath)) return true;
      if (matchesDefaultIgnoredPath(filePath, this.projectRoot)) return false;
      if (!isInsideDirectory(this.projectRoot, this.toAbsolutePath(filePath))) return true;
      return ripgrepVisiblePaths?.has(path.resolve(this.toAbsolutePath(filePath))) ?? true;
    });
  }

  private getEntriesWithinHours(hours: number): SessionEntry[] {
    const since = hoursAgoIso(hours);
    return this.tapeService.query({ since, scope: "project", anchorScope: "project" });
  }

  private getLatestAnchor(
    scanHours: number,
    match: (anchor: { kind: string; meta?: { trigger?: string } }) => boolean,
  ) {
    const since = hoursAgoIso(scanHours);
    const anchors = this.tapeService.getAnchorStore().search({ since, limit: Number.MAX_SAFE_INTEGER }).filter(match);
    return anchors[anchors.length - 1] ?? null;
  }

  private getAnchorWindowEndTimestamp(anchor: { timestamp: string } | null, entries: SessionEntry[]): number | null {
    if (!anchor) return null;

    const anchorTimestamp = toTimestamp(anchor.timestamp);
    const windowEntries = entries
      .filter((entry) => toTimestamp(entry.timestamp) >= anchorTimestamp)
      .slice(0, ANCHOR_ENTRY_BOOST_WINDOW);

    if (windowEntries.length === 0) return null;

    return toTimestamp(windowEntries[windowEntries.length - 1].timestamp);
  }

  private getAnchorBoost(
    accessTime: number,
    anchorTimestamp: string | null,
    windowEndTimestamp: number | null,
    baseBoost: number,
  ): number {
    if (!anchorTimestamp || windowEndTimestamp === null) return 0;

    const anchorTime = toTimestamp(anchorTimestamp);
    if (accessTime < anchorTime || accessTime > windowEndTimestamp) return 0;

    const hoursSinceAnchor = (accessTime - anchorTime) / (1000 * 60 * 60);

    if (hoursSinceAnchor <= 6) return baseBoost;
    if (hoursSinceAnchor <= 24) return baseBoost * 0.6;
    if (hoursSinceAnchor <= 72) return baseBoost * 0.3;
    return 0;
  }

  private normalizeMemoryScan(memoryScan: [number, number]): [number, number] {
    const [startHours, maxHours] = memoryScan;
    const normalizedStart =
      Number.isFinite(startHours) && startHours > 0 ? Math.floor(startHours) : DEFAULT_MEMORY_SCAN[0];
    const normalizedMax = Number.isFinite(maxHours) && maxHours > 0 ? Math.floor(maxHours) : DEFAULT_MEMORY_SCAN[1];
    return [normalizedStart, Math.max(normalizedStart, normalizedMax)];
  }

  private collectRecentLineRanges(filePaths: string[], scanHours?: number | null): Map<string, LineRange[]> {
    if (!scanHours || scanHours <= 0) return new Map();

    const targetPaths = new Set(filePaths.map((filePath) => path.resolve(this.toAbsolutePath(filePath))));
    const pendingEditPaths = new Map<string, string>();
    const rangeMap = new Map<string, LineRange[]>();
    const entries = this.getEntriesWithinHours(scanHours);

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
          const trackedPath = entryPath ? this.resolveTrackedPath(toolName, entryPath) : null;
          if (!trackedPath) continue;

          const resolvedPath = path.resolve(this.toAbsolutePath(trackedPath));
          if (!targetPaths.has(resolvedPath)) continue;

          if (toolName === "read" || toolName === "memory_read") {
            const range = this.createReadRange(block.arguments?.offset, block.arguments?.limit);
            if (range) this.pushLineRange(rangeMap, resolvedPath, range);
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

      for (const range of this.extractEditRanges(messageEntry.message.details)) {
        this.pushLineRange(rangeMap, trackedPath, range);
      }
      pendingEditPaths.delete(toolCallId!);
    }

    for (const [filePath, ranges] of rangeMap) {
      rangeMap.set(filePath, this.mergeLineRanges(ranges).slice(0, 5));
    }

    return rangeMap;
  }

  private createReadRange(offset: number | undefined, limit: number | undefined): LineRange | null {
    const start = Number.isFinite(offset) && (offset ?? 0) > 0 ? Math.floor(offset!) : 1;
    if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return null;
    return { kind: "read", start, end: start + Math.floor(limit!) - 1 };
  }

  private extractEditRanges(details: { firstChangedLine?: number; diff?: string } | undefined): LineRange[] {
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

  private pushLineRange(rangeMap: Map<string, LineRange[]>, filePath: string, range: LineRange): void {
    const ranges = rangeMap.get(filePath) ?? [];
    ranges.push(range);
    rangeMap.set(filePath, ranges);
  }

  private mergeLineRanges(ranges: LineRange[]): LineRange[] {
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

  private scanMemoryDirectory(limit: number): string[] {
    const coreDir = path.join(this.memoryDir, "core");
    if (!fs.existsSync(coreDir)) return [];

    const paths: Array<{ relPath: string; modifiedAt: number }> = [];

    const scanDir = (dir: string, base: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(base, entry.name);

        if (entry.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          paths.push({ relPath, modifiedAt: fs.statSync(fullPath).mtimeMs });
        }
      }
    };

    scanDir(coreDir, "core");

    return paths
      .sort((left, right) => right.modifiedAt - left.modifiedAt || left.relPath.localeCompare(right.relPath))
      .slice(0, limit)
      .map(({ relPath }) => relPath);
  }

  private extractFrontmatter(relPath: string): { description: string; tags: string } {
    const fullPath = path.join(this.memoryDir, relPath);

    try {
      const { data } = matter.read(fullPath);
      return {
        description: (data.description as string)?.trim() || "No description",
        tags: Array.isArray(data.tags) && data.tags.length > 0 ? data.tags.join(", ") : "none",
      };
    } catch {
      return { description: "No description", tags: "none" };
    }
  }

  private toAbsolutePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;

    const memoryPath = path.join(this.memoryDir, filePath);
    if (fs.existsSync(memoryPath)) return memoryPath;

    return path.resolve(this.projectRoot, filePath);
  }

  private resolveListedPaths(entries: string[]): string[] {
    const resolvedPaths = new Set<string>();

    const collectFiles = (targetPath: string): void => {
      if (!fs.existsSync(targetPath)) return;

      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        resolvedPaths.add(targetPath);
        return;
      }

      if (!stat.isDirectory()) return;

      for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
        collectFiles(path.join(targetPath, entry.name));
      }
    };

    for (const entry of entries) {
      const absoluteEntry = path.isAbsolute(entry) ? path.resolve(entry) : null;
      const candidatePaths = absoluteEntry
        ? [absoluteEntry]
        : [path.resolve(this.memoryDir, entry), path.resolve(this.projectRoot, entry)];

      for (const candidatePath of candidatePaths) {
        collectFiles(candidatePath);
      }
    }

    return [...resolvedPaths];
  }

  private matchesListedPath(filePath: string, entries: string[]): boolean {
    const absolutePath = path.resolve(this.toAbsolutePath(filePath));

    return entries.some((entry) => {
      const candidates = path.isAbsolute(entry)
        ? [path.resolve(entry)]
        : [path.resolve(this.memoryDir, entry), path.resolve(this.projectRoot, entry)];

      return candidates.some(
        (candidate) => absolutePath === candidate || absolutePath.startsWith(`${candidate}${path.sep}`),
      );
    });
  }

  private toMemoryRelativePath(filePath: string): string | null {
    const normalizedPath = toRelativeIfInside(this.memoryDir, this.toAbsolutePath(filePath));
    return path.isAbsolute(normalizedPath) ? null : normalizedPath;
  }
}
