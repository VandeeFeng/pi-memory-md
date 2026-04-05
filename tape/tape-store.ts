import fs from "node:fs";
import path from "node:path";
import type { TapeEntry, TapeEntryKind } from "./tape-types.js";
import { getLocalPath } from "../memory-md.js";

export class MemoryTapeStore {
  private tapePath: string;
  private tapeDir: string;
  private projectName: string;

  constructor(
    memoryDir: string,
    customTapePath?: string,
    projectName?: string,
    sessionId?: string,
  ) {
    this.tapeDir = customTapePath ?? path.join(getLocalPath(), "TAPE");
    fs.mkdirSync(this.tapeDir, { recursive: true });

    this.projectName = projectName ?? path.basename(memoryDir);
    const sid = sessionId ?? "unknown";
    this.tapePath = path.join(this.tapeDir, `${this.projectName}__${sid}.jsonl`);
  }



  append(entry: TapeEntry): void {
    fs.appendFileSync(this.tapePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  private loadAllEntries(): TapeEntry[] {
    if (!fs.existsSync(this.tapeDir)) return [];

    const allEntries: TapeEntry[] = [];
    // Exact match: projectName__*.jsonl (avoid matching similar project names)
    const prefix = `${this.projectName}__`;
    const jsonlFiles = fs.readdirSync(this.tapeDir).filter(
      (f) => f.endsWith(".jsonl") && f.startsWith(prefix)
    );

    for (const file of jsonlFiles) {
      const filePath = path.join(this.tapeDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const entries = lines.map((line) => this.parseEntry(line)).filter(Boolean) as TapeEntry[];
      allEntries.push(...entries);
    }

    return allEntries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
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
    const sinceTime = since ? new Date(since).getTime() : 0;

    if (betweenAnchors) {
      const startIdx = this.findAnchorIndex(entries, betweenAnchors.start);
      const endIdx = this.findAnchorIndex(entries, betweenAnchors.end, startIdx + 1);
      if (startIdx < 0 || endIdx < 0) return [];
      entries = entries.slice(startIdx + 1, endIdx);
    } else if (lastAnchor) {
      const lastAnchorIdx = this.findLastAnchorIndex(entries);
      if (lastAnchorIdx < 0) return [];
      entries = entries.slice(lastAnchorIdx + 1);
    } else if (sinceAnchor) {
      const anchorIdx = this.findAnchorIndex(entries, sinceAnchor);
      if (anchorIdx < 0) return [];
      entries = entries.slice(anchorIdx + 1);
    }

    if (betweenDates) {
      const startTime = new Date(betweenDates.start).getTime();
      const endTime = new Date(betweenDates.end).getTime();
      entries = entries.filter((entry) => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime >= startTime && entryTime <= endTime;
      });
    }

    if (query) {
      const needle = query.toLowerCase();
      entries = entries.filter((entry) =>
        JSON.stringify({ kind: entry.kind, date: entry.timestamp, payload: entry.payload, meta: entry })
          .toLowerCase()
          .includes(needle)
      );
    }

    if (kinds) {
      entries = entries.filter((entry) => kinds.includes(entry.kind));
    }

    if (sinceTime > 0) {
      entries = entries.filter((entry) => new Date(entry.timestamp).getTime() >= sinceTime);
    }

    if (limit) {
      entries = entries.slice(0, limit);
    }

    return entries;
  }

  private findAnchorIndex(entries: TapeEntry[], name: string, start = 0): number {
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      if ((entry.kind === "anchor" || entry.kind === "session/start") && entry.payload.name === name) {
        return i;
      }
    }
    return -1;
  }

  private findLastAnchorIndex(entries: TapeEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind === "anchor" || entries[i].kind === "session/start") {
        return i;
      }
    }
    return -1;
  }

  private parseEntry(line: string): TapeEntry | null {
    try {
      return JSON.parse(line) as TapeEntry;
    } catch {
      return null;
    }
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
    if (!fs.existsSync(this.tapeDir)) return 0;
    const prefix = `${this.projectName}__`;
    return fs.readdirSync(this.tapeDir).filter(
      (f) => f.endsWith(".jsonl") && f.startsWith(prefix)
    ).length;
  }

  getAllTapeFiles(): string[] {
    if (!fs.existsSync(this.tapeDir)) return [];
    const prefix = `${this.projectName}__`;
    return fs.readdirSync(this.tapeDir).filter(
      (f) => f.endsWith(".jsonl") && f.startsWith(prefix)
    );
  }

  getTapeDir(): string {
    return this.tapeDir;
  }
}
