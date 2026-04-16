import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import matter from "gray-matter";
import type { MemoryTapeService } from "./tape-service.js";

const CHARS_PER_TOKEN = 4;

export interface TapeMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export function extractMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c as { text?: string }).text || "").join("");
  return "";
}

function entryToMessage(entry: SessionEntry): TapeMessage | null {
  switch (entry.type) {
    case "message": {
      const msg = entry as { message: { role: string; content?: unknown } };
      return {
        role: msg.message.role === "user" ? "user" : "assistant",
        content: extractMessageContent(msg.message.content),
      };
    }
    case "custom":
    case "custom_message": {
      const c = entry as { customType?: string; data?: unknown };
      return {
        role: "assistant",
        content: `[${c.customType?.split("/").pop() ?? "custom"}] ${c.data ? JSON.stringify(c.data, null, 2) : ""}`,
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
  return entries.map(entryToMessage).filter((msg): msg is TapeMessage => msg !== null);
}

function formatEntryLine(entry: SessionEntry): string | null {
  switch (entry.type) {
    case "message": {
      const msg = entry as { message: { role: string; content?: unknown } };
      const content = extractMessageContent(msg.message.content);
      const truncated = content.length > 80 ? `${content.substring(0, 80)}...` : content;
      return `${msg.message.role === "user" ? "User" : "Assistant"}: ${truncated}`;
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
    private tapeService: MemoryTapeService,
    private maxTokens = 1000,
    private maxEntries = 40,
  ) {}

  selectFromAnchor(anchorId?: string): SessionEntry[] {
    const entries = this.tapeService.query({ sinceAnchor: anchorId }).slice(-this.maxEntries);
    return this.filterByTokenBudget(entries);
  }

  buildFormattedContext(entries: SessionEntry[]): string {
    const lines = entries.map(formatEntryLine).filter((line): line is string => line !== null);
    return lines.length > 0 ? `${lines.join("\n")}\n\n---\n` : "";
  }

  private filterByTokenBudget(entries: SessionEntry[]): SessionEntry[] {
    let totalTokens = 0;
    const filtered: SessionEntry[] = [];

    for (const entry of entries) {
      const tokens = Math.ceil(JSON.stringify(entry).length / CHARS_PER_TOKEN);
      if (totalTokens + tokens > this.maxTokens) break;
      totalTokens += tokens;
      filtered.push(entry);
    }

    return filtered;
  }
}

export class MemoryFileSelector {
  constructor(
    private tapeService: MemoryTapeService,
    private memoryDir: string,
  ) {}

  selectFilesForContext(strategy: "recent-only" | "smart", limit: number): string[] {
    return strategy === "recent-only" ? this.selectRecentOnly(limit) : this.selectSmart(limit);
  }

  private selectRecentOnly(limit: number): string[] {
    return this.scanMemoryDirectory(limit);
  }

  private selectSmart(limit: number): string[] {
    const anchor = this.tapeService.getLastAnchor();
    if (!anchor) return this.scanMemoryDirectory(limit);

    const entries = this.tapeService.query({ sinceAnchor: anchor.name });
    const pathStats = this.analyzePathAccess(entries);
    if (pathStats.size === 0) return this.scanMemoryDirectory(limit);

    return this.sortPathsByStats(pathStats).slice(0, limit);
  }

  buildContextFromFiles(filePaths: string[]): string {
    if (filePaths.length === 0) return "";

    const lines = ["# Project Memory", "", "Available memory files (use memory_read to view full content):", ""];
    for (const relPath of filePaths) {
      const { description, tags } = this.extractFrontmatter(relPath);
      lines.push(`- ${relPath}`, `  Description: ${description}`, `  Tags: ${tags}`, "");
    }

    return lines.join("\n");
  }

  private analyzePathAccess(entries: SessionEntry[]): Map<string, { count: number; lastAccess: number }> {
    const pathStats = new Map<string, { count: number; lastAccess: number }>();

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry as SessionMessageEntry;
      if (msg.message.role !== "assistant") continue;
      if (!Array.isArray(msg.message.content)) continue;

      for (const block of msg.message.content) {
        if (block.type !== "toolCall") continue;
        if (block.name !== "memory_read" && block.name !== "memory_write") continue;

        const entryPath = block.arguments.path as string | undefined;
        if (!entryPath) continue;

        const stats = pathStats.get(entryPath) ?? { count: 0, lastAccess: 0 };
        stats.count++;
        stats.lastAccess = Math.max(stats.lastAccess, new Date(entry.timestamp).getTime());
        pathStats.set(entryPath, stats);
      }
    }

    return pathStats;
  }

  private sortPathsByStats(pathStats: Map<string, { count: number; lastAccess: number }>): string[] {
    return Array.from(pathStats.entries())
      .sort(([, a], [, b]) => b.count - a.count || b.lastAccess - a.lastAccess)
      .map(([path]) => path);
  }

  private scanMemoryDirectory(limit: number): string[] {
    const coreDir = path.join(this.memoryDir, "core");
    if (!fs.existsSync(coreDir)) return [];

    const paths: string[] = [];
    const scanDir = (dir: string, base: string): void => {
      if (paths.length >= limit) return;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (paths.length >= limit || entry.name.startsWith(".")) continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(base, entry.name);

        if (entry.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          paths.push(relPath);
        }
      }
    };

    scanDir(coreDir, "core");
    return paths;
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
