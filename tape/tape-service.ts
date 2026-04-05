import { randomUUID } from "node:crypto";
import type { TapeConfig, TapeEntry, TapeEntryKind } from "./tape-types.js";
import { MemoryTapeStore } from "./tape-store.js";

export class MemoryTapeService {
  private currentTurn = 0;

  constructor(
    private store: MemoryTapeStore,
    private alwaysInclude: Set<string>,
    private sessionId?: string,
  ) {}

  static create(
    memoryDir: string,
    config?: TapeConfig,
    workspace?: string,
    sessionId?: string,
  ): MemoryTapeService {
    const store = new MemoryTapeStore(memoryDir, config?.tapePath, workspace, sessionId);
    const alwaysInclude = new Set(config?.context?.alwaysInclude ?? []);
    return new MemoryTapeService(store, alwaysInclude, sessionId);
  }

  record(kind: TapeEntryKind, payload: Record<string, unknown>, turn?: number): string {
    const entry: TapeEntry = {
      id: randomUUID(),
      kind,
      timestamp: new Date().toISOString(),
      turn,
      payload,
    };
    this.store.append(entry);
    return entry.id;
  }

  recordSessionStart(): string {
    this.currentTurn = 0;
    return this.record("session/start", { sessionId: this.sessionId ?? "unknown", name: "INIT" });
  }

  startNewTurn(): void {
    this.currentTurn++;
  }

  recordUserMessage(content: string): string {
    return this.record("message/user", { content }, this.currentTurn);
  }

  recordAssistantMessage(content: string): string {
    return this.record("message/assistant", { content }, this.currentTurn);
  }

  recordToolCall(tool: string, args: Record<string, unknown>): string {
    return this.record("tool_call", { tool, args }, this.currentTurn);
  }

  recordToolResult(tool: string, result: unknown): string {
    return this.record("tool_result", { tool, result }, this.currentTurn);
  }

  createAnchor(name: string, state?: Record<string, unknown>): string {
    return this.record("anchor", { anchorId: randomUUID(), name, state: state ?? null });
  }

  clear(): void {
    this.store.clear();
    this.currentTurn = 0;
  }

  recordMemoryRead(path: string): void {
    this.record("memory/read", { path });
  }

  recordMemoryWrite(path: string, frontmatter: Record<string, unknown>): void {
    this.record("memory/write", { path, frontmatter });
  }

  recordMemorySearch(query: string, searchIn: string, count: number): void {
    this.record("memory/search", { query, searchIn, count });
  }

  recordMemorySync(action: string, result: Record<string, unknown>): void {
    this.record("memory/sync", { action, result });
  }

  recordMemoryInit(force: boolean): void {
    this.record("memory/init", { force });
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
    return this.store.query(options);
  }

  findAnchorByName(name: string): TapeEntry | null {
    const entries = this.store.query({ kinds: ["anchor", "session/start"] });
    return entries.find((e) => e.payload.name === name) || null;
  }

  getEntriesAfterLastAnchor(): TapeEntry[] {
    return this.store.query({ lastAnchor: true });
  }

  getEntriesBetweenAnchors(startAnchor: string, endAnchor: string): TapeEntry[] {
    return this.store.query({ betweenAnchors: { start: startAnchor, end: endAnchor } });
  }

  searchEntries(query: string, limit?: number): TapeEntry[] {
    return this.store.query({ query, limit });
  }

  getEntriesSince(anchorId?: string): TapeEntry[] {
    return this.store.query({ sinceAnchor: anchorId });
  }

  getRecentEntries(count: number): TapeEntry[] {
    return this.store.query({ limit: count });
  }

  getEntriesByTurn(turn: number): TapeEntry[] {
    return this.store.query({}).filter((e) => e.turn === turn);
  }

  getLastAnchor(): TapeEntry | null {
    return this.store.getLastAnchor();
  }

  getAlwaysInclude(): string[] {
    return Array.from(this.alwaysInclude);
  }

  getInfo(): {
    totalEntries: number;
    anchorCount: number;
    lastAnchor: TapeEntry | null;
    entriesSinceLastAnchor: number;
    memoryReads: number;
    memoryWrites: number;
  } {
    const entries = this.query({});
    const anchors = entries.filter((e) => e.kind === "anchor" || e.kind === "session/start");
    const lastAnchor = anchors.at(-1) ?? null;
    const lastAnchorIdx = lastAnchor ? entries.indexOf(lastAnchor) : -1;
    const entriesSinceLastAnchor = lastAnchorIdx >= 0 ? entries.length - lastAnchorIdx - 1 : entries.length;

    return {
      totalEntries: entries.length,
      anchorCount: anchors.length,
      lastAnchor,
      entriesSinceLastAnchor,
      memoryReads: entries.filter((e) => e.kind === "memory/read").length,
      memoryWrites: entries.filter((e) => e.kind === "memory/write").length,
    };
  }

  getTapeFileCount(): number {
    return this.store.getTapeFileCount();
  }
}
