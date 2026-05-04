import type { ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatCommitTimestamp } from "../utils.js";
import type { TapeAnchor } from "./tape-anchor.js";
import { getSessionFilePath, parseSessionFile } from "./tape-reader.js";
import type { TapeService } from "./tape-service.js";

export const DEFAULT_MEMORY_REVIEW_LIMIT = 50;
export const MAX_TAPE_REVIEW_LIMIT = 100;

const BAR_WIDTH = 10;
const OVERLAY_HEIGHT_RATIO = 0.8;
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

function countValue(map: Map<string, number>, value: string | undefined): void {
  const key = value?.trim() || "unset";
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function normalizeMemoryReviewLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_MEMORY_REVIEW_LIMIT;
  return Math.min(Math.floor(limit), MAX_TAPE_REVIEW_LIMIT);
}

function buildReviewData(tapeService: TapeService, scope: "session" | "project", limit: number): ReviewData {
  const allAnchors = tapeService.getAnchorStore().getAllAnchors();
  const scopedAnchors =
    scope === "session" ? allAnchors.filter((anchor) => anchor.sessionId === tapeService.getSessionId()) : allAnchors;
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

class TapeReviewOverlay implements Component {
  private view: ViewMode = "timeline";
  private selectedByView: Record<ViewMode, number>;
  private selectedRelationIndex = 0;
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
    this.selectedByView = { timeline: newestAnchorIndex, relations: newestAnchorIndex, stats: 0 };
    this.selectedRelationIndex = Math.max(0, this.getVisibleAnchors().length - 1);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const anchor = this.getSelectedAnchor();
      if (anchor) {
        this.onOpenAnchor(anchor);
        return;
      }
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

    const innerWidth = Math.max(1, width - 2);
    const bodyContent = this.renderBody(innerWidth);
    const visibleBodyContent = this.sliceScrollableBody(bodyContent, bodyLineCount, innerWidth);

    const bodyLines = [
      this.header(innerWidth),
      ...this.statusBar(innerWidth),
      "─".repeat(innerWidth),
      ...visibleBodyContent,
      "─".repeat(innerWidth),
      this.detail(innerWidth),
    ];
    const lines = [
      this.topBorder(innerWidth),
      ...bodyLines.map((line) => this.borderLine(line, innerWidth)),
      this.bottomBorder(innerWidth),
    ];
    this.cachedWidth = width;
    this.cachedBodyLines = bodyLineCount;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedBodyLines = undefined;
    this.cachedLines = undefined;
  }

  private header(width: number): string {
    const title = this.theme.fg("toolTitle", this.theme.bold("Memory Review"));
    return this.centerText(title, width);
  }

  private statusBar(width: number): string[] {
    const columnWidth = Math.max(1, Math.floor(width / VIEW_MODES.length));
    const tabs = VIEW_MODES.map((view) => {
      const label = view === this.view ? this.theme.fg("accent", `[${view}]`) : this.theme.fg("muted", view);
      return this.centerText(label, columnWidth);
    });
    const tabLine = truncateToWidth(tabs.join(""), width);
    const keywordHint = this.view === "relations" ? " · h/l keyword" : "";
    const hint = this.centerText(
      this.theme.fg("muted", `←/→/tab switch · ↑/↓/j/k select${keywordHint} · enter open · q/ctrl+c close`),
      width,
    );
    return [tabLine, hint];
  }

  private topBorder(width: number): string {
    return `┌${"─".repeat(width)}┐`;
  }

  private bottomBorder(width: number): string {
    return `└${"─".repeat(width)}┘`;
  }

  private borderLine(line: string, width: number): string {
    const padding = Math.max(0, width - visibleWidth(line));
    return `│${line}${" ".repeat(padding)}│`;
  }

  private centerText(text: string, width: number): string {
    const padding = Math.max(0, width - visibleWidth(text));
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
  }

  private renderBody(width: number): string[] {
    if (this.data.anchors.length === 0) return [this.theme.fg("muted", "No tape anchors found.")];
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
      const baseLine = truncateToWidth(visibleLines[lastIndex], Math.max(1, width - visibleWidth(indicator) - 1));
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
      return truncateToWidth(`${pointer} ${anchor.name} ${purposeText}/${keywordText} ${timestamp}`, width);
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

    return lines.map((line) => truncateToWidth(line, width));
  }

  private getRelationGroups(): Array<[string, TapeAnchor[]]> {
    const groups = new Map<string, TapeAnchor[]>();

    for (const anchor of this.data.anchors) {
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
    return [...this.data.anchors].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  }

  private getVisibleAnchors(): TapeAnchor[] {
    switch (this.view) {
      case "timeline":
        return this.getTimelineAnchors();
      case "relations":
        return this.getRelationGroups().flatMap(([, anchors]) => anchors);
      case "stats":
        return this.data.anchors;
    }
  }

  private getSelectedAnchor(): TapeAnchor | undefined {
    if (this.view === "stats") return undefined;
    if (this.view === "relations") return this.getVisibleAnchors()[this.selectedRelationIndex];
    return this.data.anchors[this.selectedByView[this.view]];
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
    const nextAnchor = this.getVisibleAnchors()[this.selectedRelationIndex];
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

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderStatGroup(values: Map<string, number>, columnWidth: number): string[] {
    const rows = sortedStats(values).slice(0, 8);
    const max = rows[0]?.[1] ?? 0;
    const valueWidth = Math.max(1, String(max).length);
    const barStart = Math.max(6, columnWidth - BAR_WIDTH - valueWidth - 1);

    return rows.map(([label, value]) => {
      const labelText = truncateToWidth(label, Math.max(1, barStart - 1));
      const gap = " ".repeat(Math.max(1, barStart - visibleWidth(labelText)));
      return `${labelText}${gap}${this.theme.fg("accent", bar(value, max))} ${value}`;
    });
  }

  private fitCell(text: string, width: number): string {
    const fitted = truncateToWidth(text, width);
    return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
  }

  private detail(width: number): string {
    if (this.view === "stats") return "";
    const anchor = this.getSelectedAnchor();
    if (!anchor) return "";
    const summary = anchor.meta?.summary || "no summary";
    return truncateToWidth(`${anchor.name} · ${summary}`, width);
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

function findNextAssistantEntry(
  entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
  anchor: TapeAnchor,
): string | undefined {
  const anchorIndex = entries.findIndex((entry) => entry.id === anchor.sessionEntryId);
  if (anchorIndex < 0) return undefined;

  return entries.slice(anchorIndex + 1).find((entry) => entry.type === "message" && entry.message.role === "assistant")
    ?.id;
}

function resolveAnchorNavigationTarget(
  ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager">,
  anchor: TapeAnchor,
): { sessionPath?: string; targetId?: string } {
  if (anchor.sessionId === ctx.sessionManager.getSessionId()) {
    return { targetId: findNextAssistantEntry(ctx.sessionManager.getEntries(), anchor) };
  }

  const sessionPath = getSessionFilePath(ctx.cwd, anchor.sessionId) ?? undefined;
  const entries = sessionPath ? parseSessionFile(sessionPath)?.entries : undefined;
  return { sessionPath, targetId: entries ? findNextAssistantEntry(entries, anchor) : undefined };
}

export async function openMemoryReview(
  tapeService: TapeService,
  ctx: Pick<ExtensionCommandContext, "cwd" | "ui" | "sessionManager" | "navigateTree" | "switchSession">,
  options: { scope?: "session" | "project"; limit?: number } = {},
): Promise<ReviewData> {
  const { scope = "project", limit = DEFAULT_MEMORY_REVIEW_LIMIT } = options;
  const data = buildReviewData(tapeService, scope, normalizeMemoryReviewLimit(limit));

  if (ctx.ui.custom) {
    const selectedAnchor = await ctx.ui.custom<TapeAnchor | null>(
      (tui, theme, _keybindings, done) => {
        const getBodyLines = (): number => {
          const termHeight = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 30;
          const overlayHeight = Math.max(12, Math.floor(termHeight * OVERLAY_HEIGHT_RATIO));
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
        overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 70, anchor: "center", margin: 2 },
      },
    );

    if (selectedAnchor) {
      const { sessionPath, targetId } = resolveAnchorNavigationTarget(ctx, selectedAnchor);
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
