import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import matter from "gray-matter";
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
    case "custom":
    case "custom_message": {
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
    case "custom_message":
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
const MEMORY_ACCESS_SCORE = 10;
const PROJECT_FILE_ACCESS_SCORE = 20;

type MemoryPathStats = {
  count: number;
  lastAccess: number;
  score: number;
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
    const startStats = this.analyzePathAccess(this.getEntriesWithinHours(startHours), startHours);

    let pathStats = startStats.paths;
    if (startStats.totalAccesses < MIN_SMART_ACCESS_SAMPLES && startHours !== maxHours) {
      pathStats = this.analyzePathAccess(this.getEntriesWithinHours(maxHours), maxHours).paths;
    }

    if (pathStats.size === 0) return this.scanMemoryDirectory(limit);

    return this.sortPathsByStats(pathStats).slice(0, limit);
  }

  buildContextFromFiles(filePaths: string[]): string {
    if (filePaths.length === 0) return "";

    const memoryPaths = filePaths.filter((filePath) => !path.isAbsolute(filePath));
    const projectPaths = filePaths.filter((filePath) => path.isAbsolute(filePath));
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
        lines.push(`- ${relPath}`, `  Description: ${description}`, `  Tags: ${tags}`, "");
      }
    }

    if (projectPaths.length > 0) {
      lines.push(
        ...(memoryPaths.length > 0 ? ["---", ""] : ["", ""]),
        "Recently active project files (full paths from read/edit/write tool usage):",
        "",
      );

      for (const fullPath of projectPaths) {
        lines.push(`- ${fullPath}`);
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
    const handoffTimestamp = this.getLatestManualAnchorTimestamp(scanHours);
    let totalAccesses = 0;

    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const messageEntry = entry as SessionMessageEntry;
      if (messageEntry.message.role !== "assistant") continue;
      if (!Array.isArray(messageEntry.message.content)) continue;

      const accessTime = new Date(entry.timestamp).getTime();
      for (const block of messageEntry.message.content) {
        if (block.type !== "toolCall") continue;

        const entryPath = block.arguments.path as string | undefined;
        if (!entryPath) continue;

        let trackedPath: string | null = null;
        let accessScore = 0;

        if (block.name === "memory_read" || block.name === "memory_write") {
          trackedPath = entryPath;
          accessScore = MEMORY_ACCESS_SCORE;
        } else if (block.name === "read" || block.name === "edit" || block.name === "write") {
          const fullPath = path.isAbsolute(entryPath) ? entryPath : path.resolve(this.projectRoot, entryPath);
          trackedPath = fullPath.startsWith(`${this.memoryDir}${path.sep}`)
            ? path.relative(this.memoryDir, fullPath)
            : fullPath;
          accessScore = PROJECT_FILE_ACCESS_SCORE;
        }

        if (!trackedPath) continue;

        totalAccesses += 1;
        const stats = pathStats.get(trackedPath) ?? { count: 0, lastAccess: 0, score: 0 };
        stats.count += 1;
        stats.lastAccess = Math.max(stats.lastAccess, accessTime);
        stats.score += accessScore;
        if (handoffTimestamp !== null && accessTime >= handoffTimestamp) {
          stats.score += HANDOFF_BOOST;
        }
        pathStats.set(trackedPath, stats);
      }
    }

    return { paths: pathStats, totalAccesses };
  }

  private sortPathsByStats(pathStats: Map<string, MemoryPathStats>): string[] {
    return Array.from(pathStats.entries())
      .sort(
        ([, left], [, right]) =>
          right.score - left.score || right.count - left.count || right.lastAccess - left.lastAccess,
      )
      .map(([memoryPath]) => memoryPath);
  }

  private getEntriesWithinHours(hours: number): SessionEntry[] {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.tapeService.query({ since, scope: "project", anchorScope: "project" });
  }

  private getLatestManualAnchorTimestamp(scanHours: number): number | null {
    const since = new Date(Date.now() - scanHours * 60 * 60 * 1000).toISOString();
    const anchors = this.tapeService
      .getAnchorStore()
      .search({ since, limit: Number.MAX_SAFE_INTEGER })
      .filter((anchor) => !anchor.name.startsWith("auto/") && !anchor.name.startsWith("session/"));
    const lastAnchor = anchors[anchors.length - 1];
    return lastAnchor ? new Date(lastAnchor.timestamp).getTime() : null;
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
