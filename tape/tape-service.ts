import { randomUUID } from "node:crypto";
import { MemoryTapeStore } from "./tape-store.js";
import type { TapeConfig, TapeEntry, TapeEntryKind } from "./tape-types.js";

export class MemoryTapeService {
  private currentTurn = 0;

  constructor(
    private store: MemoryTapeStore,
    private alwaysInclude: Set<string>,
    private sessionId?: string,
  ) {}

  static create(memoryDir: string, config?: TapeConfig, workspace?: string, sessionId?: string): MemoryTapeService {
    const store = new MemoryTapeStore(memoryDir, config?.tapePath, workspace, sessionId);
    const alwaysInclude = new Set(config?.context?.alwaysInclude ?? []);
    return new MemoryTapeService(store, alwaysInclude, sessionId);
  }

  // --- Recording methods ---

  private record(kind: TapeEntryKind, payload: Record<string, unknown>, turn?: number): string {
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

  // --- Query methods (delegate to store) ---

  query(options: Parameters<MemoryTapeStore["query"]>[0]): TapeEntry[] {
    return this.store.query(options);
  }

  findAnchorByName(name: string): TapeEntry | null {
    return this.store.findAnchorByName(name);
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

    return {
      totalEntries: entries.length,
      anchorCount: anchors.length,
      lastAnchor,
      entriesSinceLastAnchor: lastAnchorIdx >= 0 ? entries.length - lastAnchorIdx - 1 : entries.length,
      memoryReads: entries.filter((e) => e.kind === "memory/read").length,
      memoryWrites: entries.filter((e) => e.kind === "memory/write").length,
    };
  }

  getTapeFileCount(): number {
    return this.store.getTapeFileCount();
  }

  clear(): void {
    this.store.clear();
    this.currentTurn = 0;
  }
}
