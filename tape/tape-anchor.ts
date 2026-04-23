import fs from "node:fs";
import path from "node:path";
import { toTimestamp } from "../utils.js";

export type TapeAnchorKind = "session" | "handoff";

export type TapeAnchorMeta = {
  trigger?: "direct" | "keyword";
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

export class AnchorStore {
  private readonly anchorDir: string;
  private readonly indexPath: string;
  private index: Map<string, TapeAnchor[]> = new Map();

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

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;

        try {
          const rawEntry = JSON.parse(line) as Partial<TapeAnchor>;
          if (
            !rawEntry.name ||
            !rawEntry.kind ||
            !rawEntry.sessionId ||
            !rawEntry.sessionEntryId ||
            !rawEntry.timestamp
          ) {
            continue;
          }

          const entry: TapeAnchor = {
            id: rawEntry.id ?? `${rawEntry.sessionEntryId}:${rawEntry.timestamp}:${rawEntry.name}`,
            name: rawEntry.name,
            kind: rawEntry.kind,
            sessionId: rawEntry.sessionId,
            sessionEntryId: rawEntry.sessionEntryId,
            timestamp: rawEntry.timestamp,
            meta: rawEntry.meta,
          };
          this.addToMemoryIndex(entry);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error, start fresh
    }
  }

  private addToMemoryIndex(entry: TapeAnchor): void {
    const existing = this.index.get(entry.name) ?? [];
    existing.push(entry);
    this.index.set(entry.name, existing);
  }

  append(entry: TapeAnchor): void {
    fs.appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
    this.addToMemoryIndex(entry);
  }

  removeById(id: string): TapeAnchor | null {
    const anchor = this.findById(id);
    if (!anchor) return null;

    const anchors = this.getAllAnchors().filter((entry) => entry.id !== id);
    this.rebuildIndex(anchors);
    return anchor;
  }

  findById(id: string): TapeAnchor | null {
    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.id === id) return entry;
      }
    }

    return null;
  }

  findByName(name: string): TapeAnchor | null {
    const entries = this.index.get(name);
    if (!entries || entries.length === 0) return null;
    return entries[entries.length - 1];
  }

  findByNameInSession(name: string, sessionId: string): TapeAnchor | null {
    const entries = this.index.get(name) ?? [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.sessionId === sessionId) return entry;
    }
    return null;
  }

  findAllByName(name: string): TapeAnchor[] {
    return this.index.get(name) ?? [];
  }

  findBySession(sessionId: string): TapeAnchor[] {
    const result: TapeAnchor[] = [];

    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.sessionId === sessionId) {
          result.push(entry);
        }
      }
    }

    return result.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  }

  findBySessionEntryId(sessionEntryId: string, sessionId?: string): TapeAnchor[] {
    const result: TapeAnchor[] = [];

    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.sessionEntryId !== sessionEntryId) continue;
        if (sessionId && entry.sessionId !== sessionId) continue;
        result.push(entry);
      }
    }

    return result.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  }

  getLastAnchor(sessionId?: string): TapeAnchor | null {
    if (sessionId) {
      const sessionAnchors = this.findBySession(sessionId);
      return sessionAnchors[sessionAnchors.length - 1] ?? null;
    }

    let last: TapeAnchor | null = null;

    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (!last || toTimestamp(entry.timestamp) > toTimestamp(last.timestamp)) {
          last = entry;
        }
      }
    }

    return last;
  }

  getAllAnchors(): TapeAnchor[] {
    const result: TapeAnchor[] = [];

    for (const entries of this.index.values()) {
      result.push(...entries);
    }

    return result.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
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

    let anchors = this.getAllAnchors();

    if (sessionId) {
      anchors = anchors.filter((anchor) => anchor.sessionId === sessionId);
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

  clear(): void {
    if (fs.existsSync(this.indexPath)) {
      fs.unlinkSync(this.indexPath);
    }

    this.index.clear();
  }

  private rebuildIndex(entries: TapeAnchor[]): void {
    this.index.clear();

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
