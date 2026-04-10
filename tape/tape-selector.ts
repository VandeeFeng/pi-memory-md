import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { MemoryTapeService } from "./tape-service.js";
import type { TapeConfig, TapeEntry } from "./tape-types.js";

const CHARS_PER_TOKEN = 4;

export interface TapeMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export function formatEntriesAsMessages(entries: TapeEntry[]): TapeMessage[] {
  const messages: TapeMessage[] = [];
  const pendingToolCalls = new Map<string, { name: string }>();

  for (const entry of entries) {
    switch (entry.kind) {
      case "anchor":
      case "session/start": {
        messages.push({
          role: "assistant",
          content: `[Anchor: ${entry.payload.name}] ${JSON.stringify(entry.payload.state, null, 2)}`,
        });
        break;
      }

      case "message/user": {
        messages.push({ role: "user", content: entry.payload.content as string });
        break;
      }

      case "message/assistant": {
        messages.push({ role: "assistant", content: entry.payload.content as string });
        break;
      }

      case "tool_call": {
        const callId = (entry.payload.callId as string) ?? `call_${Date.now()}`;
        pendingToolCalls.set(callId, { name: entry.payload.tool as string });
        break;
      }

      case "tool_result": {
        const callId = entry.payload.callId as string;
        const content =
          typeof entry.payload.result === "string" ? entry.payload.result : JSON.stringify(entry.payload.result);

        if (callId && pendingToolCalls.has(callId)) {
          messages.push({
            role: "assistant",
            content: "",
            tool_call_id: callId,
            name: pendingToolCalls.get(callId)!.name,
          });
          pendingToolCalls.delete(callId);
        }

        messages.push({ role: "tool", content: content.slice(0, 5000) });
        break;
      }

      case "memory/read": {
        messages.push({ role: "assistant", content: `[Memory Read] ${entry.payload.path}` });
        break;
      }

      case "memory/write": {
        messages.push({ role: "assistant", content: `[Memory Write] ${entry.payload.path}` });
        break;
      }

      case "memory/search": {
        messages.push({
          role: "assistant",
          content: `[Memory Search] "${entry.payload.query}" returned ${entry.payload.count} results`,
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

  constructor(tapeService: MemoryTapeService, config?: TapeConfig) {
    this.tapeService = tapeService;
    this.maxTokens = config?.context?.maxTapeTokens ?? 1000;
    this.maxEntries = config?.context?.maxTapeEntries ?? 40;
  }

  selectFromAnchor(anchorId?: string): TapeEntry[] {
    const entries = this.tapeService.query({ sinceAnchor: anchorId }).slice(-this.maxEntries);
    return this.filterByTokenBudget(entries);
  }

  buildFormattedContext(entries: TapeEntry[]): string {
    const lines: string[] = [];

    for (const entry of entries) {
      switch (entry.kind) {
        case "message/user":
        case "message/assistant": {
          const content = entry.payload.content as string;
          const truncated = content.length > 80 ? `${content.slice(0, 80)}...` : content;
          lines.push(`${entry.kind === "message/user" ? "User" : "Assistant"}: ${truncated}`);
          break;
        }

        case "tool_call": {
          const argsStr = JSON.stringify(entry.payload.args).slice(0, 50);
          lines.push(`Tool: ${entry.payload.tool}(${argsStr})`);
          break;
        }

        case "tool_result": {
          const resultStr = JSON.stringify(entry.payload.result).slice(0, 50);
          lines.push(`Result: ${entry.payload.tool} -> ${resultStr}`);
          break;
        }

        case "memory/read":
          lines.push(`Memory read: ${entry.payload.path}`);
          break;

        case "memory/write":
          lines.push(`Memory write: ${entry.payload.path}`);
          break;

        case "memory/search":
          lines.push(`Memory search: ${entry.payload.query}`);
          break;

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
      const tokens = Math.ceil(JSON.stringify(entry.payload).length / CHARS_PER_TOKEN);
      if (totalTokens + tokens > this.maxTokens) break;
      filtered.push(entry);
      totalTokens += tokens;
    }

    return filtered;
  }
}

export class MemoryFileSelector {
  private tapeService: MemoryTapeService;
  private memoryDir: string;

  constructor(tapeService: MemoryTapeService, memoryDir: string) {
    this.tapeService = tapeService;
    this.memoryDir = memoryDir;
  }

  selectFilesForContext(strategy: "recent-only" | "smart", limit: number): string[] {
    if (strategy === "recent-only") return this.selectRecentOnly(limit);
    return this.selectSmart(limit);
  }

  selectRecentOnly(limit: number): string[] {
    const memoryEntries = this.tapeService.query({ kinds: ["memory/read", "memory/write"] });
    const paths = new Set<string>();

    for (let i = memoryEntries.length - 1; i >= 0 && paths.size < limit; i--) {
      const entryPath = memoryEntries[i].payload.path as string;
      if (entryPath) paths.add(entryPath);
    }

    return Array.from(paths);
  }

  selectSmart(limit: number): string[] {
    const anchor = this.tapeService.getLastAnchor();
    const entries = this.tapeService.query({ sinceAnchor: anchor?.id });
    const pathStats = this.analyzePathAccess(entries);
    const selected = new Set(this.tapeService.getAlwaysInclude());

    for (const entryPath of this.sortPathsByStats(pathStats)) {
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

  buildContextFromFiles(filePaths: string[]): string {
    if (filePaths.length === 0) return "";

    const lines = ["# Project Memory", "", "Available memory files (use memory_read to view full content):", ""];

    for (const relPath of filePaths) {
      const { description, tags } = this.extractFrontmatter(relPath);
      lines.push(`- ${relPath}`);
      lines.push(`  Description: ${description}`);
      lines.push(`  Tags: ${tags}`);
      lines.push("");
    }

    return lines.join("\n");
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
      return statsA.count !== statsB.count ? statsB.count - statsA.count : statsB.lastAccess - statsA.lastAccess;
    });
  }

  private scanMemoryDirectory(limit: number): string[] {
    const coreDir = path.join(this.memoryDir, "core");
    if (!fs.existsSync(coreDir)) return [];

    const paths: string[] = [];
    const scanDir = (dir: string, base = ""): void => {
      if (paths.length >= limit) return;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (paths.length >= limit || entry.name.startsWith(".")) continue;

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

  private extractFrontmatter(relPath: string): { description: string; tags: string } {
    const fullPath = path.join(this.memoryDir, relPath);
    try {
      const { data } = matter.read(fullPath);
      const description = (data.description as string)?.trim() || "No description";
      const tags = Array.isArray(data.tags) && data.tags.length > 0 ? data.tags.join(", ") : "none";
      return { description, tags };
    } catch {
      return { description: "No description", tags: "none" };
    }
  }
}
