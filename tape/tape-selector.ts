import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import matter from "gray-matter";
import { DEFAULT_MEMORY_SCAN, normalizeMemoryScanRange } from "../memory-core.js";
import { getProjectMeta, hoursAgoIso, isPathInside, resolveFrom, toRelativeIfInside, toTimestamp } from "../utils.js";
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
const execFileAsync = promisify(execFile);

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

export function matchesDefaultIgnoredPath(filePath: string, projectRoot?: string): boolean {
  const normalizedPath = path.resolve(filePath);
  let relativePath = normalizedPath;

  if (projectRoot && isPathInside(projectRoot, normalizedPath)) {
    relativePath = path.relative(projectRoot, normalizedPath);
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  const baseName = path.basename(normalizedPath);

  if (DEFAULT_IGNORED_FILES.has(baseName)) return true;
  if (baseName.startsWith(".")) return true;

  return segments.some((segment) => DEFAULT_IGNORED_DIRS.has(segment) || segment.startsWith("."));
}

async function getRipgrepVisibleProjectPaths(projectRoot: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("rg", ["--files"], {
      cwd: projectRoot,
      encoding: "utf-8",
      windowsHide: true,
    });

    return new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((filePath) => path.resolve(projectRoot, filePath)),
    );
  } catch {
    return null;
  }
}

// Memory file selection.

export class MemoryFileSelector {
  private readonly whitelist: string[];
  private readonly blacklist: string[];
  private readonly isWorktree: boolean;
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
    this.isWorktree = getProjectMeta(projectRoot).isWorktree;
  }

  async selectFilesForContext(
    strategy: "recent-only" | "smart",
    limit: number,
    options?: { memoryScan?: [number, number] },
  ): Promise<string[]> {
    if (strategy === "recent-only") {
      this.lastSelectionScanHours = null;
      this.lastSmartLineRanges = new Map();
      return this.scanMemoryDirectoryAsync(limit);
    }

    return this.selectSmartAsync(limit, options?.memoryScan ?? DEFAULT_MEMORY_SCAN);
  }

  async finalizeContextFiles(filePaths: string[]): Promise<string[]> {
    const selectedPaths = await this.filterDeliverablePathsAsync(filePaths);
    const selectedPathSet = new Set(selectedPaths.map((filePath) => path.resolve(this.toAbsolutePath(filePath))));
    const whitelistedPaths = (await this.resolveListedPathsAsync(this.whitelist)).filter(
      (filePath) => !selectedPathSet.has(path.resolve(filePath)),
    );

    return [...whitelistedPaths, ...selectedPaths];
  }

  private async selectSmartAsync(limit: number, memoryScan: [number, number]): Promise<string[]> {
    const [startHours, maxHours] = normalizeMemoryScanRange(memoryScan);
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
      // Worktrees have no access history in their own tape sessions, skip fallback
      if (this.isWorktree) {
        return [];
      }
      return this.scanMemoryDirectoryAsync(limit);
    }

    const selectedPaths = (await this.filterDeliverablePathsAsync(sortPathsByStats(pathStats))).slice(0, limit);
    this.lastSmartLineRanges = effectiveHours
      ? analyzeRecentLineRanges(this.getEntriesWithinHours(effectiveHours), {
          targetPaths: selectedPaths,
          resolveTrackedPath: (toolName, entryPath) => this.resolveTrackedPath(toolName, entryPath),
          toAbsolutePath: (filePath) => this.toAbsolutePath(filePath),
        })
      : new Map();

    return selectedPaths;
  }

  async buildContextFromFilesAsync(
    filePaths: string[],
    options?: { highlightedFiles?: string[]; lineRangeHours?: number },
  ): Promise<string> {
    const { fileEntries, highlightedPaths, rangeMap } = this.prepareContextEntries(filePaths, options);
    if (fileEntries.length === 0) return "";
    return this.renderContextFromEntriesAsync(fileEntries, highlightedPaths, rangeMap);
  }

  private prepareContextEntries(
    filePaths: string[],
    options?: { highlightedFiles?: string[]; lineRangeHours?: number },
  ): {
    fileEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>;
    highlightedPaths: Set<string>;
    rangeMap: Map<string, LineRange[]>;
  } {
    const existingPaths = [...new Set(filePaths.filter((filePath) => this.pathExists(filePath)))];
    const highlightedPaths = new Set(
      (options?.highlightedFiles ?? [])
        .filter((filePath) => this.pathExists(filePath))
        .map((filePath) => this.toMemoryRelativePath(filePath) ?? filePath),
    );
    const fileEntries = existingPaths.map((filePath) => ({
      absolutePath: path.resolve(this.toAbsolutePath(filePath)),
      originalPath: filePath,
      displayPath: this.toMemoryRelativePath(filePath) ?? filePath,
    }));
    const rangeMap = this.getContextRangeMap(fileEntries, options?.lineRangeHours);

    return { fileEntries, highlightedPaths, rangeMap };
  }

  private getContextRangeMap(
    fileEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>,
    requestedHours?: number,
  ): Map<string, LineRange[]> {
    const lineRangeHours = requestedHours ?? this.lastSelectionScanHours;
    const shouldReuseLastScan = requestedHours === undefined && lineRangeHours === this.lastSelectionScanHours;

    if (shouldReuseLastScan) {
      return this.lastSmartLineRanges;
    }

    if (!lineRangeHours) {
      return new Map<string, LineRange[]>();
    }

    return analyzeRecentLineRanges(this.getEntriesWithinHours(lineRangeHours), {
      targetPaths: fileEntries.map((entry) => entry.originalPath),
      resolveTrackedPath: (toolName, entryPath) => this.resolveTrackedPath(toolName, entryPath),
      toAbsolutePath: (filePath) => this.toAbsolutePath(filePath),
    });
  }

  private async renderContextFromEntriesAsync(
    fileEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>,
    highlightedPaths: Set<string>,
    rangeMap: Map<string, LineRange[]>,
  ): Promise<string> {
    const lines = this.createContextHeader();
    const { memoryEntries, projectEntries } = this.splitContextEntries(fileEntries);

    if (memoryEntries.length > 0) {
      const frontmatters = await Promise.all(
        memoryEntries.map((entry) => this.extractFrontmatterAsync(entry.displayPath)),
      );
      for (let index = 0; index < memoryEntries.length; index++) {
        const entry = memoryEntries[index];
        const frontmatter = frontmatters[index];
        if (!entry || !frontmatter) continue;
        this.appendMemoryEntry(lines, entry, highlightedPaths, rangeMap, frontmatter);
      }
    }

    this.appendProjectEntries(lines, projectEntries, highlightedPaths, rangeMap, memoryEntries.length > 0);
    return lines.join("\n");
  }

  private createContextHeader(): string[] {
    return [
      "# Project Memory",
      "",
      `Memory directory: ${this.memoryDir}`,
      "Paths below are relative to that directory.",
      "",
      "Recent memory files:",
      "",
    ];
  }

  private splitContextEntries(
    fileEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>,
  ): {
    memoryEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>;
    projectEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>;
  } {
    return {
      memoryEntries: fileEntries.filter((entry) => !path.isAbsolute(entry.displayPath)),
      projectEntries: fileEntries.filter((entry) => path.isAbsolute(entry.displayPath)),
    };
  }

  private appendMemoryEntry(
    lines: string[],
    entry: { absolutePath: string; originalPath: string; displayPath: string },
    highlightedPaths: Set<string>,
    rangeMap: Map<string, LineRange[]>,
    frontmatter: { description: string; tags: string },
  ): void {
    lines.push(`- ${this.formatPathLabel(entry.displayPath, highlightedPaths)}`);
    this.appendLineRanges(lines, entry.absolutePath, rangeMap);
    lines.push(`  Description: ${frontmatter.description}`, `  Tags: ${frontmatter.tags}`, "");
  }

  private appendProjectEntries(
    lines: string[],
    projectEntries: Array<{ absolutePath: string; originalPath: string; displayPath: string }>,
    highlightedPaths: Set<string>,
    rangeMap: Map<string, LineRange[]>,
    hasMemoryEntries: boolean,
  ): void {
    if (projectEntries.length === 0) {
      return;
    }

    if (hasMemoryEntries) {
      lines.push("---", "");
    } else {
      lines.push("", "");
    }

    lines.push("Recently active project files (full paths from read/edit/write tool usage):", "");

    for (const entry of projectEntries) {
      lines.push(`- ${this.formatPathLabel(entry.displayPath, highlightedPaths)}`);
      this.appendLineRanges(lines, entry.absolutePath, rangeMap);
    }

    lines.push("");
  }

  private formatPathLabel(filePath: string, highlightedPaths: Set<string>): string {
    return highlightedPaths.has(filePath) ? `${filePath} [high priority]` : filePath;
  }

  private appendLineRanges(lines: string[], absolutePath: string, rangeMap: Map<string, LineRange[]>): void {
    const lineRanges = rangeMap.get(absolutePath);
    if (!lineRanges || lineRanges.length === 0) {
      return;
    }

    lines.push(
      `  recent focus: ${lineRanges.map((range: LineRange) => `${range.kind} ${range.start}-${range.end}`).join(", ")}`,
    );
  }

  private resolveTrackedPath(toolName: SupportedPathToolName, entryPath: string): string | null {
    if (toolName === "memory_write") {
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

  private async filterDeliverablePathsAsync(filePaths: string[]): Promise<string[]> {
    const existingPaths = [...new Set(filePaths.filter((filePath) => this.pathExists(filePath)))];
    const projectPaths = existingPaths.filter(
      (filePath) => path.isAbsolute(filePath) && !this.toMemoryRelativePath(filePath),
    );
    const ripgrepVisiblePaths = projectPaths.some((filePath) => isPathInside(this.projectRoot, filePath))
      ? await getRipgrepVisibleProjectPaths(this.projectRoot)
      : new Set<string>();

    return existingPaths.filter((filePath) => {
      if (this.matchesListedPath(filePath, this.blacklist)) return false;
      if (this.matchesListedPath(filePath, this.whitelist)) return true;
      if (this.toMemoryRelativePath(filePath)) return true;
      if (matchesDefaultIgnoredPath(filePath, this.projectRoot)) return false;
      if (!isPathInside(this.projectRoot, this.toAbsolutePath(filePath))) return true;
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

  private async scanMemoryDirectoryAsync(limit: number): Promise<string[]> {
    const coreDir = path.join(this.memoryDir, "core");

    try {
      await fs.promises.access(coreDir);
    } catch {
      return [];
    }

    const paths: Array<{ relPath: string; modifiedAt: number }> = [];

    const scanDir = async (dir: string, base: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      await Promise.all(
        entries.map(async (entry) => {
          if (entry.name.startsWith(".")) return;

          const fullPath = path.join(dir, entry.name);
          const relPath = path.join(base, entry.name);

          if (entry.isDirectory()) {
            await scanDir(fullPath, relPath);
            return;
          }

          if (entry.isFile() && entry.name.endsWith(".md")) {
            const stat = await fs.promises.stat(fullPath);
            paths.push({ relPath, modifiedAt: stat.mtimeMs });
          }
        }),
      );
    };

    await scanDir(coreDir, "core");

    return paths
      .sort((left, right) => right.modifiedAt - left.modifiedAt || left.relPath.localeCompare(right.relPath))
      .slice(0, limit)
      .map(({ relPath }) => relPath);
  }

  private parseFrontmatter(content: string): { description: string; tags: string } {
    const { data } = matter(content);
    return {
      description: (data.description as string)?.trim() || "No description",
      tags: Array.isArray(data.tags) && data.tags.length > 0 ? data.tags.join(", ") : "none",
    };
  }

  private async extractFrontmatterAsync(relPath: string): Promise<{ description: string; tags: string }> {
    const fullPath = path.join(this.memoryDir, relPath);

    try {
      return this.parseFrontmatter(await fs.promises.readFile(fullPath, "utf-8"));
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

  private async resolveListedPathsAsync(entries: string[]): Promise<string[]> {
    const resolvedPaths = new Set<string>();

    const collectFiles = async (targetPath: string): Promise<void> => {
      try {
        const stat = await fs.promises.stat(targetPath);
        if (stat.isFile()) {
          resolvedPaths.add(targetPath);
          return;
        }

        if (!stat.isDirectory()) return;

        const childEntries = await fs.promises.readdir(targetPath, { withFileTypes: true });
        await Promise.all(childEntries.map((entry) => collectFiles(path.join(targetPath, entry.name))));
      } catch {}
    };

    for (const entry of entries) {
      const absoluteEntry = path.isAbsolute(entry) ? path.resolve(entry) : null;
      const candidatePaths = absoluteEntry
        ? [absoluteEntry]
        : [path.resolve(this.memoryDir, entry), path.resolve(this.projectRoot, entry)];

      await Promise.all(candidatePaths.map((candidatePath) => collectFiles(candidatePath)));
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
