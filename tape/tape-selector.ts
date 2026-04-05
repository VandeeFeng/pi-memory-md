import fs from "node:fs";
import path from "node:path";
import type { TapeEntry, TapeConfig } from "./tape-types.js";
import type { MemoryTapeService } from "./tape-service.js";

const CHARS_PER_TOKEN = 4;

export interface TapeMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export function formatEntriesAsMessages(entries: TapeEntry[]): TapeMessage[] {
  const messages: TapeMessage[] = [];
  const pendingToolCalls = new Map<string, { id: string; function: { name: string; arguments: string } }>();

  for (const entry of entries) {
    switch (entry.kind) {
      case "anchor":
      case "session/start": {
        const name = entry.payload.name as string;
        const state = entry.payload.state as Record<string, unknown>;
        messages.push({
          role: "assistant",
          content: `[Anchor: ${name}] ${JSON.stringify(state, null, 2)}`,
        });
        break;
      }

      case "message/user": {
        const content = entry.payload.content as string;
        messages.push({ role: "user", content });
        break;
      }

      case "message/assistant": {
        const content = entry.payload.content as string;
        messages.push({ role: "assistant", content });
        break;
      }

      case "tool_call": {
        const tool = entry.payload.tool as string;
        const args = entry.payload.args as Record<string, unknown>;
        const callId = (entry.payload.callId as string) ?? `call_${Date.now()}`;
        pendingToolCalls.set(callId, {
          id: callId,
          function: { name: tool, arguments: JSON.stringify(args) },
        });
        break;
      }

      case "tool_result": {
        const result = entry.payload.result;
        const callId = entry.payload.callId as string;
        const content = typeof result === "string" ? result : JSON.stringify(result);

        if (callId) {
          const call = pendingToolCalls.get(callId);
          if (call) {
            messages.push({
              role: "assistant",
              content: "",
              tool_call_id: callId,
              name: call.function.name,
            });
            pendingToolCalls.delete(callId);
          }
        }

        messages.push({ role: "tool", content: content.slice(0, 5000) });
        break;
      }

      case "memory/read": {
        const entryPath = entry.payload.path as string;
        messages.push({ role: "assistant", content: `[Memory Read] ${entryPath}` });
        break;
      }

      case "memory/write": {
        const entryPath = entry.payload.path as string;
        messages.push({ role: "assistant", content: `[Memory Write] ${entryPath}` });
        break;
      }

      case "memory/search": {
        const query = entry.payload.query as string;
        const count = entry.payload.count as number;
        messages.push({
          role: "assistant",
          content: `[Memory Search] "${query}" returned ${count} results`,
        });
        break;
      }
    }
  }

  return messages;
}

export class ConversationSelector {
  private tapeService: MemoryTapeService;
  private maxTokens: number;
  private maxEntries: number;

  private readonly CORE_ENTRY_KINDS = [
    "message/user",
    "message/assistant",
    "tool_call",
    "tool_result",
    "anchor",
    "session/start",
    "memory/read",
    "memory/write",
    "memory/search",
    "memory/sync",
    "memory/init",
  ] as const;

  constructor(tapeService: MemoryTapeService, config?: TapeConfig) {
    this.tapeService = tapeService;
    this.maxTokens = config?.context?.maxTapeTokens ?? 1000;
    this.maxEntries = config?.context?.maxTapeEntries ?? 40;
  }

  private filterCoreEntries(entries: TapeEntry[]): TapeEntry[] {
    return entries.filter((e) => this.CORE_ENTRY_KINDS.includes(e.kind as never));
  }

  selectFromAnchor(anchorId?: string): TapeEntry[] {
    let entries = this.tapeService.getEntriesSince(anchorId);
    entries = entries.slice(-this.maxEntries);
    entries = this.filterCoreEntries(entries);
    return this.filterByTokenBudget(entries);
  }

  buildFormattedContext(entries: TapeEntry[]): string {
    const lines: string[] = [];

    for (const entry of entries) {
      switch (entry.kind) {
        case "message/user": {
          const content = entry.payload.content as string;
          const truncated = content.length > 80 ? `${content.slice(0, 80)}...` : content;
          lines.push(`User: ${truncated}`);
          break;
        }

        case "message/assistant": {
          const content = entry.payload.content as string;
          const truncated = content.length > 80 ? `${content.slice(0, 80)}...` : content;
          lines.push(`Assistant: ${truncated}`);
          break;
        }

        case "tool_call": {
          const tool = entry.payload.tool as string;
          const args = entry.payload.args as Record<string, unknown>;
          const argsStr = JSON.stringify(args).slice(0, 50);
          lines.push(`Tool: ${tool}(${argsStr})`);
          break;
        }

        case "tool_result": {
          const tool = entry.payload.tool as string;
          const result = entry.payload.result;
          const resultStr = JSON.stringify(result).slice(0, 50);
          lines.push(`Result: ${tool} -> ${resultStr}`);
          break;
        }

        case "memory/read": {
          const path = entry.payload.path as string;
          lines.push(`Memory read: ${path}`);
          break;
        }

        case "memory/write": {
          const path = entry.payload.path as string;
          lines.push(`Memory write: ${path}`);
          break;
        }

        case "memory/search": {
          const query = entry.payload.query as string;
          lines.push(`Memory search: ${query}`);
          break;
        }

        case "anchor":
        case "session/start":
          lines.push(`-- Anchor: ${entry.payload.name ?? "checkpoint"} --`);
          break;
      }
    }

    if (lines.length === 0) return "";
    return `${lines.join("\n")}\n\n---\n`;
  }

  private filterByTokenBudget(entries: TapeEntry[]): TapeEntry[] {
    let totalTokens = 0;
    const filtered: TapeEntry[] = [];

    for (const entry of entries) {
      const tokens = this.estimateTokens(entry.payload);

      if (totalTokens + tokens > this.maxTokens) {
        break;
      }

      filtered.push(entry);
      totalTokens += tokens;
    }

    return filtered;
  }

  private estimateTokens(payload: Record<string, unknown>): number {
    return Math.ceil(JSON.stringify(payload).length / CHARS_PER_TOKEN);
  }
}

export class MemoryFileSelector {
  private tapeService: MemoryTapeService;
  private memoryDir: string;

  constructor(tapeService: MemoryTapeService, memoryDir: string) {
    this.tapeService = tapeService;
    this.memoryDir = memoryDir;
  }

  selectRecentOnly(limit: number): string[] {
    const memoryEntries = this.tapeService.query({
      kinds: ["memory/read", "memory/write"],
    });

    const paths = new Set<string>();
    for (const entry of memoryEntries.reverse()) {
      const entryPath = entry.payload.path as string;
      if (entryPath) paths.add(entryPath);
      if (paths.size >= limit) break;
    }

    return Array.from(paths);
  }

  selectSmart(limit: number): string[] {
    const anchor = this.tapeService.getLastAnchor();
    const entries = this.tapeService.query({ sinceAnchor: anchor?.id });
    const pathStats = this.analyzePathAccess(entries);
    const sortedPaths = this.sortPathsByStats(pathStats);
    const selected = new Set(this.tapeService.getAlwaysInclude());

    for (const entryPath of sortedPaths) {
      selected.add(entryPath);
      if (selected.size >= limit) break;
    }

    if (selected.size === 0) {
      for (const entryPath of this.scanMemoryDirectory(limit)) {
        selected.add(entryPath);
        if (selected.size >= limit) break;
      }
    }

    return Array.from(selected);
  }

  private scanMemoryDirectory(limit: number): string[] {
    const coreDir = path.join(this.memoryDir, "core");
    if (!fs.existsSync(coreDir)) return [];

    const paths: string[] = [];
    const scanDir = (dir: string, base: string = ""): void => {
      if (paths.length >= limit) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (paths.length >= limit) break;
        if (entry.name.startsWith(".")) continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = base ? path.join(base, entry.name) : entry.name;

        if (entry.isDirectory()) {
          scanDir(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          paths.push(relPath);
        }
      }
    };

    scanDir(coreDir);
    return paths;
  }

  private analyzePathAccess(entries: TapeEntry[]): Map<string, { count: number; lastAccess: number }> {
    const pathStats = new Map<string, { count: number; lastAccess: number }>();

    for (const entry of entries) {
      if (entry.kind !== "memory/read" && entry.kind !== "memory/write") continue;

      const entryPath = entry.payload.path as string;
      if (!entryPath) continue;

      const stats = pathStats.get(entryPath) ?? { count: 0, lastAccess: 0 };
      stats.count++;
      stats.lastAccess = Math.max(stats.lastAccess, new Date(entry.timestamp).getTime());
      pathStats.set(entryPath, stats);
    }

    return pathStats;
  }

  private sortPathsByStats(pathStats: Map<string, { count: number; lastAccess: number }>): string[] {
    return Array.from(pathStats.keys()).sort((a, b) => {
      const statsA = pathStats.get(a)!;
      const statsB = pathStats.get(b)!;

      if (statsA.count !== statsB.count) {
        return statsB.count - statsA.count;
      }

      return statsB.lastAccess - statsA.lastAccess;
    });
  }

  selectFilesForContext(strategy: "recent-only" | "smart", limit: number): string[] {
    if (strategy === "recent-only") return this.selectRecentOnly(limit);
    return this.selectSmart(limit);
  }

  buildContextFromFiles(filePaths: string[]): string {
    if (filePaths.length === 0) return "";

    const lines = [
      "# Project Memory",
      "",
      "Available memory files (use memory_read to view full content):",
      "",
    ];

    for (const relPath of filePaths) {
      const { description, tags } = this.extractFrontmatter(relPath);
      lines.push(`- ${relPath}`);
      lines.push(`  Description: ${description}`);
      lines.push(`  Tags: ${tags}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  private extractFrontmatter(relPath: string): { description: string; tags: string } {
    const fullPath = path.join(this.memoryDir, relPath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) {
        return { description: "No description", tags: "none" };
      }

      const frontmatter = frontmatterMatch[1];
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      const tagMatch = frontmatter.match(/tags:\s*\[(.*?)\]/);

      const description = descMatch ? descMatch[1].replace(/'/g, "").trim() : "No description";
      const tags = tagMatch ? this.parseTags(tagMatch[1]) : "none";

      return { description, tags };
    } catch {
      return { description: "No description", tags: "none" };
    }
  }

  private parseTags(tagString: string): string {
    const tags = tagString
      .split(",")
      .map((t) => t.trim().replace(/'/g, ""))
      .filter(Boolean)
      .join(", ");
    return tags || "none";
  }
}
