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

function sortAnchorsByTimestamp(anchors: TapeAnchor[]): TapeAnchor[] {
  return anchors.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
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

  private getSessionEntryKey(sessionEntryId: string, sessionId?: string): string {
    return `${sessionId ?? "*"}::${sessionEntryId}`;
  }

  append(entry: TapeAnchor): void {
    fs.appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
    this.addToMemoryIndex(entry);
  }

  removeById(id: string): TapeAnchor | null {
    const anchor = this.findById(id);
    if (!anchor) return null;

    this.rebuildIndex(this.allAnchors.filter((entry) => entry.id !== id));
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
    return [...(this.anchorsBySession.get(sessionId) ?? [])];
  }

  findBySessionEntryId(sessionEntryId: string, sessionId?: string): TapeAnchor[] {
    if (sessionId) {
      return [...(this.anchorsBySessionEntry.get(this.getSessionEntryKey(sessionEntryId, sessionId)) ?? [])];
    }

    return this.allAnchors.filter((entry) => entry.sessionEntryId === sessionEntryId);
  }

  getLastAnchor(sessionId?: string): TapeAnchor | null {
    if (sessionId) {
      const sessionAnchors = this.anchorsBySession.get(sessionId) ?? [];
      return sessionAnchors[sessionAnchors.length - 1] ?? null;
    }

    return this.allAnchors[this.allAnchors.length - 1] ?? null;
  }

  getAllAnchors(): TapeAnchor[] {
    return [...this.allAnchors];
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
