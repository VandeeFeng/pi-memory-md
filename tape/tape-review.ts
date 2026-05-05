import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { formatCommitTimestamp } from "../utils.js";
import type { TapeAnchor } from "./tape-anchor.js";
import { getSessionFilePath, parseSessionFile } from "./tape-reader.js";
import type { TapeService } from "./tape-service.js";

export const DEFAULT_MEMORY_REVIEW_LIMIT = 50;
export const MAX_TAPE_REVIEW_LIMIT = 100;

const BAR_WIDTH = 10;
const FRAME_PADDING = 1;
const OVERLAY_HEIGHT_RATIO = 0.8;
const OVERLAY_MIN_HEIGHT = 12;
const OVERLAY_CHROME_LINES = 8;
const VIEW_MODES: ViewMode[] = ["timeline", "relations", "stats"];

type ReviewStats = {
  purposes: Map<string, number>;
  keywords: Map<string, number>;
  triggers: Map<string, number>;
};

type ReviewData = {
  anchors: TapeAnchor[];
  stats: ReviewStats;
};

type ViewMode = "timeline" | "relations" | "stats";
type FrameLine = { text: string; width: number; paddingX: number };
type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

function countValue(map: Map<string, number>, value: string | undefined): void {
  const key = value?.trim() || "unset";
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function normalizeMemoryReviewLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_MEMORY_REVIEW_LIMIT;
  return Math.min(Math.floor(limit), MAX_TAPE_REVIEW_LIMIT);
}

function buildReviewData(tapeService: TapeService, entryScope: "session" | "project", limit: number): ReviewData {
  const scopedAnchors = tapeService
    .getAnchorStore()
    .scan(entryScope === "session" ? { sessionId: tapeService.getSessionId() } : {});
  const anchors = scopedAnchors.filter((anchor) => anchor.type !== "session").slice(-limit);
  const stats: ReviewStats = { purposes: new Map(), keywords: new Map(), triggers: new Map() };

  for (const anchor of anchors) {
    countValue(stats.purposes, anchor.meta?.purpose);
    countValue(stats.triggers, anchor.meta?.trigger);
    for (const keyword of anchor.meta?.keywords ?? ["unset"]) countValue(stats.keywords, keyword);
  }

  return { anchors, stats };
}

function sortedStats(values: Map<string, number>): Array<[string, number]> {
  return [...values.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function bar(value: number, max: number): string {
  const size = max > 0 ? Math.max(1, Math.round((value / max) * BAR_WIDTH)) : 0;
  return `${"█".repeat(size)}${" ".repeat(BAR_WIDTH - size)}`;
}

function getAnchorSearchText(anchor: TapeAnchor): string {
  return [
    anchor.name,
    anchor.timestamp,
    anchor.type,
    anchor.meta?.summary,
    anchor.meta?.purpose,
    anchor.meta?.trigger,
    ...(anchor.meta?.keywords ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

class TapeReviewOverlay implements Component, Focusable {
  private view: ViewMode = "timeline";
  private selectedByView: Record<ViewMode, number>;
  private selectedRelationIndex = 0;
  private searchInputActive = false;
  private searchQuery = "";
  private readonly searchInput = new Input();
  private scrollOffsetByView: Record<ViewMode, number> = { timeline: 0, relations: 0, stats: 0 };
  private cachedWidth?: number;
  private cachedBodyLines?: number;
  private cachedLines?: string[];

  constructor(
    private readonly data: ReviewData,
    private readonly theme: Theme,
    private readonly onClose: () => void,
    private readonly onOpenAnchor: (anchor: TapeAnchor) => void,
    private readonly getBodyLines: () => number,
  ) {
    const newestAnchorIndex = Math.max(0, this.data.anchors.length - 1);
    this.selectedByView = { timeline: newestAnchorIndex, relations: 0, stats: 0 };
    this.selectedRelationIndex = 0;
    this.searchInput.onEscape = () => this.clearSearch();
    this.searchInput.onSubmit = () => this.openSelectedAnchor();
  }

  get focused(): boolean {
    return this.searchInput.focused;
  }

  set focused(value: boolean) {
    this.searchInput.focused = value && this.searchInputActive;
  }

  handleInput(data: string): void {
    if (this.searchInputActive) {
      this.handleSearchInput(data);
      return;
    }
    if (data === "/") {
      this.openSearchInput();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.searchQuery) {
        this.clearSearch();
        return;
      }
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelectedAnchor();
      return;
    }
    if (matchesKey(data, Key.left)) this.view = this.previousView();
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.view = this.nextView();
    if (this.view === "relations" && data === "h") this.moveRelationKeyword(-1);
    if (this.view === "relations" && data === "l") this.moveRelationKeyword(1);
    if (this.view !== "stats" && (matchesKey(data, Key.up) || data === "k")) this.moveSelection(-1);
    if (this.view !== "stats" && (matchesKey(data, Key.down) || data === "j")) this.moveSelection(1);
    if (matchesKey(data, Key.home)) this.scrollOffsetByView[this.view] = 0;
    if (matchesKey(data, Key.end)) this.scrollOffsetByView[this.view] = Number.MAX_SAFE_INTEGER;
    this.invalidate();
  }

  render(width: number): string[] {
    const bodyLineCount = this.getBodyLines();
    if (this.cachedLines && this.cachedWidth === width && this.cachedBodyLines === bodyLineCount)
      return this.cachedLines;

    const frameWidth = Math.max(1, width - 2);
    const contentWidth = Math.max(1, frameWidth - FRAME_PADDING * 2);
    const bodyContent = this.renderBody(contentWidth);
    const visibleBodyContent = this.sliceScrollableBody(bodyContent, bodyLineCount, contentWidth);
    const bodyLines: FrameLine[] = [
      ...this.headerArea(frameWidth, contentWidth),
      { text: "─".repeat(frameWidth), width: frameWidth, paddingX: 0 },
      ...visibleBodyContent.map((text) => ({ text, width: contentWidth, paddingX: FRAME_PADDING })),
      { text: "─".repeat(frameWidth), width: frameWidth, paddingX: 0 },
      { text: this.detail(contentWidth), width: contentWidth, paddingX: FRAME_PADDING },
    ];
    const lines = [
      this.topBorder(frameWidth),
      ...bodyLines.map((line) => this.borderLine(line.text, line.width, line.paddingX)),
      this.bottomBorder(frameWidth),
    ];

    this.cachedWidth = width;
    this.cachedBodyLines = bodyLineCount;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width, "…", true));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedBodyLines = undefined;
    this.cachedLines = undefined;
  }

  private headerArea(frameWidth: number, contentWidth: number): FrameLine[] {
    const title = this.theme.fg("toolTitle", this.theme.bold("Memory Review"));
    const tabs = this.viewTabs(frameWidth);
    const hint = this.navigationHint(contentWidth);

    if (!this.searchInputActive) {
      return [
        { text: this.placeCenter(title, frameWidth), width: frameWidth, paddingX: 0 },
        { text: tabs, width: frameWidth, paddingX: 0 },
        { text: hint, width: contentWidth, paddingX: FRAME_PADDING },
      ];
    }

    const searchLine = this.searchInput.render(contentWidth)[0] ?? "";
    return [
      { text: this.placeCenter(title, frameWidth), width: frameWidth, paddingX: 0 },
      { text: tabs, width: frameWidth, paddingX: 0 },
      {
        text: this.theme.fg("accent", truncateToWidth(searchLine, contentWidth, "…", true)),
        width: contentWidth,
        paddingX: FRAME_PADDING,
      },
    ];
  }

  private viewTabs(width: number): string {
    let line = "";
    for (let index = 0; index < VIEW_MODES.length; index++) {
      const view = VIEW_MODES[index]!;
      const label = view === this.view ? this.theme.fg("accent", `[${view}]`) : this.theme.fg("muted", view);
      const center = Math.floor(((index * 2 + 1) * width) / (VIEW_MODES.length * 2));
      const start = Math.max(0, center - Math.floor(visibleWidth(label) / 2));
      line += " ".repeat(Math.max(1, start - visibleWidth(line))) + label;
    }
    return truncateToWidth(line.trimEnd(), width, "…", true);
  }

  private navigationHint(width: number): string {
    const keywordHint = this.view === "relations" ? " · h/l keyword" : "";
    const searchHint = this.searchQuery ? ` · /${this.searchQuery}` : " · / search";
    return this.placeCenter(
      this.theme.fg(
        "muted",
        `←/→/tab switch · ↑/↓/j/k select${keywordHint} · enter open${searchHint} · q/ctrl+c close`,
      ),
      width,
    );
  }

  private topBorder(width: number): string {
    return `┌${"─".repeat(width)}┐`;
  }

  private bottomBorder(width: number): string {
    return `└${"─".repeat(width)}┘`;
  }

  private borderLine(line: string, width: number, paddingX: number): string {
    const content = truncateToWidth(line, width, "…", true);
    const padding = Math.max(0, width - visibleWidth(content));
    const inset = " ".repeat(paddingX);
    return `│${inset}${content}${" ".repeat(padding)}${inset}│`;
  }

  private placeCenter(text: string, width: number): string {
    const content = truncateToWidth(text, width, "…", false);
    const left = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
    return `${" ".repeat(left)}${content}`;
  }

  private renderBody(width: number): string[] {
    if (this.data.anchors.length === 0) return [this.theme.fg("muted", "No tape anchors found.")];

    const searchAnchors = this.getSearchAnchors();
    if (searchAnchors.length === 0) return [this.theme.fg("muted", `No anchors match /${this.searchQuery}`)];

    this.clampSelection();
    if (this.view === "relations") return this.renderRelations(width);
    if (this.view === "stats") return this.renderStats(width);
    return this.renderTimeline(width);
  }

  private sliceScrollableBody(lines: string[], height: number, width: number): string[] {
    const maxOffset = Math.max(0, lines.length - height);
    const offset = Math.min(maxOffset, Math.max(0, this.scrollOffsetByView[this.view]));
    this.scrollOffsetByView[this.view] = offset;

    const visibleLines = lines.slice(offset, offset + height);
    while (visibleLines.length < height) visibleLines.push("");

    const indicatorText = this.selectionIndicator();
    if (maxOffset > 0 && indicatorText) {
      const indicator = this.theme.fg("dim", indicatorText);
      const lastIndex = visibleLines.length - 1;
      const baseLine = truncateToWidth(
        visibleLines[lastIndex],
        Math.max(1, width - visibleWidth(indicator) - 1),
        "",
        true,
      );
      const gap = " ".repeat(Math.max(1, width - visibleWidth(baseLine) - visibleWidth(indicator)));
      visibleLines[lastIndex] = `${baseLine}${gap}${indicator}`;
    }

    return visibleLines;
  }

  private selectionIndicator(): string | null {
    if (this.view === "stats") return null;

    const visibleAnchors = this.getVisibleAnchors();
    const selectedAnchor = this.getSelectedAnchor();
    if (!selectedAnchor) return null;

    const selectedIndex =
      this.view === "relations" ? this.selectedRelationIndex : visibleAnchors.indexOf(selectedAnchor);
    if (selectedIndex < 0 || visibleAnchors.length === 0) return null;

    return `${selectedIndex + 1}/${visibleAnchors.length}`;
  }

  private renderTimeline(width: number): string[] {
    const example = this.theme.fg("muted", "Format: anchor-name [purpose]/[keyword] yyyy-MM-dd-HHmm");
    const rows = this.getTimelineAnchors().map((anchor) => {
      const index = this.data.anchors.indexOf(anchor);
      const pointer =
        index === this.selectedByView.timeline ? this.theme.fg("accent", "●") : this.theme.fg("muted", "○");
      const purpose = anchor.meta?.purpose || "unset";
      const keywords = anchor.meta?.keywords?.join(",") || "unset";
      const purposeText = `[${this.theme.fg("warning", purpose)}]`;
      const keywordText = `[${this.theme.fg("warning", keywords)}]`;
      const timestamp = this.theme.fg("dim", formatCommitTimestamp(new Date(anchor.timestamp)));
      return truncateToWidth(`${pointer} ${anchor.name} ${purposeText}/${keywordText} ${timestamp}`, width, "…", true);
    });
    return [example, "", ...rows];
  }

  private renderRelations(width: number): string[] {
    const lines = ["Keywords", ""];
    let relationIndex = 0;
    for (const [keyword, anchors] of this.getRelationGroups()) {
      lines.push(this.theme.fg("warning", keyword));
      for (const anchor of anchors) {
        const selected =
          relationIndex === this.selectedRelationIndex ? this.theme.fg("accent", "●") : this.theme.fg("muted", "○");
        const purpose = this.theme.fg("warning", anchor.meta?.purpose || "unset");
        const timestamp = this.theme.fg("dim", formatCommitTimestamp(new Date(anchor.timestamp)));
        lines.push(`  ${selected} ${anchor.name} [${purpose}] ${timestamp}`);
        relationIndex += 1;
      }
    }

    return lines.map((line) => truncateToWidth(line, width, "…", true));
  }

  private getRelationGroups(): Array<[string, TapeAnchor[]]> {
    const groups = new Map<string, TapeAnchor[]>();

    for (const anchor of this.getSearchAnchors()) {
      for (const keyword of anchor.meta?.keywords ?? ["unset"]) {
        const anchors = groups.get(keyword) ?? [];
        anchors.push(anchor);
        groups.set(keyword, anchors);
      }
    }

    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([keyword, anchors]) => [
        keyword,
        anchors.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)),
      ]);
  }

  private getTimelineAnchors(): TapeAnchor[] {
    return [...this.getSearchAnchors()].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  }

  private getSearchAnchors(): TapeAnchor[] {
    return fuzzyFilter(this.data.anchors, this.searchQuery, getAnchorSearchText);
  }

  private getVisibleAnchors(): TapeAnchor[] {
    switch (this.view) {
      case "timeline":
        return this.getTimelineAnchors();
      case "relations":
        return this.getRelationGroups().flatMap(([, anchors]) => anchors);
      case "stats":
        return this.getSearchAnchors();
    }
  }

  private getSelectedAnchor(): TapeAnchor | undefined {
    if (this.view === "stats") return undefined;

    const visibleAnchors = this.getVisibleAnchors();
    if (this.view === "relations") return visibleAnchors[this.selectedRelationIndex];

    const anchor = this.data.anchors[this.selectedByView[this.view]];
    return visibleAnchors.includes(anchor) ? anchor : visibleAnchors[0];
  }

  private moveSelection(delta: -1 | 1): void {
    const visibleAnchors = this.getVisibleAnchors();
    if (visibleAnchors.length === 0) return;

    if (this.view === "relations") {
      this.selectedRelationIndex = (this.selectedRelationIndex + delta + visibleAnchors.length) % visibleAnchors.length;
      this.selectedByView.relations = this.data.anchors.indexOf(visibleAnchors[this.selectedRelationIndex]!);
      this.ensureSelectedVisible();
      return;
    }

    const selectedAnchor = this.data.anchors[this.selectedByView[this.view]];
    const visibleIndex = Math.max(0, visibleAnchors.indexOf(selectedAnchor));
    const nextIndex = (visibleIndex + delta + visibleAnchors.length) % visibleAnchors.length;
    const nextAnchor = visibleAnchors[nextIndex];
    if (!nextAnchor) return;

    this.selectedByView[this.view] = this.data.anchors.indexOf(nextAnchor);
    this.ensureSelectedVisible();
  }

  private moveRelationKeyword(delta: -1 | 1): void {
    const groups = this.getRelationGroups();
    if (groups.length === 0) return;

    let cursor = 0;
    const groupStarts = groups.map(([, anchors]) => {
      const start = cursor;
      cursor += anchors.length;
      return start;
    });
    let groupIndex = 0;
    for (let index = 0; index < groupStarts.length; index++) {
      if ((groupStarts[index] ?? 0) <= this.selectedRelationIndex) groupIndex = index;
    }
    this.selectedRelationIndex = groupStarts[(groupIndex + delta + groups.length) % groups.length] ?? 0;

    const visibleAnchors = this.getVisibleAnchors();
    const nextAnchor = visibleAnchors[this.selectedRelationIndex];
    if (nextAnchor) this.selectedByView.relations = this.data.anchors.indexOf(nextAnchor);
    this.ensureSelectedVisible();
  }

  private ensureSelectedVisible(): void {
    const selectedLine = this.getSelectedLineIndex();
    if (selectedLine === null) return;

    const height = this.getBodyLines();
    const offset = this.scrollOffsetByView[this.view];

    if (selectedLine < offset) {
      this.scrollOffsetByView[this.view] = Math.max(0, selectedLine - this.getSelectionTopContext());
      return;
    }

    if (selectedLine >= offset + height) this.scrollOffsetByView[this.view] = selectedLine - height + 1;
  }

  private getSelectionTopContext(): number {
    if (this.view === "timeline") return 2;
    if (this.view === "relations") return 3;
    return 0;
  }

  private getSelectedLineIndex(): number | null {
    const selectedAnchor = this.getSelectedAnchor();
    if (!selectedAnchor) return null;

    if (this.view === "timeline") {
      const anchorIndex = this.getTimelineAnchors().indexOf(selectedAnchor);
      return anchorIndex >= 0 ? anchorIndex + 2 : null;
    }

    if (this.view === "relations") {
      let anchorIndex = 0;
      let lineIndex = 2;
      for (const [, anchors] of this.getRelationGroups()) {
        lineIndex += 1;
        if (this.selectedRelationIndex < anchorIndex + anchors.length) {
          return lineIndex + this.selectedRelationIndex - anchorIndex;
        }
        anchorIndex += anchors.length;
        lineIndex += anchors.length;
      }
    }

    return null;
  }

  private openSearchInput(): void {
    this.searchInputActive = true;
    this.searchInput.focused = true;
    this.searchInput.setValue(this.searchQuery);
    this.invalidate();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelectedAnchor();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.clearSearch();
      return;
    }

    const previousQuery = this.searchQuery;
    this.searchInput.handleInput(data);

    this.searchQuery = this.searchInput.getValue();
    if (this.searchQuery !== previousQuery) {
      this.clampSelection();
      this.scrollOffsetByView[this.view] = 0;
    }
    this.invalidate();
  }

  private openSelectedAnchor(): void {
    const anchor = this.getSelectedAnchor();
    if (anchor) this.onOpenAnchor(anchor);
  }

  private clearSearch(): void {
    this.searchInputActive = false;
    this.searchInput.focused = false;
    this.searchQuery = "";
    this.searchInput.setValue("");
    this.clampSelection();
    this.scrollOffsetByView[this.view] = 0;
    this.invalidate();
  }

  private clampSelection(visibleAnchors = this.getVisibleAnchors()): void {
    if (visibleAnchors.length === 0) return;

    if (this.view === "relations") {
      this.selectedRelationIndex = Math.min(this.selectedRelationIndex, visibleAnchors.length - 1);
      const selectedAnchor = visibleAnchors[this.selectedRelationIndex];
      if (selectedAnchor) this.selectedByView.relations = this.data.anchors.indexOf(selectedAnchor);
      return;
    }

    const selectedAnchor = this.getSelectedAnchor();
    const nextAnchor = selectedAnchor && visibleAnchors.includes(selectedAnchor) ? selectedAnchor : visibleAnchors[0];
    this.selectedByView[this.view] = this.data.anchors.indexOf(nextAnchor);
  }

  private renderStats(width: number): string[] {
    const separator = " │ ";
    const columnWidth = Math.max(18, Math.floor((width - visibleWidth(separator) * 2) / 3));
    const columns = [
      ["Purposes", "", ...this.renderStatGroup(this.data.stats.purposes, columnWidth)],
      ["Triggers", "", ...this.renderStatGroup(this.data.stats.triggers, columnWidth)],
      ["Keywords", "", ...this.renderStatGroup(this.data.stats.keywords, columnWidth)],
    ];
    const rowCount = Math.max(...columns.map((column) => column.length));
    const lines: string[] = [];

    for (let row = 0; row < rowCount; row++) {
      const left = this.fitCell(columns[0]?.[row] ?? "", columnWidth);
      const middle = this.fitCell(columns[1]?.[row] ?? "", columnWidth);
      const right = this.fitCell(columns[2]?.[row] ?? "", columnWidth);
      lines.push(
        `${left}${this.theme.fg("borderMuted", separator)}${middle}${this.theme.fg("borderMuted", separator)}${right}`,
      );
    }

    return lines.map((line) => truncateToWidth(line, width, "…", true));
  }

  private renderStatGroup(values: Map<string, number>, columnWidth: number): string[] {
    const rows = sortedStats(values).slice(0, 8);
    const max = rows[0]?.[1] ?? 0;
    const valueWidth = Math.max(1, String(max).length);
    const barStart = Math.max(6, columnWidth - BAR_WIDTH - valueWidth - 1);

    return rows.map(([label, value]) => {
      const labelText = truncateToWidth(label, Math.max(1, barStart - 1), "…", true);
      const gap = " ".repeat(Math.max(1, barStart - visibleWidth(labelText)));
      return `${labelText}${gap}${this.theme.fg("accent", bar(value, max))} ${value}`;
    });
  }

  private fitCell(text: string, width: number): string {
    const fitted = truncateToWidth(text, width, "…", true);
    return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
  }

  private detail(width: number): string {
    if (this.view === "stats") return "";
    const anchor = this.getSelectedAnchor();
    if (!anchor) return "";
    const summary = anchor.meta?.summary || "no summary";
    return truncateToWidth(`${anchor.name} · ${summary}`, width, "…", true);
  }

  private nextView(): ViewMode {
    return this.offsetView(1);
  }

  private previousView(): ViewMode {
    return this.offsetView(-1);
  }

  private offsetView(delta: -1 | 1): ViewMode {
    const index = VIEW_MODES.indexOf(this.view);
    return VIEW_MODES[(index + delta + VIEW_MODES.length) % VIEW_MODES.length];
  }
}

function getAvailableEntry(entries: SessionEntry[], anchor: TapeAnchor): string | undefined {
  const childMap = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    if (!entry.parentId) continue;
    const children = childMap.get(entry.parentId) ?? [];
    children.push(entry);
    childMap.set(entry.parentId, children);
  }

  const queue = [...(childMap.get(anchor.sessionEntryId) ?? [])];
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];
    if (!entry) continue;
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      queue.push(...(childMap.get(entry.id) ?? []));
      continue;
    }

    const message = entry.message as AssistantMessage;
    const hasText = message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
    if (hasText || message.stopReason === "aborted" || message.errorMessage) return entry.id;
    queue.push(...(childMap.get(entry.id) ?? []));
  }

  return undefined;
}

function resolveNavTarget(
  ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager">,
  anchor: TapeAnchor,
): { sessionPath?: string; targetId?: string } {
  if (anchor.sessionId === ctx.sessionManager.getSessionId()) {
    return { targetId: getAvailableEntry(ctx.sessionManager.getEntries(), anchor) };
  }

  const sessionPath = getSessionFilePath(ctx.cwd, anchor.sessionId) ?? undefined;
  const entries = sessionPath ? parseSessionFile(sessionPath)?.entries : undefined;
  return { sessionPath, targetId: entries ? getAvailableEntry(entries, anchor) : undefined };
}

export async function openMemoryReview(
  tapeService: TapeService,
  ctx: Pick<ExtensionCommandContext, "cwd" | "ui" | "sessionManager" | "navigateTree" | "switchSession">,
  options: { entryScope?: "session" | "project"; limit?: number } = {},
): Promise<ReviewData> {
  const { entryScope = "project", limit = DEFAULT_MEMORY_REVIEW_LIMIT } = options;
  const data = buildReviewData(tapeService, entryScope, normalizeMemoryReviewLimit(limit));

  if (ctx.ui.custom) {
    const selectedAnchor = await ctx.ui.custom<TapeAnchor | null>(
      (tui, theme, _keybindings, done) => {
        const getBodyLines = (): number => {
          const termHeight = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 30;
          const overlayHeight = Math.max(OVERLAY_MIN_HEIGHT, Math.floor(termHeight * OVERLAY_HEIGHT_RATIO));
          return Math.max(1, overlayHeight - OVERLAY_CHROME_LINES);
        };
        return new TapeReviewOverlay(
          data,
          theme,
          () => done(null),
          (anchor) => done(anchor),
          getBodyLines,
        );
      },
      {
        overlay: true,
        overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 70, anchor: "center", margin: 0 },
      },
    );

    if (selectedAnchor) {
      const { sessionPath, targetId } = resolveNavTarget(ctx, selectedAnchor);
      if (!targetId) {
        ctx.ui.notify("No assistant entry found after selected anchor.", "warning");
      } else if (sessionPath) {
        await ctx.switchSession(sessionPath, {
          withSession: async (nextCtx) => void (await nextCtx.navigateTree(targetId)),
        });
      } else {
        await ctx.navigateTree(targetId);
      }
    }
  }

  return data;
}
