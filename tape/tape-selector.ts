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
      if (totalTokens + tokens > this.maxTokens) break;

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
    '- trigger: "keyword"',
    `- keywords: ${JSON.stringify(matched)}`,
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

export class MemoryFileSelector {
  constructor(
    private tapeService: TapeService,
    private memoryDir: string,
    private projectRoot: string,
  ) {}

  selectFilesForContext(
    strategy: "recent-only" | "smart",
    limit: number,
    options?: { memoryScan?: [number, number] },
  ): string[] {
    if (strategy === "recent-only") {
      return this.scanMemoryDirectory(limit);
    }

    return this.selectSmart(limit, options?.memoryScan ?? DEFAULT_MEMORY_SCAN);
  }

  private selectSmart(limit: number, memoryScan: [number, number]): string[] {
    const [startHours, maxHours] = this.normalizeMemoryScan(memoryScan);
    let hours = startHours;
    let pathStats = new Map<string, MemoryPathStats>();

    while (hours <= maxHours) {
      const stats = this.analyzePathAccess(this.getEntriesWithinHours(hours), hours);
      if (stats.paths.size > 0) {
        pathStats = stats.paths;
        if (stats.totalAccesses >= MIN_SMART_ACCESS_SAMPLES) {
          break;
        }
      }
      hours += 24;
    }

    if (pathStats.size === 0) return this.scanMemoryDirectory(limit);

    return this.sortPathsByStats(pathStats).slice(0, limit);
  }

  buildContextFromFiles(filePaths: string[], options?: { highlightedFiles?: string[] }): string {
    const existingPaths = filePaths.filter((filePath) => this.pathExists(filePath));
    if (existingPaths.length === 0) return "";

    const highlightedPaths = new Set((options?.highlightedFiles ?? []).filter((filePath) => this.pathExists(filePath)));
    const formatPathLabel = (filePath: string): string =>
      highlightedPaths.has(filePath) ? `${filePath} [high priority]` : filePath;

    const memoryPaths = existingPaths.filter((filePath) => !path.isAbsolute(filePath));
    const projectPaths = existingPaths.filter((filePath) => path.isAbsolute(filePath));
    const lines = ["# Project Memory", "", `Memory directory: ${this.memoryDir}`];

    if (memoryPaths.length > 0) {
      lines.push(
        "Paths below are relative to that directory.",
        "",
        "Available memory files (use memory_read to view full content):",
        "",
      );

      for (const relPath of memoryPaths) {
        const { description, tags } = this.extractFrontmatter(relPath);
        lines.push(`- ${formatPathLabel(relPath)}`, `  Description: ${description}`, `  Tags: ${tags}`, "");
      }
    }

    if (projectPaths.length > 0) {
      lines.push(
        ...(memoryPaths.length > 0 ? ["---", ""] : ["", ""]),
        "Recently active project files (full paths from read/edit/write tool usage):",
        "",
      );

      for (const fullPath of projectPaths) {
        lines.push(`- ${formatPathLabel(fullPath)}`);
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
    const handoffAnchor = this.getLatestHandoffAnchor(scanHours);
    const keywordHandoffAnchor = this.getLatestKeywordHandoffAnchor(scanHours);
    const handoffWindowEnd = this.getAnchorWindowEndTimestamp(handoffAnchor, entries);
    const keywordHandoffWindowEnd = this.getAnchorWindowEndTimestamp(keywordHandoffAnchor, entries);
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
        if (!entryPath) continue;

        let trackedPath: string | null = null;

        if (block.name === "memory_read" || block.name === "memory_write") {
          trackedPath = entryPath;
        } else if (block.name === "read" || block.name === "edit" || block.name === "write") {
          const fullPath = resolveFrom(this.projectRoot, entryPath);
          trackedPath = toRelativeIfInside(this.memoryDir, fullPath);
        }

        if (!trackedPath || !this.pathExists(trackedPath)) continue;

        totalAccesses += 1;
        const stats = pathStats.get(trackedPath) ?? {
          count: 0,
          lastAccess: 0,
          score: 0,
          readCount: 0,
          editCount: 0,
          writeCount: 0,
          memoryReadCount: 0,
          memoryWriteCount: 0,
        };
        const multiplier = this.getDiminishingReturnsMultiplier(stats.count);
        const accessScore = this.getAccessScore(block.name);
        const boost =
          this.getAnchorBoost(accessTime, handoffAnchor?.timestamp ?? null, handoffWindowEnd, HANDOFF_BOOST) +
          this.getAnchorBoost(
            accessTime,
            keywordHandoffAnchor?.timestamp ?? null,
            keywordHandoffWindowEnd,
            KEYWORD_HANDOFF_BOOST,
          );

        stats.count += 1;
        stats.lastAccess = Math.max(stats.lastAccess, accessTime);
        stats.score += (accessScore + boost) * multiplier;
        this.recordToolAccess(stats, block.name);
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
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.memoryDir, filePath);
    return fs.existsSync(fullPath);
  }

  private getEntriesWithinHours(hours: number): SessionEntry[] {
    const since = hoursAgoIso(hours);
    return this.tapeService.query({ since, scope: "project", anchorScope: "project" });
  }

  private getLatestHandoffAnchor(scanHours: number) {
    const since = hoursAgoIso(scanHours);
    const anchors = this.tapeService
      .getAnchorStore()
      .search({ since, limit: Number.MAX_SAFE_INTEGER })
      .filter((anchor) => anchor.kind === "handoff");
    return anchors[anchors.length - 1] ?? null;
  }

  private getLatestKeywordHandoffAnchor(scanHours: number) {
    const since = hoursAgoIso(scanHours);
    const anchors = this.tapeService
      .getAnchorStore()
      .search({ since, limit: Number.MAX_SAFE_INTEGER })
      .filter((anchor) => anchor.kind === "handoff" && anchor.meta?.trigger === "keyword");
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
}
