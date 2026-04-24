import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import matter from "gray-matter";
import { hoursAgoIso, resolveFrom, toRelativeIfInside, toTimestamp } from "../utils.js";
import {
  analyzePathAccess,
  analyzeRecentLineRanges,
  type LineRange,
  type MemoryPathStats,
  type SupportedPathToolName,
  sortPathsByStats,
} from "./tape-analyze.js";
import type { TapeService } from "./tape-service.js";

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
const ANCHOR_ENTRY_BOOST_WINDOW = 15;
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

export class MemoryFileSelector {
  private readonly whitelist: string[];
  private readonly blacklist: string[];
  private lastSelectionScanHours: number | null = null;
  private lastSmartLineRanges = new Map<string, LineRange[]>();

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
      this.lastSmartLineRanges = new Map();
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
      const stats = analyzePathAccess(this.getEntriesWithinHours(hours), {
        scanHours: hours,
        resolveTrackedPath: (toolName, entryPath) => this.resolveTrackedPath(toolName, entryPath),
        pathExists: (filePath) => this.pathExists(filePath),
        getLatestAnchor: (scanHours, match) => this.getLatestAnchor(scanHours, match),
        getAnchorWindowEndTimestamp: (anchor, entries) => this.getAnchorWindowEndTimestamp(anchor, entries),
      });
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
    if (pathStats.size === 0) {
      this.lastSmartLineRanges = new Map();
      return this.scanMemoryDirectory(limit);
    }

    const selectedPaths = this.filterInjectedPaths(sortPathsByStats(pathStats)).slice(0, limit);
    this.lastSmartLineRanges = effectiveHours
      ? analyzeRecentLineRanges(this.getEntriesWithinHours(effectiveHours), {
          targetPaths: selectedPaths,
          resolveTrackedPath: (toolName, entryPath) => this.resolveTrackedPath(toolName, entryPath),
          toAbsolutePath: (filePath) => this.toAbsolutePath(filePath),
        })
      : new Map();

    return selectedPaths;
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
    const lineRangeHours = options?.lineRangeHours ?? this.lastSelectionScanHours;
    const rangeMap =
      options?.lineRangeHours === undefined && lineRangeHours === this.lastSelectionScanHours
        ? this.lastSmartLineRanges
        : lineRangeHours
          ? analyzeRecentLineRanges(this.getEntriesWithinHours(lineRangeHours), {
              targetPaths: fileEntries.map((entry) => entry.originalPath),
              resolveTrackedPath: (toolName, entryPath) => this.resolveTrackedPath(toolName, entryPath),
              toAbsolutePath: (filePath) => this.toAbsolutePath(filePath),
            })
          : new Map();
    const memoryEntries = fileEntries.filter((entry) => !path.isAbsolute(entry.displayPath));
    const projectEntries = fileEntries.filter((entry) => path.isAbsolute(entry.displayPath));
    const formatPathLabel = (filePath: string): string =>
      highlightedPaths.has(filePath) ? `${filePath} [high priority]` : filePath;
    const appendLineRanges = (targetLines: string[], absolutePath: string): void => {
      const lineRanges = rangeMap.get(absolutePath);
      if (!lineRanges || lineRanges.length === 0) return;
      targetLines.push(
        `  recent focus: ${lineRanges.map((range: LineRange) => `${range.kind} ${range.start}-${range.end}`).join(", ")}`,
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

  private resolveTrackedPath(toolName: SupportedPathToolName, entryPath: string): string | null {
    if (toolName === "memory_read" || toolName === "memory_write") {
      return entryPath;
    }

    if (toolName === "read" || toolName === "edit" || toolName === "write") {
      return resolveFrom(this.projectRoot, entryPath);
    }

    return null;
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

  private normalizeMemoryScan(memoryScan: [number, number]): [number, number] {
    const [startHours, maxHours] = memoryScan;
    const normalizedStart =
      Number.isFinite(startHours) && startHours > 0 ? Math.floor(startHours) : DEFAULT_MEMORY_SCAN[0];
    const normalizedMax = Number.isFinite(maxHours) && maxHours > 0 ? Math.floor(maxHours) : DEFAULT_MEMORY_SCAN[1];
    return [normalizedStart, Math.max(normalizedStart, normalizedMax)];
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
