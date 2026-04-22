import fs from "node:fs";
import path from "node:path";

export interface AnchorEntry {
  name: string;
  sessionId: string;
  sessionEntryId: string;
  timestamp: string;
  state?: Record<string, unknown>;
}

export class AnchorIndex {
  private readonly anchorDir: string;
  private readonly indexPath: string;
  private index: Map<string, AnchorEntry[]> = new Map();

  constructor(localPath: string, projectName: string) {
    this.anchorDir = path.join(localPath, "TAPE", "anchor-index");
    this.indexPath = path.join(this.anchorDir, `${projectName}__anchors.jsonl`);
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
          const entry: AnchorEntry = JSON.parse(line);
          this.addToMemoryIndex(entry);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error, start fresh
    }
  }

  private addToMemoryIndex(entry: AnchorEntry): void {
    const existing = this.index.get(entry.name) ?? [];
    existing.push(entry);
    this.index.set(entry.name, existing);
  }

  append(entry: AnchorEntry): void {
    fs.appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
    this.addToMemoryIndex(entry);
  }

  findByName(name: string): AnchorEntry | null {
    const entries = this.index.get(name);
    if (!entries || entries.length === 0) return null;
    return entries[entries.length - 1];
  }

  findByNameInSession(name: string, sessionId: string): AnchorEntry | null {
    const entries = this.index.get(name) ?? [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.sessionId === sessionId) return entry;
    }
    return null;
  }

  findAllByName(name: string): AnchorEntry[] {
    return this.index.get(name) ?? [];
  }

  findBySession(sessionId: string): AnchorEntry[] {
    const result: AnchorEntry[] = [];

    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.sessionId === sessionId) {
          result.push(entry);
        }
      }
    }

    return result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  findBySessionEntryId(sessionEntryId: string, sessionId?: string): AnchorEntry[] {
    const result: AnchorEntry[] = [];

    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.sessionEntryId !== sessionEntryId) continue;
        if (sessionId && entry.sessionId !== sessionId) continue;
        result.push(entry);
      }
    }

    return result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  getLastAnchor(sessionId?: string): AnchorEntry | null {
    if (sessionId) {
      const sessionAnchors = this.findBySession(sessionId);
      return sessionAnchors[sessionAnchors.length - 1] ?? null;
    }

    let last: AnchorEntry | null = null;

    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (!last || new Date(entry.timestamp).getTime() > new Date(last.timestamp).getTime()) {
          last = entry;
        }
      }
    }

    return last;
  }

  getAllAnchors(): AnchorEntry[] {
    const result: AnchorEntry[] = [];

    for (const entries of this.index.values()) {
      result.push(...entries);
    }

    return result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  search(options: {
    query?: string;
    sessionId?: string;
    limit?: number;
    since?: string;
    until?: string;
  }): AnchorEntry[] {
    const { query, sessionId, limit = 20, since, until } = options;
    const sinceTime = since ? new Date(since).getTime() : null;
    const untilTime = until ? new Date(until).getTime() : null;
    const needle = query?.toLowerCase();

    let anchors = this.getAllAnchors();

    if (sessionId) {
      anchors = anchors.filter((anchor) => anchor.sessionId === sessionId);
    }

    if (sinceTime !== null) {
      anchors = anchors.filter((anchor) => new Date(anchor.timestamp).getTime() >= sinceTime);
    }

    if (untilTime !== null) {
      anchors = anchors.filter((anchor) => new Date(anchor.timestamp).getTime() <= untilTime);
    }

    if (needle) {
      anchors = anchors.filter(
        (anchor) =>
          anchor.name.toLowerCase().includes(needle) ||
          (anchor.state && JSON.stringify(anchor.state).toLowerCase().includes(needle)),
      );
    }

    return anchors.slice(-limit);
  }

  clear(): void {
    if (fs.existsSync(this.indexPath)) {
      fs.unlinkSync(this.indexPath);
    }

    this.index.clear();
  }
}
