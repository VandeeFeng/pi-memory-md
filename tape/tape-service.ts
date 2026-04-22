import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { type AnchorEntry, AnchorIndex } from "./tape-anchor-index.js";
import {
  getEntriesAfterTimestamp,
  getSessionFilePath,
  getSessionFilePaths,
  parseSessionFile,
} from "./tape-session-reader.js";
import type { TapeQueryOptions } from "./tape-types.js";

const DEFAULT_ANCHOR_LABEL_PREFIX = "⚓ ";
const ANCHOR_LABEL_SEPARATOR_BASE = " · ";

type TapeSessionManager = {
  getLeafId: () => string | null;
  getSessionId: () => string;
  getEntry: (id: string) => SessionEntry | undefined;
  getEntries: () => SessionEntry[];
  getLabel: (id: string) => string | undefined;
  labelsById?: Map<string, string>;
  labelTimestampsById?: Map<string, string>;
};

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;

  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      block.text.trim().length > 0,
  );
}

function isTreeVisibleEntry(entry: SessionEntry): boolean {
  if (
    entry.type === "label" ||
    entry.type === "custom" ||
    entry.type === "model_change" ||
    entry.type === "thinking_level_change" ||
    entry.type === "session_info"
  ) {
    return false;
  }

  if (entry.type !== "message") return true;
  if (entry.message.role !== "assistant") return true;
  if (hasTextContent(entry.message.content)) return true;
  if (entry.message.errorMessage) return true;
  return entry.message.stopReason === "aborted";
}

function getAnchorLabelSeparator(labelPrefix: string): string {
  return `${ANCHOR_LABEL_SEPARATOR_BASE}${labelPrefix}`;
}

function stripAnchorLabel(labelPrefix: string, label?: string): string | undefined {
  if (!label) return undefined;
  if (label.startsWith(labelPrefix)) return undefined;

  const baseLabel = label.split(getAnchorLabelSeparator(labelPrefix), 1)[0].trim();
  return baseLabel || undefined;
}

function mergeAnchorLabel(labelPrefix: string, existingLabel: string | undefined, anchorLabel: string): string {
  const baseLabel = stripAnchorLabel(labelPrefix, existingLabel);
  if (!baseLabel) return anchorLabel;
  return `${baseLabel}${getAnchorLabelSeparator(labelPrefix)}${anchorLabel.slice(labelPrefix.length)}`;
}

export class MemoryTapeService {
  private readonly anchorIndex: AnchorIndex;
  private readonly sessionId: string;
  private readonly cwd: string;
  private sessionManager: TapeSessionManager | null = null;
  private anchorLabelPrefix = DEFAULT_ANCHOR_LABEL_PREFIX;

  constructor(tapeBasePath: string, projectName: string, sessionId: string, cwd: string) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.anchorIndex = new AnchorIndex(tapeBasePath, projectName);
  }

  static create(tapeBasePath: string, projectName: string, sessionId: string, cwd: string): MemoryTapeService {
    return new MemoryTapeService(tapeBasePath, projectName, sessionId, cwd);
  }

  configureSessionTree(sm: TapeSessionManager, prefix?: string): void {
    const nextPrefix = prefix && prefix.trim().length > 0 ? prefix : DEFAULT_ANCHOR_LABEL_PREFIX;

    if (this.sessionManager && this.anchorLabelPrefix !== nextPrefix) {
      this.clearAnchorTreeLabels(this.anchorLabelPrefix);
    }

    this.sessionManager = sm;
    this.anchorLabelPrefix = nextPrefix;
    this.syncSessionTreeLabels();
  }

  recordSessionStart(): AnchorEntry {
    return this.createAnchor("session/start");
  }

  createAnchor(name: string, state?: Record<string, unknown>): AnchorEntry {
    const sessionEntryId = this.sessionManager?.getLeafId() ?? crypto.randomUUID();
    const anchorEntry: AnchorEntry = {
      name,
      sessionId: this.sessionId,
      sessionEntryId,
      timestamp: new Date().toISOString(),
      state: state ?? undefined,
    };

    this.anchorIndex.append(anchorEntry);
    this.syncTreeLabel(sessionEntryId);
    return anchorEntry;
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

  private buildAnchorLabel(anchors: AnchorEntry[]): string | null {
    if (anchors.length === 0) return null;

    const names = [...new Set(anchors.map((anchor) => anchor.name))];
    const visibleNames = names.slice(-3);
    const suffix = names.length > visibleNames.length ? ` +${names.length - visibleNames.length}` : "";
    return `${this.anchorLabelPrefix}${visibleNames.join(" · ")}${suffix}`;
  }

  private getLabelMaps(): { labelsById: Map<string, string>; labelTimestampsById: Map<string, string> } | null {
    if (!this.sessionManager?.labelsById || !this.sessionManager.labelTimestampsById) return null;
    return {
      labelsById: this.sessionManager.labelsById,
      labelTimestampsById: this.sessionManager.labelTimestampsById,
    };
  }

  private setTreeLabel(entryId: string, label: string | undefined, timestamp?: string): void {
    const maps = this.getLabelMaps();
    if (!maps) return;

    if (label) {
      maps.labelsById.set(entryId, label);
      maps.labelTimestampsById.set(entryId, timestamp ?? new Date().toISOString());
      return;
    }

    maps.labelsById.delete(entryId);
    maps.labelTimestampsById.delete(entryId);
  }

  private getAnchorLabelTargetEntryIds(): string[] {
    if (!this.sessionManager) return [];

    const targetEntryIds = new Set<string>();
    for (const anchor of this.anchorIndex.findBySession(this.sessionId)) {
      const targetEntryId = this.resolveTreeLabelTarget(anchor.sessionEntryId);
      if (targetEntryId) {
        targetEntryIds.add(targetEntryId);
      }
    }

    return [...targetEntryIds];
  }

  private clearAnchorTreeLabels(labelPrefix = this.anchorLabelPrefix): void {
    if (!this.sessionManager) return;

    for (const entryId of this.getAnchorLabelTargetEntryIds()) {
      const label = this.sessionManager.getLabel(entryId);
      this.setTreeLabel(entryId, stripAnchorLabel(labelPrefix, label));
    }
  }

  private resolveTreeLabelTarget(sessionEntryId: string): string | null {
    if (!this.sessionManager) return null;

    const rootEntry = this.sessionManager.getEntry(sessionEntryId);
    if (!rootEntry) return null;
    if (isTreeVisibleEntry(rootEntry)) return rootEntry.id;

    const childMap = new Map<string, SessionEntry[]>();
    for (const entry of this.sessionManager.getEntries()) {
      if (!entry.parentId) continue;
      const children = childMap.get(entry.parentId) ?? [];
      children.push(entry);
      childMap.set(entry.parentId, children);
    }

    const queue = [...(childMap.get(rootEntry.id) ?? [])];
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) continue;
      if (isTreeVisibleEntry(entry)) return entry.id;
      queue.push(...(childMap.get(entry.id) ?? []));
    }

    let currentId = rootEntry.parentId;
    while (currentId) {
      const entry = this.sessionManager.getEntry(currentId);
      if (!entry) break;
      if (isTreeVisibleEntry(entry)) return entry.id;
      currentId = entry.parentId;
    }

    return rootEntry.id;
  }

  private syncTreeLabel(sessionEntryId: string): void {
    if (!this.sessionManager) return;

    const targetEntryId = this.resolveTreeLabelTarget(sessionEntryId);
    if (!targetEntryId) return;

    const anchors = this.anchorIndex.findBySessionEntryId(sessionEntryId, this.sessionId);
    const anchorLabel = this.buildAnchorLabel(anchors);
    const existingLabel = this.sessionManager.getLabel(targetEntryId);
    this.setTreeLabel(
      targetEntryId,
      anchorLabel
        ? mergeAnchorLabel(this.anchorLabelPrefix, existingLabel, anchorLabel)
        : stripAnchorLabel(this.anchorLabelPrefix, existingLabel),
      anchors[anchors.length - 1]?.timestamp,
    );
  }

  private syncSessionTreeLabels(): void {
    if (!this.sessionManager) return;

    this.clearAnchorTreeLabels();
    for (const anchor of this.anchorIndex.findBySession(this.sessionId)) {
      this.syncTreeLabel(anchor.sessionEntryId);
    }
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
    this.clearAnchorTreeLabels();
    this.anchorIndex.clear();
  }
}

export type { AnchorEntry };
