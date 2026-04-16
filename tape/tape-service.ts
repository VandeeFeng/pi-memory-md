import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { type AnchorEntry, AnchorIndex } from "./anchor-index.js";
import { getEntriesAfterTimestamp, getSessionFilePath, parseSessionFile } from "./session-reader.js";

export class MemoryTapeService {
  private readonly anchorIndex: AnchorIndex;
  private readonly sessionId: string;
  private readonly cwd: string;
  private sessionManager: { getLeafId: () => string | null; getSessionId: () => string } | null = null;

  constructor(localPath: string, projectName: string, sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.anchorIndex = new AnchorIndex(localPath, projectName);
  }

  static create(localPath: string, projectName: string, sessionId: string, cwd: string): MemoryTapeService {
    return new MemoryTapeService(localPath, projectName, sessionId, cwd);
  }

  setSessionManager(sm: { getLeafId: () => string | null; getSessionId: () => string }): void {
    this.sessionManager = sm;
  }

  recordSessionStart(): string {
    return this.createAnchor("session/start");
  }

  createAnchor(name: string, state?: Record<string, unknown>): string {
    const sessionEntryId = this.sessionManager?.getLeafId() ?? crypto.randomUUID();
    const entryId = crypto.randomUUID();

    const anchorEntry: AnchorEntry = {
      name,
      sessionId: this.sessionId,
      sessionEntryId,
      timestamp: new Date().toISOString(),
      state: state ?? undefined,
    };

    this.anchorIndex.append(anchorEntry);
    return entryId;
  }

  /**
   * Query entries from pi session file
   */
  query(options: {
    query?: string;
    types?: SessionEntry["type"][];
    limit?: number;
    since?: string;
    sinceAnchor?: string;
    lastAnchor?: boolean;
    betweenAnchors?: { start: string; end: string };
    betweenDates?: { start: string; end: string };
  }): SessionEntry[] {
    const { betweenAnchors, betweenDates, types, lastAnchor, limit, query, since, sinceAnchor } = options;

    let startTime: string | null = null;
    let endTime: string | null = null;

    if (betweenAnchors) {
      const startAnchor = this.anchorIndex.findByName(betweenAnchors.start);
      const endAnchor = this.anchorIndex.findByName(betweenAnchors.end);
      if (startAnchor && endAnchor) {
        startTime = startAnchor.timestamp;
        endTime = endAnchor.timestamp;
      }
    } else if (lastAnchor) {
      const anchor = this.anchorIndex.getLastAnchor(this.sessionId);
      if (anchor) startTime = anchor.timestamp;
    } else if (sinceAnchor) {
      const anchor = this.anchorIndex.findByName(sinceAnchor);
      if (anchor) startTime = anchor.timestamp;
    }

    if (betweenDates) {
      startTime = betweenDates.start;
      endTime = betweenDates.end;
    }

    const sessionFile = getSessionFilePath(this.cwd, this.sessionId);
    if (!sessionFile) return [];

    const parsed = parseSessionFile(sessionFile);
    if (!parsed) return [];

    let entries = parsed.entries;

    // Filter by time range
    if (startTime) entries = getEntriesAfterTimestamp(entries, startTime);
    if (endTime) entries = entries.filter((e) => new Date(e.timestamp).getTime() <= new Date(endTime!).getTime());
    if (since) entries = getEntriesAfterTimestamp(entries, since);
    if (types?.length) entries = entries.filter((e) => types.includes(e.type));
    if (query) {
      const needle = query.toLowerCase();
      entries = entries.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
    }
    if (limit) entries = entries.slice(-limit);

    return entries;
  }

  findAnchorByName(name: string): AnchorEntry | null {
    return this.anchorIndex.findByName(name);
  }

  getLastAnchor(): AnchorEntry | null {
    return this.anchorIndex.getLastAnchor(this.sessionId);
  }

  getAnchorIndex(): AnchorIndex {
    return this.anchorIndex;
  }

  getAlwaysInclude(): string[] {
    return [];
  }

  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: AnchorEntry | null;
    entriesSinceLastAnchor: number;
  } {
    const allAnchors = this.anchorIndex.findBySession(this.sessionId);
    const lastAnchor = allAnchors[allAnchors.length - 1] ?? null;

    let entriesSinceLastAnchor = 0;
    if (lastAnchor) {
      const entries = this.query({ sinceAnchor: lastAnchor.name });
      entriesSinceLastAnchor = entries.length;
    }

    return {
      totalEntries: this.query({}).length,
      anchorCount: allAnchors.length,
      lastAnchor,
      entriesSinceLastAnchor,
    };
  }

  getTapeFileCount(): number {
    return 1;
  }

  clear(): void {
    this.anchorIndex.clear();
  }
}

export type { AnchorEntry };
