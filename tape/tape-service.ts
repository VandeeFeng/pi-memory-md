import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { type AnchorEntry, AnchorIndex } from "./anchor-index.js";
import {
  getEntriesAfterTimestamp,
  getSessionFilePath,
  getSessionFilePaths,
  parseSessionFile,
} from "./session-reader.js";
import type { TapeQueryOptions } from "./tape-types.js";

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

  private resolveAnchor(name: string, anchorScope: "current-session" | "project"): AnchorEntry | null {
    if (anchorScope === "current-session") {
      return this.anchorIndex.findByNameInSession(name, this.sessionId) ?? this.anchorIndex.findByName(name);
    }

    return this.anchorIndex.findByName(name);
  }

  private loadEntries(scope: "session" | "project"): SessionEntry[] {
    if (scope === "session") {
      const sessionFile = getSessionFilePath(this.cwd, this.sessionId);
      if (!sessionFile) return [];
      const parsed = parseSessionFile(sessionFile);
      return parsed?.entries ?? [];
    }

    const entries: SessionEntry[] = [];
    for (const sessionFile of getSessionFilePaths(this.cwd)) {
      const parsed = parseSessionFile(sessionFile);
      if (!parsed) continue;
      entries.push(...parsed.entries);
    }

    return entries.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  }

  query(options: TapeQueryOptions & { since?: string }): SessionEntry[] {
    const {
      betweenAnchors,
      betweenDates,
      types,
      lastAnchor,
      limit,
      query,
      since,
      sinceAnchor,
      scope = "project",
      anchorScope = "current-session",
    } = options;

    let startTime: string | null = null;
    let endTime: string | null = null;

    if (betweenAnchors) {
      const startAnchor = this.resolveAnchor(betweenAnchors.start, anchorScope);
      const endAnchor = this.resolveAnchor(betweenAnchors.end, anchorScope);

      if (startAnchor && endAnchor) {
        startTime = startAnchor.timestamp;
        endTime = endAnchor.timestamp;
      }
    } else if (lastAnchor) {
      const anchor =
        anchorScope === "project" ? this.anchorIndex.getLastAnchor() : this.anchorIndex.getLastAnchor(this.sessionId);
      if (anchor) startTime = anchor.timestamp;
    } else if (sinceAnchor) {
      const anchor = this.resolveAnchor(sinceAnchor, anchorScope);
      if (anchor) startTime = anchor.timestamp;
    }

    if (betweenDates) {
      startTime = betweenDates.start;
      endTime = betweenDates.end;
    }

    let entries = this.loadEntries(scope);

    if (startTime) {
      entries = getEntriesAfterTimestamp(entries, startTime);
    }

    if (endTime) {
      const endTimestamp = new Date(endTime).getTime();
      entries = entries.filter((entry) => new Date(entry.timestamp).getTime() <= endTimestamp);
    }

    if (since) {
      entries = getEntriesAfterTimestamp(entries, since);
    }

    if (types?.length) {
      entries = entries.filter((entry) => types.includes(entry.type));
    }

    if (query) {
      const needle = query.toLowerCase();
      entries = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
    }

    if (limit) {
      entries = entries.slice(-limit);
    }

    return entries;
  }

  findAnchorByName(name: string, anchorScope: "current-session" | "project" = "current-session"): AnchorEntry | null {
    return this.resolveAnchor(name, anchorScope);
  }

  getLastAnchor(anchorScope: "current-session" | "project" = "current-session"): AnchorEntry | null {
    if (anchorScope === "project") {
      return this.anchorIndex.getLastAnchor();
    }

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
      const entries = this.query({ sinceAnchor: lastAnchor.name, scope: "session", anchorScope: "current-session" });
      entriesSinceLastAnchor = entries.length;
    }

    return {
      totalEntries: this.query({ scope: "session" }).length,
      anchorCount: allAnchors.length,
      lastAnchor,
      entriesSinceLastAnchor,
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTapeFileCount(): number {
    return getSessionFilePaths(this.cwd).length;
  }

  clear(): void {
    this.anchorIndex.clear();
  }
}

export type { AnchorEntry };
