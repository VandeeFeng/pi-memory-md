import fs from "node:fs";
import path from "node:path";
import { toTimestamp } from "../utils.js";

export type TapeAnchorKind = "session" | "handoff";

export type TapeAnchorMeta = {
  trigger?: "direct" | "keyword" | "manual";
  keywords?: string[];
  summary?: string;
  purpose?: string;
};

export interface TapeAnchor {
  id: string;
  name: string;
  kind: TapeAnchorKind;
  sessionId: string;
  sessionEntryId: string;
  timestamp: string;
  meta?: TapeAnchorMeta;
}

const MAX_MEMORY_ANCHORS = 100;

type FileReadResult = { entries: TapeAnchor[]; error?: Error };

export type QueryOptions = {
  id?: string;
  name?: string;
  nameCaseInsensitive?: boolean;
  sessionId?: string;
  sessionEntryId?: string;
  returnMode?: "first" | "last" | "all";
};

function sortAnchorsByTimestamp(anchors: TapeAnchor[]): TapeAnchor[] {
  return anchors.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
}

function parseAnchorLine(line: string): TapeAnchor | null {
  try {
    const rawEntry = JSON.parse(line) as Partial<TapeAnchor>;
    if (!rawEntry.name || !rawEntry.kind || !rawEntry.sessionId || !rawEntry.sessionEntryId || !rawEntry.timestamp) {
      return null;
    }

    return {
      id: rawEntry.id ?? `${rawEntry.sessionEntryId}:${rawEntry.timestamp}:${rawEntry.name}`,
      name: rawEntry.name,
      kind: rawEntry.kind,
      sessionId: rawEntry.sessionId,
      sessionEntryId: rawEntry.sessionEntryId,
      timestamp: rawEntry.timestamp,
      meta: rawEntry.meta,
    };
  } catch {
    return null;
  }
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

      // Only load the most recent MAX_MEMORY_ANCHORS entries
      const startIndex = Math.max(0, lines.length - MAX_MEMORY_ANCHORS);
      const recentLines = lines.slice(startIndex);

      for (const line of recentLines) {
        const entry = parseAnchorLine(line);
        if (entry) {
          this.addToMemoryIndex(entry);
        }
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

  private queryFile(options: QueryOptions): TapeAnchor[] {
    const { entries, error } = this.readAndParseFileLines();
    if (error) {
      console.error(`[AnchorStore] Failed to read index file: ${error.message}`);
      return [];
    }

    const { id, name, nameCaseInsensitive, sessionId, sessionEntryId, returnMode } = options;
    const normalizedName = nameCaseInsensitive && name ? name.toLowerCase() : undefined;
    const results: TapeAnchor[] = [];

    for (const entry of entries) {
      if (id !== undefined && entry.id !== id) continue;
      if (normalizedName !== undefined && entry.name.toLowerCase() !== normalizedName) continue;
      if (name !== undefined && !nameCaseInsensitive && entry.name !== name) continue;
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (sessionEntryId !== undefined && entry.sessionEntryId !== sessionEntryId) continue;
      results.push(entry);
    }

    if (returnMode === "first" || returnMode === "last") {
      return results.length > 0 ? [results[results.length - 1]] : [];
    }
    return sortAnchorsByTimestamp(results);
  }

  private getSessionEntryKey(sessionEntryId: string, sessionId?: string): string {
    return `${sessionId ?? "*"}::${sessionEntryId}`;
  }

  append(entry: TapeAnchor): void {
    fs.appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
    this.addToMemoryIndex(entry);
  }

  removeById(id: string): TapeAnchor | null {
    const anchor = this.query({ id, returnMode: "first" })[0] ?? null;
    if (!anchor) return null;

    this.rebuildIndex(this.allAnchors.filter((entry) => entry.id !== id));
    return anchor;
  }

  private readAndParseFileLines(): FileReadResult {
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

  query(options: QueryOptions): TapeAnchor[] {
    const { id, name, nameCaseInsensitive, sessionId, sessionEntryId, returnMode = "all" } = options;

    const results = this.queryMemory(options);

    // For "first"/"last", if memory has results, newest is in memory (we load most recent)
    // For "all", need to check file since memory is limited to MAX_MEMORY_ANCHORS
    if (returnMode !== "all" && results.length > 0) {
      return [results[results.length - 1]];
    }

    // Check file and add new anchors to memory
    const fileResults = this.queryFile({ id, name, nameCaseInsensitive, sessionId, sessionEntryId });
    const existingIds = new Set(this.allAnchors.map((a) => a.id));
    for (const anchor of fileResults) {
      if (!existingIds.has(anchor.id)) {
        this.addToMemoryIndex(anchor);
        existingIds.add(anchor.id);
      }
    }

    // Merge and deduplicate
    const merged = this.mergeAnchors(results, fileResults);
    return returnMode === "all" ? merged : merged.length > 0 ? [merged[merged.length - 1]] : [];
  }

  private queryMemory(options: QueryOptions): TapeAnchor[] {
    const { id, name, nameCaseInsensitive, sessionId, sessionEntryId } = options;
    const normalizedName = nameCaseInsensitive && name ? name.toLowerCase() : undefined;
    const results: TapeAnchor[] = [];

    for (const anchor of this.allAnchors) {
      if (id !== undefined && anchor.id !== id) continue;
      if (normalizedName !== undefined && anchor.name.toLowerCase() !== normalizedName) continue;
      if (name !== undefined && !nameCaseInsensitive && anchor.name !== name) continue;
      if (sessionId !== undefined && anchor.sessionId !== sessionId) continue;
      if (sessionEntryId !== undefined && anchor.sessionEntryId !== sessionEntryId) continue;
      results.push(anchor);
    }

    return results;
  }

  search(options: {
    query?: string;
    sessionId?: string;
    limit?: number;
    since?: string;
    until?: string;
    name?: string;
    kind?: TapeAnchorKind;
    summary?: string;
    purpose?: string;
    keywords?: string[];
  }): TapeAnchor[] {
    const { query, sessionId, limit = 20, since, until, name, kind, summary, purpose, keywords } = options;
    const sinceTime = since ? toTimestamp(since) : null;
    const untilTime = until ? toTimestamp(until) : null;
    const needle = query?.toLowerCase();

    let anchors = sessionId ? [...(this.anchorsBySession.get(sessionId) ?? [])] : [...this.allAnchors];

    // Always check file for completeness since memory is limited to MAX_MEMORY_ANCHORS
    const fileAnchors = this.queryFile(sessionId ? { sessionId } : {});
    if (anchors.length === 0) {
      anchors = fileAnchors;
    } else if (fileAnchors.length > 0) {
      anchors = this.mergeAnchors(anchors, fileAnchors);
    }

    if (sinceTime !== null) {
      anchors = anchors.filter((anchor) => toTimestamp(anchor.timestamp) >= sinceTime);
    }

    if (untilTime !== null) {
      anchors = anchors.filter((anchor) => toTimestamp(anchor.timestamp) <= untilTime);
    }

    if (needle) {
      anchors = anchors.filter(
        (anchor) =>
          anchor.name.toLowerCase().includes(needle) ||
          anchor.kind.toLowerCase().includes(needle) ||
          (anchor.meta && JSON.stringify(anchor.meta).toLowerCase().includes(needle)),
      );
    }

    if (name) {
      const normalizedName = name.toLowerCase();
      anchors = anchors.filter((anchor) => anchor.name.toLowerCase().includes(normalizedName));
    }

    if (kind) {
      anchors = anchors.filter((anchor) => anchor.kind === kind);
    }

    if (summary) {
      const normalizedSummary = summary.toLowerCase();
      anchors = anchors.filter((anchor) => anchor.meta?.summary?.toLowerCase().includes(normalizedSummary));
    }

    if (purpose) {
      const normalizedPurpose = purpose.toLowerCase();
      anchors = anchors.filter((anchor) => anchor.meta?.purpose?.toLowerCase().includes(normalizedPurpose));
    }

    if (keywords?.length) {
      const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
      anchors = anchors.filter((anchor) => {
        const anchorKeywords = anchor.meta?.keywords?.map((keyword) => keyword.toLowerCase()) ?? [];
        return normalizedKeywords.every((keyword) => anchorKeywords.includes(keyword));
      });
    }

    return anchors.slice(-limit);
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
