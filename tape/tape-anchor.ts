import fs from "node:fs";
import path from "node:path";
import { toTimestamp } from "../utils.js";

const MAX_MEMORY_ANCHORS = 100;

export type TapeAnchorType = "session" | "handoff";

export type TapeAnchorMeta = {
  trigger?: "direct" | "keyword" | "manual";
  keywords?: string[];
  summary?: string;
  purpose?: string;
};

export interface TapeAnchor {
  id: string;
  name: string;
  type: TapeAnchorType;
  sessionId: string;
  sessionEntryId: string;
  timestamp: string;
  meta?: TapeAnchorMeta;
}

export type TapeAnchorScanMode = "latest" | "all";

export interface TapeAnchorScanOptions {
  id?: string;
  sessionId?: string;
  sessionEntryId?: string;
  name?: string;
  nameCaseInsensitive?: boolean;
  scan?: string;
  since?: string;
  until?: string;
  type?: "session" | "handoff";
  summary?: string;
  purpose?: string;
  keywords?: string[];
  limit?: number;
  mode?: "latest" | "all";
}

type FileReadResult = { entries: TapeAnchor[]; error?: Error };

function sortAnchorsByTimestamp(anchors: TapeAnchor[]): TapeAnchor[] {
  return anchors.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
}

function parseAnchorLine(line: string): TapeAnchor | null {
  try {
    const rawEntry = JSON.parse(line) as Partial<TapeAnchor>;
    if (!rawEntry.name || !rawEntry.type || !rawEntry.sessionId || !rawEntry.sessionEntryId || !rawEntry.timestamp) {
      return null;
    }

    return {
      id: rawEntry.id ?? `${rawEntry.sessionEntryId}:${rawEntry.timestamp}:${rawEntry.name}`,
      name: rawEntry.name,
      type: rawEntry.type,
      sessionId: rawEntry.sessionId,
      sessionEntryId: rawEntry.sessionEntryId,
      timestamp: rawEntry.timestamp,
      meta: rawEntry.meta,
    };
  } catch {
    return null;
  }
}

function filterByScanOptions(anchors: TapeAnchor[], options: TapeAnchorScanOptions): TapeAnchor[] {
  const {
    id,
    name,
    nameCaseInsensitive,
    sessionId,
    sessionEntryId,
    scan,
    since,
    until,
    type,
    summary,
    purpose,
    keywords,
  } = options;

  const sinceTime = since ? toTimestamp(since) : null;
  const untilTime = until ? toTimestamp(until) : null;
  const lowerName = nameCaseInsensitive ? name?.toLowerCase() : undefined;

  return anchors.filter((anchor) => {
    if (id !== undefined && anchor.id !== id) return false;
    if (sessionId !== undefined && anchor.sessionId !== sessionId) return false;
    if (sessionEntryId !== undefined && anchor.sessionEntryId !== sessionEntryId) return false;
    if (type !== undefined && anchor.type !== type) return false;

    if (lowerName !== undefined) {
      if (!anchor.name.toLowerCase().includes(lowerName)) return false;
    } else if (name !== undefined) {
      if (!anchor.name.includes(name)) return false;
    }

    const anchorTime = toTimestamp(anchor.timestamp);
    if (sinceTime !== null && anchorTime < sinceTime) return false;
    if (untilTime !== null && anchorTime > untilTime) return false;

    if (summary && !anchor.meta?.summary?.toLowerCase().includes(summary.toLowerCase())) return false;
    if (purpose && !anchor.meta?.purpose?.toLowerCase().includes(purpose.toLowerCase())) return false;
    if (keywords?.length) {
      const anchorKeywords = anchor.meta?.keywords?.map((k) => k.toLowerCase()) ?? [];
      if (!keywords.every((k) => anchorKeywords.includes(k.toLowerCase()))) return false;
    }

    if (scan) {
      const needle = scan.toLowerCase();
      const metaStr = anchor.meta ? JSON.stringify(anchor.meta).toLowerCase() : "";
      if (
        !anchor.name.toLowerCase().includes(needle) &&
        !anchor.type.toLowerCase().includes(needle) &&
        !metaStr.includes(needle)
      ) {
        return false;
      }
    }

    return true;
  });
}

function pickByMode(anchors: TapeAnchor[], mode: TapeAnchorScanMode): TapeAnchor[] {
  if (mode === "all") return anchors;
  return anchors.length > 0 ? [anchors[anchors.length - 1]] : [];
}

export class AnchorStore {
  private readonly anchorDir: string;
  private readonly indexPath: string;
  private index: Map<string, TapeAnchor[]> = new Map();
  private allAnchors: TapeAnchor[] = [];
  private anchorsBySession: Map<string, TapeAnchor[]> = new Map();
  private anchorsBySessionEntry: Map<string, TapeAnchor[]> = new Map();

  constructor(tapeBasePath: string, projectName: string) {
    const anchorDir = tapeBasePath;
    this.anchorDir = anchorDir;
    this.indexPath = path.join(anchorDir, `${projectName}__anchors.jsonl`);
    this.ensureDir();
    this.loadIndex();
  }

  private ensureDir(): void {
    fs.mkdirSync(this.anchorDir, { recursive: true });
  }

  private loadIndex(): void {
    if (!fs.existsSync(this.indexPath)) return;

    try {
      const content = fs.readFileSync(this.indexPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());
      const startIndex = Math.max(0, lines.length - MAX_MEMORY_ANCHORS);
      const recentLines = lines.slice(startIndex);

      for (const line of recentLines) {
        const entry = parseAnchorLine(line);
        if (entry) this.addToMemoryIndex(entry);
      }
    } catch {
      // File read error, start fresh
    }
  }

  private addToMemoryIndex(entry: TapeAnchor): void {
    const byName = this.index.get(entry.name) ?? [];
    byName.push(entry);
    this.index.set(entry.name, byName);

    this.allAnchors.push(entry);
    sortAnchorsByTimestamp(this.allAnchors);

    const bySession = this.anchorsBySession.get(entry.sessionId) ?? [];
    bySession.push(entry);
    sortAnchorsByTimestamp(bySession);
    this.anchorsBySession.set(entry.sessionId, bySession);

    const sessionEntryKey = this.getSessionEntryKey(entry.sessionEntryId, entry.sessionId);
    const bySessionEntry = this.anchorsBySessionEntry.get(sessionEntryKey) ?? [];
    bySessionEntry.push(entry);
    sortAnchorsByTimestamp(bySessionEntry);
    this.anchorsBySessionEntry.set(sessionEntryKey, bySessionEntry);
  }

  private scanFile(options: TapeAnchorScanOptions): TapeAnchor[] {
    const { entries, error } = this.parseFileLines();
    if (error) {
      console.error(`[AnchorStore] Failed to read index file: ${error.message}`);
      return [];
    }

    const mode = options.mode ?? "all";
    const filtered = filterByScanOptions(entries, options);
    return pickByMode(filtered, mode);
  }

  private getSessionEntryKey(sessionEntryId: string, sessionId?: string): string {
    return `${sessionId ?? "*"}::${sessionEntryId}`;
  }

  append(entry: TapeAnchor): void {
    fs.appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
    this.addToMemoryIndex(entry);
  }

  removeById(id: string): TapeAnchor | null {
    const anchor = this.scan({ id, mode: "latest" })[0] ?? null;
    if (!anchor) return null;

    this.rebuildIndex(this.allAnchors.filter((entry) => entry.id !== id));
    return anchor;
  }

  private parseFileLines(): FileReadResult {
    if (!fs.existsSync(this.indexPath)) return { entries: [] };

    try {
      const content = fs.readFileSync(this.indexPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim());
      const entries: TapeAnchor[] = [];

      for (const line of lines) {
        const entry = parseAnchorLine(line);
        if (entry) entries.push(entry);
      }

      return { entries };
    } catch (err) {
      return { entries: [], error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  getAllAnchors(): TapeAnchor[] {
    return [...this.allAnchors];
  }

  // scan logic
  scan(options: TapeAnchorScanOptions): TapeAnchor[] {
    const mode = options.mode ?? "all";
    const memoryResults = this.scanMemory({ ...options, mode: "all" });

    if (mode !== "all" && memoryResults.length > 0) {
      return pickByMode(memoryResults, mode);
    }

    const fileResults = this.scanFile({ ...options, mode: "all" });
    const existingIds = new Set(this.allAnchors.map((anchor) => anchor.id));
    for (const anchor of fileResults) {
      if (!existingIds.has(anchor.id)) {
        this.addToMemoryIndex(anchor);
        existingIds.add(anchor.id);
      }
    }

    const merged = this.mergeAnchors(memoryResults, fileResults);
    return pickByMode(merged, mode);
  }

  private scanMemory(options: TapeAnchorScanOptions): TapeAnchor[] {
    const filtered = filterByScanOptions(this.allAnchors, options);
    return sortAnchorsByTimestamp(filtered);
  }

  // search logic
  search(options: TapeAnchorScanOptions): TapeAnchor[] {
    const { limit = 20 } = options;
    return this.scan({ ...options, mode: "all" }).slice(-limit);
  }

  private mergeAnchors(cached: TapeAnchor[], file: TapeAnchor[]): TapeAnchor[] {
    const seen = new Set<string>();
    const merged: TapeAnchor[] = [];

    for (const anchor of [...cached, ...file]) {
      if (!seen.has(anchor.id)) {
        seen.add(anchor.id);
        merged.push(anchor);
      }
    }

    return sortAnchorsByTimestamp(merged);
  }

  clear(): void {
    if (fs.existsSync(this.indexPath)) {
      fs.unlinkSync(this.indexPath);
    }

    this.index.clear();
    this.allAnchors = [];
    this.anchorsBySession.clear();
    this.anchorsBySessionEntry.clear();
  }

  private rebuildIndex(entries: TapeAnchor[]): void {
    this.index.clear();
    this.allAnchors = [];
    this.anchorsBySession.clear();
    this.anchorsBySessionEntry.clear();

    if (entries.length === 0) {
      if (fs.existsSync(this.indexPath)) {
        fs.unlinkSync(this.indexPath);
      }
      return;
    }

    const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    fs.writeFileSync(this.indexPath, content, "utf-8");

    for (const entry of entries) {
      this.addToMemoryIndex(entry);
    }
  }
}
