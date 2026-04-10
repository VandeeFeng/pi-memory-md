import fs from "node:fs";
import path from "node:path";
import { getLocalPath } from "../memory-md.js";
import type { TapeEntry, TapeEntryKind } from "./tape-types.js";

const ANCHOR_KINDS: ReadonlySet<string> = new Set(["anchor", "session/start"]);

function isAnchorEntry(entry: TapeEntry): boolean {
  return ANCHOR_KINDS.has(entry.kind);
}

export class MemoryTapeStore {
  private tapePath: string;
  private tapeDir: string;
  private projectName: string;

  constructor(memoryDir: string, customTapePath?: string, projectName?: string, sessionId?: string) {
    this.tapeDir = customTapePath ?? path.join(getLocalPath(), "TAPE");
    fs.mkdirSync(this.tapeDir, { recursive: true });

    this.projectName = projectName ?? path.basename(memoryDir);
    const sid = sessionId ?? "unknown";
    this.tapePath = path.join(this.tapeDir, `${this.projectName}__${sid}.jsonl`);
  }

  append(entry: TapeEntry): void {
    fs.appendFileSync(this.tapePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  query(options: {
    query?: string;
    kinds?: TapeEntryKind[];
    limit?: number;
    since?: string;
    sinceAnchor?: string;
    lastAnchor?: boolean;
    betweenAnchors?: { start: string; end: string };
    betweenDates?: { start: string; end: string };
  }): TapeEntry[] {
    let entries = this.loadAllEntries();
    const { betweenAnchors, betweenDates, kinds, lastAnchor, limit, query, since, sinceAnchor } = options;

    // Apply anchor-based slicing first (these are mutually exclusive)
    if (betweenAnchors) {
      const startIdx = this.findAnchorIndex(entries, betweenAnchors.start);
      const endIdx = this.findAnchorIndex(entries, betweenAnchors.end, startIdx + 1);
      if (startIdx < 0 || endIdx < 0) return [];
      entries = entries.slice(startIdx + 1, endIdx);
    } else if (lastAnchor) {
      const idx = this.findLastAnchorIndex(entries);
      if (idx < 0) return [];
      entries = entries.slice(idx + 1);
    } else if (sinceAnchor) {
      const idx = this.findAnchorIndex(entries, sinceAnchor);
      if (idx < 0) return [];
      entries = entries.slice(idx + 1);
    }

    // Apply filters
    if (betweenDates) {
      const startTime = new Date(betweenDates.start).getTime();
      const endTime = new Date(betweenDates.end).getTime();
      entries = entries.filter((entry) => {
        const t = new Date(entry.timestamp).getTime();
        return t >= startTime && t <= endTime;
      });
    }

    if (query) {
      const needle = query.toLowerCase();
      entries = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
    }

    if (kinds) {
      entries = entries.filter((entry) => kinds.includes(entry.kind));
    }

    if (since) {
      const sinceTime = new Date(since).getTime();
      entries = entries.filter((entry) => new Date(entry.timestamp).getTime() >= sinceTime);
    }

    if (limit) {
      entries = entries.slice(0, limit);
    }

    return entries;
  }

  getLastAnchor(): TapeEntry | null {
    const entries = this.query({ kinds: ["session/start", "anchor"] });
    return entries.at(-1) ?? null;
  }

  findAnchorByName(name: string): TapeEntry | null {
    const entries = this.query({ kinds: ["anchor", "session/start"] });
    return entries.find((e) => e.payload.name === name) ?? null;
  }

  clear(): void {
    if (fs.existsSync(this.tapePath)) fs.unlinkSync(this.tapePath);
  }

  getTapeFileCount(): number {
    return this.getTapeFiles().length;
  }

  getTapeDir(): string {
    return this.tapeDir;
  }

  private loadAllEntries(): TapeEntry[] {
    if (!fs.existsSync(this.tapeDir)) return [];

    const allEntries: TapeEntry[] = [];

    for (const file of this.getTapeFiles()) {
      const content = fs.readFileSync(path.join(this.tapeDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          allEntries.push(JSON.parse(line) as TapeEntry);
        } catch {
          // Skip malformed lines
        }
      }
    }

    return allEntries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  private getTapeFiles(): string[] {
    if (!fs.existsSync(this.tapeDir)) return [];
    const prefix = `${this.projectName}__`;
    return fs.readdirSync(this.tapeDir).filter((f) => f.endsWith(".jsonl") && f.startsWith(prefix));
  }

  private findAnchorIndex(entries: TapeEntry[], name: string, start = 0): number {
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      if (isAnchorEntry(entry) && entry.payload.name === name) {
        return i;
      }
    }
    return -1;
  }

  private findLastAnchorIndex(entries: TapeEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isAnchorEntry(entries[i])) return i;
    }
    return -1;
  }
}
