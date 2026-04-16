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
      const lines = content.trim().split("\n");

      for (const line of lines) {
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

  getLastAnchor(sessionId?: string): AnchorEntry | null {
    if (sessionId) {
      const sessionAnchors = this.findBySession(sessionId);
      return sessionAnchors[sessionAnchors.length - 1] ?? null;
    }

    // Find last anchor across all sessions
    let last: AnchorEntry | null = null;
    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (!last || new Date(entry.timestamp) > new Date(last.timestamp)) last = entry;
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
    let anchors = this.getAllAnchors();

    // Filter by session, time range, and query
    if (sessionId) anchors = anchors.filter((a) => a.sessionId === sessionId);
    if (since) anchors = anchors.filter((a) => new Date(a.timestamp).getTime() >= new Date(since).getTime());
    if (until) anchors = anchors.filter((a) => new Date(a.timestamp).getTime() <= new Date(until).getTime());
    if (query) {
      const needle = query.toLowerCase();
      anchors = anchors.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) || (a.state && JSON.stringify(a.state).toLowerCase().includes(needle)),
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
