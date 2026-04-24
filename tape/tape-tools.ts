import type { ExtensionAPI, SessionEntry, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { MemoryMdSettings } from "../types.js";
import { toLocaleDateTime, toLocaleTime } from "../utils.js";
import type { TapeAnchorKind, TapeAnchorMeta } from "./tape-anchor.js";
import type { KeywordHandoffInstruction } from "./tape-selector.js";
import { extractMessageContent } from "./tape-selector.js";
import type { TapeService } from "./tape-service.js";
import type { RenderState } from "./tape-types.js";

export type TapeServiceGetter = () => TapeService | null;
export type PendingHandoffMatch =
  | { trigger: "keyword"; instruction: KeywordHandoffInstruction }
  | { trigger: "manual" };

type TapeSettingsGetter = () => MemoryMdSettings;
type ConsumeHandoffMatch = () => PendingHandoffMatch | null;

type EntryQueryParams = {
  types?: SessionEntry["type"][];
  limit?: number;
  sinceAnchor?: string;
  lastAnchor?: boolean;
  betweenAnchors?: { start: string; end: string };
  betweenDates?: { start: string; end: string };
  scope?: "session" | "project";
  anchorScope?: "current-session" | "project";
  query?: string;
};

function renderText(text: string): Text {
  return new Text(text, 0, 0);
}

function renderWithExpandHint(text: string, theme: Theme, totalLines: number): Text {
  if (totalLines <= 1) return renderText(text);
  return renderText(
    text +
      "\n" +
      theme.fg("muted", `... (${totalLines - 1} more lines, `) +
      keyHint("app.tools.expand", "to expand") +
      theme.fg("muted", ")"),
  );
}

function renderDefaultResult(
  result: { content: Array<{ type: string; text?: string }> },
  state: RenderState,
  theme: Theme,
  collapsedSummary: string,
): Text {
  if (state.isPartial) return renderText(theme.fg("warning", "Loading..."));
  if (!state.expanded)
    return renderWithExpandHint(
      theme.fg("success", collapsedSummary),
      theme,
      result.content[0]?.text?.split("\n").length ?? 1,
    );
  return renderText(theme.fg("toolOutput", result.content[0]?.text ?? ""));
}

function formatEntrySummary(entry: SessionEntry): string {
  const time = toLocaleTime(entry.timestamp);

  switch (entry.type) {
    case "message": {
      const msg = entry as { message: { role: string; content?: unknown } };
      const fullContent = extractMessageContent(msg.message.content);
      const content = fullContent.substring(0, 50);
      const suffix = fullContent.length > 50 ? "..." : "";
      return `[${time}] ${msg.message.role === "user" ? "User" : "Assistant"}: ${content}${suffix}`;
    }
    case "custom":
      return `[${time}] Custom: ${(entry as { customType?: string }).customType ?? "unknown"}`;
    case "thinking_level_change":
      return `[${time}] Thinking level: ${entry.thinkingLevel}`;
    case "model_change":
      return `[${time}] Model: ${entry.provider}/${entry.modelId}`;
    case "compaction":
      return `[${time}] Compaction: ${entry.summary}`;
    default:
      return `[${time}] ${entry.type}`;
  }
}

function getAnchorSearchBounds(
  tapeService: TapeService,
  options: {
    sinceAnchor?: string;
    lastAnchor?: boolean;
    betweenAnchors?: { start: string; end: string };
    betweenDates?: { start: string; end: string };
    anchorScope?: "current-session" | "project";
    scope?: "session" | "project";
  },
): { since?: string; until?: string; sessionId?: string } {
  const { sinceAnchor, lastAnchor, betweenAnchors, betweenDates, anchorScope = "current-session", scope } = options;

  if (betweenDates) {
    return {
      since: betweenDates.start,
      until: betweenDates.end,
      sessionId: scope === "session" ? tapeService.getSessionId() : undefined,
    };
  }

  if (betweenAnchors) {
    return {
      since: tapeService.findAnchorByName(betweenAnchors.start, anchorScope)?.timestamp,
      until: tapeService.findAnchorByName(betweenAnchors.end, anchorScope)?.timestamp,
      sessionId: scope === "session" ? tapeService.getSessionId() : undefined,
    };
  }

  if (lastAnchor) {
    return {
      since: tapeService.getLastAnchor(anchorScope)?.timestamp,
      sessionId: scope === "session" ? tapeService.getSessionId() : undefined,
    };
  }

  return {
    since: sinceAnchor ? tapeService.findAnchorByName(sinceAnchor, anchorScope)?.timestamp : undefined,
    sessionId: scope === "session" ? tapeService.getSessionId() : undefined,
  };
}

function getAnchorContext(entries: SessionEntry[], anchorTimestamp: string, contextLines: number): string[][] {
  const anchorTime = new Date(anchorTimestamp).getTime();
  const anchorIndex = entries.findIndex((entry) => new Date(entry.timestamp).getTime() >= anchorTime);

  if (anchorIndex === -1) {
    return [entries.slice(-contextLines).map(formatEntrySummary), []];
  }

  return [
    entries.slice(Math.max(0, anchorIndex - contextLines), anchorIndex).map(formatEntrySummary),
    entries.slice(anchorIndex, anchorIndex + contextLines).map(formatEntrySummary),
  ];
}

const EntryTypeUnion = Type.Union([
  Type.Literal("message"),
  Type.Literal("custom"),
  Type.Literal("thinking_level_change"),
  Type.Literal("model_change"),
  Type.Literal("compaction"),
]);

function buildEntryQueryOptions(options: EntryQueryParams): Parameters<TapeService["query"]>[0] {
  const { types, limit, scope = "project", anchorScope = "current-session", query } = options;
  const queryOptions: Parameters<TapeService["query"]>[0] = { types, limit, scope, anchorScope, query };

  if (options.betweenAnchors) queryOptions.betweenAnchors = options.betweenAnchors;
  else if (options.betweenDates) queryOptions.betweenDates = options.betweenDates;
  else if (options.sinceAnchor) queryOptions.sinceAnchor = options.sinceAnchor;
  else if (options.lastAnchor) queryOptions.lastAnchor = true;

  return queryOptions;
}

function getTapeUnavailableResult(): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: "Tape is not enabled for the current settings." }],
    details: {},
  };
}

function normalizeKeywords(keywords: string[] | undefined): string[] | undefined {
  const normalized = [...new Set((keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeHandoffMeta(
  summary: string | undefined,
  purpose: string | undefined,
  trigger: "direct" | "keyword" | "manual" | undefined,
  keywords: string[] | undefined,
): TapeAnchorMeta | undefined {
  const mergedMeta: Record<string, unknown> = {};

  if (summary) mergedMeta.summary = summary;
  if (purpose) mergedMeta.purpose = purpose;
  mergedMeta.trigger = trigger === "keyword" || trigger === "manual" ? trigger : "direct";

  const normalizedKeywords = normalizeKeywords(keywords);
  if (normalizedKeywords) mergedMeta.keywords = normalizedKeywords;

  return Object.keys(mergedMeta).length > 0 ? (mergedMeta as TapeAnchorMeta) : undefined;
}

export function registerTapeHandoff(
  pi: ExtensionAPI,
  getTapeService: TapeServiceGetter,
  getSettings: TapeSettingsGetter,
  consumeHandoffMatch: ConsumeHandoffMatch = () => null,
): void {
  pi.registerTool({
    name: "tape_handoff",
    label: "Tape Handoff",
    description: "Create a handoff anchor in tape",
    parameters: Type.Object({
      name: Type.String({ description: "Anchor name (e.g., 'task/begin', 'task/complete', 'handoff')" }),
      summary: Type.Optional(Type.String({ description: "Brief intent summary of current task (under 18 words)" })),
      purpose: Type.Optional(Type.String({ description: "1-2 word label for the anchor's purpose" })),
    }),

    async execute(_toolCallId, params) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const { name, summary, purpose } = params as {
        name: string;
        summary?: string;
        purpose?: string;
      };
      const handoffMode = getSettings().tape?.anchor?.mode ?? "auto";
      const handoffMatch = consumeHandoffMatch();
      const keywordHandoffMatch = handoffMatch?.trigger === "keyword" ? handoffMatch : null;
      const matchedKeywordHandoff = keywordHandoffMatch?.instruction.anchorName === name;
      const finalTrigger = handoffMatch?.trigger === "manual" ? "manual" : matchedKeywordHandoff ? "keyword" : "direct";
      const finalKeywords =
        finalTrigger === "keyword" ? normalizeKeywords(keywordHandoffMatch?.instruction.matched) : undefined;

      if (handoffMode === "manual" && finalTrigger !== "keyword" && finalTrigger !== "manual") {
        return {
          content: [
            {
              type: "text",
              text: 'tape_handoff is disabled when tape.anchor.mode="manual" unless a keyword or manual handoff match is present.',
            },
          ],
          details: {
            disabled: true,
            handoffMode,
            allowedTriggers: ["keyword", "manual"],
            finalTrigger,
            hasHandoffMatch: handoffMatch !== null,
            matchedKeywordHandoff: false,
          },
        };
      }

      const mergedMeta = normalizeHandoffMeta(summary, purpose, finalTrigger, finalKeywords);
      const anchor = tapeService.createAnchor(name, "handoff", mergedMeta);

      return {
        content: [{ type: "text", text: JSON.stringify(anchor) }],
        details: {
          anchorId: anchor.id,
          name,
          meta: { ...mergedMeta, timestamp: anchor.timestamp },
          finalTrigger,
          hasHandoffMatch: handoffMatch !== null,
          matchedKeywordHandoff: handoffMatch?.trigger === "keyword" ? matchedKeywordHandoff : false,
        },
      };
    },

    renderCall(args, theme) {
      return renderText(theme.fg("toolTitle", theme.bold("tape_handoff ")) + theme.fg("accent", args.name));
    },

    renderResult(result, state: RenderState, theme) {
      if (state.isPartial) return renderText(theme.fg("warning", "Creating anchor..."));

      const details = result.details as { disabled?: boolean } | undefined;
      const text = (result.content[0] as { text?: string })?.text ?? "";
      if (details?.disabled) return renderText(theme.fg("warning", text));
      return renderText(`${theme.fg("success", "Anchor created:")}\n${theme.fg("toolOutput", text)}`);
    },
  });
}

export function registerTapeAnchors(pi: ExtensionAPI, getTapeService: TapeServiceGetter): void {
  pi.registerTool({
    name: "tape_list",
    label: "Tape List",
    description: "List tape anchors with nearby context",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ description: "Maximum number of anchors to return (default: 20)", minimum: 1, maximum: 100 }),
      ),
      contextLines: Type.Optional(
        Type.Integer({
          description: "Number of context lines before/after each anchor (default: 1)",
          minimum: 0,
          maximum: 5,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const { limit = 20, contextLines = 1 } = params as { limit?: number; contextLines?: number };

      const anchorStore = tapeService.getAnchorStore();
      const anchors = anchorStore.getAllAnchors().slice(-limit);
      const projectEntries = tapeService.query({ scope: "project", anchorScope: "project" });

      const anchorsWithContext = anchors.map((anchor) => {
        const [beforeContext, afterContext] = getAnchorContext(projectEntries, anchor.timestamp, contextLines);
        return {
          id: anchor.id,
          name: anchor.name,
          timestamp: anchor.timestamp,
          kind: anchor.kind,
          meta: anchor.meta ?? {},
          beforeContext,
          afterContext,
        };
      });

      let summary = "No anchors found in tape. Use tape_handoff to create an anchor.";
      if (anchorsWithContext.length > 0) {
        summary =
          `Found ${anchorsWithContext.length} anchor(s):\n\n` +
          anchorsWithContext
            .map((anchor) => {
              const metaStr = Object.keys(anchor.meta).length > 0 ? `\n  Meta: ${JSON.stringify(anchor.meta)}` : "";
              const beforeStr =
                anchor.beforeContext.length > 0 ? `\n  Before:\n    ${anchor.beforeContext.join("\n    ")}` : "";
              const afterStr =
                anchor.afterContext.length > 0 ? `\n  After:\n    ${anchor.afterContext.join("\n    ")}` : "";
              return `  - ${anchor.name} [${anchor.kind}] (${toLocaleDateTime(anchor.timestamp)})${metaStr}${beforeStr}${afterStr}`;
            })
            .join("\n\n");
      }

      return {
        content: [{ type: "text", text: summary }],
        details: { anchors: anchorsWithContext, count: anchorsWithContext.length },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tape_list"));
      if (args.limit) text += ` ${theme.fg("muted", `limit=${args.limit}`)}`;
      if (args.contextLines) text += ` ${theme.fg("muted", `context=${args.contextLines}`)}`;
      return renderText(text);
    },

    renderResult(result, state: RenderState, theme) {
      if (state.isPartial) return renderText(theme.fg("warning", "Listing anchors..."));

      const details = result.details as
        | {
            anchors?: Array<{
              name: string;
              timestamp: string;
              kind: string;
              meta: Record<string, unknown>;
              beforeContext: string[];
              afterContext: string[];
            }>;
            count?: number;
          }
        | undefined;

      if (!state.expanded && details?.anchors && details.anchors.length > 0) {
        const first = details.anchors[0];
        const time = toLocaleTime(first.timestamp);
        let summary = theme.fg("success", `${first.name} (${time})`);

        if (first.beforeContext.length > 0)
          summary += `\n${theme.fg("muted", "Before:\n  ")}${first.beforeContext.map((c) => theme.fg("muted", c)).join("\n  ")}`;
        if (first.afterContext.length > 0)
          summary += `\n${theme.fg("muted", "After:\n  ")}${first.afterContext.map((c) => theme.fg("muted", c)).join("\n  ")}`;
        if (Object.keys(first.meta).length > 0)
          summary += `\n${theme.fg("muted", `Meta: ${JSON.stringify(first.meta)}`)}`;

        return renderWithExpandHint(summary, theme, details.count ?? 1);
      }

      if (!state.expanded) return renderText(theme.fg("success", `${details?.count ?? 0} anchor(s)`));
      return renderText(theme.fg("toolOutput", (result.content[0] as { text?: string })?.text ?? ""));
    },
  });
}

export function registerTapeAnchorDelete(pi: ExtensionAPI, getTapeService: TapeServiceGetter): void {
  pi.registerTool({
    name: "tape_delete",
    label: "Tape Delete",
    description: "Delete an anchor checkpoint by id",
    parameters: Type.Object({
      id: Type.String({ description: "Anchor id to delete (use tape_list to list ids)" }),
    }),

    async execute(_toolCallId, params) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const { id } = params as { id: string };
      const removedAnchor = tapeService.deleteAnchor(id);
      if (!removedAnchor) {
        return {
          content: [{ type: "text", text: `Anchor not found: ${id}` }],
          details: { id, deleted: false },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(removedAnchor) }],
        details: { id, deleted: true, name: removedAnchor.name },
      };
    },

    renderCall(args, theme) {
      return renderText(theme.fg("toolTitle", theme.bold("tape_delete ")) + theme.fg("accent", args.id));
    },

    renderResult(result, state: RenderState, theme) {
      if (state.isPartial) return renderText(theme.fg("warning", "Deleting anchor..."));

      const details = result.details as { deleted?: boolean } | undefined;
      const text = (result.content[0] as { text?: string })?.text ?? "";
      if (!details?.deleted) {
        return renderText(theme.fg("warning", text || "Not found"));
      }

      return renderText(`${theme.fg("success", "Anchor deleted:")}\n${theme.fg("toolOutput", text)}`);
    },
  });
}

export function registerTapeInfo(pi: ExtensionAPI, getTapeService: TapeServiceGetter): void {
  pi.registerTool({
    name: "tape_info",
    label: "Tape Info",
    description: "Get tape summary and last-anchor info",
    parameters: Type.Object({}),

    async execute(_toolCallId) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const info = tapeService.getInfo();
      const lastAnchorName = info.lastAnchor?.name ?? "none";
      const tapeFileCount = tapeService.getTapeFileCount();

      let recommendation = "";
      if (info.entriesSinceLastAnchor > 20)
        recommendation =
          "\n\n💡 Recommendation: Context is getting large. Consider using tape_handoff to create a new checkpoint.";
      else if (info.entriesSinceLastAnchor > 10)
        recommendation = "\n\n⚠️  Warning: Context is growing. You may want to use tape_handoff soon.";

      const summary = [
        `📊 Tape Information:`,
        `  Total entries: ${info.totalEntries}`,
        `  Anchors: ${info.anchorCount}`,
        `  Last anchor: ${lastAnchorName}`,
        `  Entries since last anchor: ${info.entriesSinceLastAnchor}`,
        recommendation,
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: {
          tapeFileCount,
          totalEntries: info.totalEntries,
          anchorCount: info.anchorCount,
          lastAnchor: info.lastAnchor?.sessionEntryId,
          lastAnchorName,
          entriesSinceLastAnchor: info.entriesSinceLastAnchor,
        },
      };
    },

    renderCall(_args, theme) {
      return renderText(theme.fg("toolTitle", theme.bold("tape_info")));
    },

    renderResult(result, state: RenderState, theme) {
      const details = result.details as { totalEntries?: number; anchorCount?: number } | undefined;
      return renderDefaultResult(
        result,
        state,
        theme,
        `📊 ${details?.totalEntries ?? 0} entries, ${details?.anchorCount ?? 0} anchors`,
      );
    },
  });
}

const SearchKindsUnion = Type.Union([Type.Literal("entry"), Type.Literal("anchor"), Type.Literal("all")]);
const QueryScopeUnion = Type.Union([Type.Literal("session"), Type.Literal("project")]);
const AnchorScopeUnion = Type.Union([Type.Literal("current-session"), Type.Literal("project")]);

export function registerTapeSearch(pi: ExtensionAPI, getTapeService: TapeServiceGetter): void {
  pi.registerTool({
    name: "tape_search",
    label: "Tape Search",
    description: "Search tape entries and anchors by type, content, or time range",
    parameters: Type.Object({
      kinds: Type.Optional(
        Type.Array(SearchKindsUnion, {
          description: "What to search: 'entry' (session entries), 'anchor' (anchors), 'all' (default: all)",
        }),
      ),
      types: Type.Optional(
        Type.Array(EntryTypeUnion, { description: "Filter entries by type (only for entries search)" }),
      ),
      limit: Type.Optional(
        Type.Integer({ description: "Maximum number of results (default: 20)", minimum: 1, maximum: 100 }),
      ),
      sinceAnchor: Type.Optional(Type.String({ description: "Anchor name to search from" })),
      lastAnchor: Type.Optional(Type.Boolean({ description: "Search from last anchor" })),
      betweenAnchors: Type.Optional(
        Type.Object({ start: Type.String(), end: Type.String() }, { description: "Between two anchors" }),
      ),
      betweenDates: Type.Optional(
        Type.Object({ start: Type.String(), end: Type.String() }, { description: "Between dates (ISO)" }),
      ),
      scope: Type.Optional(
        Type.Unsafe({ ...QueryScopeUnion, description: "Entry scope: 'session' or 'project' (default: project)" }),
      ),
      anchorScope: Type.Optional(
        Type.Unsafe({
          ...AnchorScopeUnion,
          description: "Anchor resolution: 'current-session' (default) or 'project'",
        }),
      ),
      query: Type.Optional(Type.String({ description: "Text search in entry/anchor content" })),
      anchorName: Type.Optional(Type.String({ description: "Filter anchors by name substring" })),
      anchorKind: Type.Optional(Type.String({ description: "Filter anchors by exact kind, e.g. 'handoff'" })),
      anchorSummary: Type.Optional(Type.String({ description: "Filter anchors by summary substring" })),
      anchorPurpose: Type.Optional(Type.String({ description: "Filter anchors by purpose substring" })),
      anchorKeywords: Type.Optional(
        Type.Array(Type.String(), { description: "Filter anchors that contain all given keywords" }),
      ),
    }),

    async execute(_toolCallId, params) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const {
        kinds = ["all"],
        types,
        limit = 20,
        sinceAnchor,
        lastAnchor,
        betweenAnchors,
        betweenDates,
        scope = "project",
        anchorScope = "current-session",
        query,
        anchorName,
        anchorKind,
        anchorSummary,
        anchorPurpose,
        anchorKeywords,
      } = params as {
        kinds?: string[];
        types?: SessionEntry["type"][];
        limit?: number;
        sinceAnchor?: string;
        lastAnchor?: boolean;
        betweenAnchors?: { start: string; end: string };
        betweenDates?: { start: string; end: string };
        scope?: "session" | "project";
        anchorScope?: "current-session" | "project";
        query?: string;
        anchorName?: string;
        anchorKind?: TapeAnchorKind;
        anchorSummary?: string;
        anchorPurpose?: string;
        anchorKeywords?: string[];
      };

      const parts: string[] = [];
      const lines: string[] = [];
      let anchorCount = 0;
      let entryCount = 0;

      if (kinds.includes("anchor") || kinds.includes("all")) {
        const anchorStore = tapeService.getAnchorStore();
        const { since, until, sessionId } = getAnchorSearchBounds(tapeService, {
          sinceAnchor,
          lastAnchor,
          betweenAnchors,
          betweenDates,
          anchorScope,
          scope,
        });

        const anchors = anchorStore.search({
          query,
          limit,
          since,
          until,
          sessionId,
          name: anchorName,
          kind: anchorKind,
          summary: anchorSummary,
          purpose: anchorPurpose,
          keywords: anchorKeywords,
        });

        anchorCount = anchors.length;
        if (anchorCount > 0) {
          parts.push(`${anchorCount} anchors`);
          lines.push("Anchors:");
          for (const anchor of anchors.slice(-5)) {
            const metaStr = anchor.meta ? ` ${JSON.stringify(anchor.meta)}` : "";
            lines.push(`  ${anchor.name} [${anchor.kind}] (${toLocaleDateTime(anchor.timestamp)})${metaStr}`);
          }
          if (anchorCount > 5) lines.push(`  ... and ${anchorCount - 5} more`);
        }
      }

      if (kinds.includes("entry") || kinds.includes("all")) {
        const entries = tapeService.query({
          types,
          limit,
          sinceAnchor,
          lastAnchor,
          betweenAnchors,
          betweenDates,
          scope,
          anchorScope,
          query,
        });

        entryCount = entries.length;
        if (entryCount > 0) {
          parts.push(`${entryCount} entries`);
          for (const entry of entries.slice(-5)) {
            lines.push(formatEntrySummary(entry));
          }
          if (entryCount > 5) {
            lines.push(`  ... and ${entryCount - 5} more`);
          }
        }
      }

      const header = parts.length > 0 ? `Found ${parts.join(", ")}` : "No results";

      return {
        content: [{ type: "text", text: `${header}\n\n${lines.join("\n") || "(no results)"}` }],
        details: {
          kinds,
          query,
          count: anchorCount + entryCount,
          anchorCount,
          entryCount,
          anchorName,
          anchorKind,
          anchorSummary,
          anchorPurpose,
          anchorKeywords,
        },
      };
    },

    renderCall(args, theme) {
      const parts = [theme.fg("toolTitle", theme.bold("tape_search"))];
      if (args.kinds?.length) parts.push(theme.fg("muted", args.kinds.join(",")));
      if (args.sinceAnchor) parts.push(theme.fg("accent", `@${args.sinceAnchor}`));
      if (args.query) parts.push(theme.fg("accent", `"${args.query}"`));
      if (args.anchorSummary) parts.push(theme.fg("accent", `summary:${args.anchorSummary}`));
      if (args.anchorPurpose) parts.push(theme.fg("accent", `purpose:${args.anchorPurpose}`));
      if (args.anchorKeywords?.length) parts.push(theme.fg("accent", `keywords:${args.anchorKeywords.join(",")}`));
      return renderText(parts.join(" "));
    },

    renderResult(result, state: RenderState, theme) {
      const details = result.details as { count?: number } | undefined;
      return renderDefaultResult(result, state, theme, `${details?.count ?? 0} found`);
    },
  });
}

export function registerTapeRead(pi: ExtensionAPI, getTapeService: TapeServiceGetter): void {
  pi.registerTool({
    name: "tape_read",
    label: "Tape Read",
    description: "Read tape entries from pi session with anchor, date, or query filters.",
    parameters: Type.Object({
      afterAnchor: Type.Optional(Type.String({ description: "Read entries after this anchor" })),
      lastAnchor: Type.Optional(Type.Boolean({ description: "Read entries after last anchor" })),
      betweenAnchors: Type.Optional(
        Type.Object({ start: Type.String(), end: Type.String() }, { description: "Between two anchors" }),
      ),
      betweenDates: Type.Optional(
        Type.Object({ start: Type.String(), end: Type.String() }, { description: "Between dates (ISO)" }),
      ),
      query: Type.Optional(Type.String({ description: "Text search" })),
      types: Type.Optional(Type.Array(EntryTypeUnion, { description: "Filter entries by type" })),
      scope: Type.Optional(Type.Unsafe({ ...QueryScopeUnion, description: "Entry scope: 'session' or 'project'" })),
      anchorScope: Type.Optional(
        Type.Unsafe({ ...AnchorScopeUnion, description: "Anchor resolution: 'current-session' or 'project'" }),
      ),
      limit: Type.Optional(Type.Integer({ description: "Max entries (default: 20)", minimum: 1, maximum: 100 })),
    }),

    async execute(_toolCallId, params) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const {
        afterAnchor,
        betweenAnchors,
        betweenDates,
        types,
        lastAnchor = false,
        scope = "project",
        anchorScope = "current-session",
        limit = 20,
        query,
      } = params as {
        afterAnchor?: string;
        betweenAnchors?: { start: string; end: string };
        betweenDates?: { start: string; end: string };
        types?: SessionEntry["type"][];
        lastAnchor?: boolean;
        scope?: "session" | "project";
        anchorScope?: "current-session" | "project";
        limit?: number;
        query?: string;
      };

      const entries = tapeService.query(
        buildEntryQueryOptions({
          types,
          limit,
          scope,
          anchorScope,
          query,
          sinceAnchor: afterAnchor,
          lastAnchor,
          betweenAnchors,
          betweenDates,
        }),
      );

      const formatted = entries.map(formatEntrySummary).join("\n");
      return {
        content: [{ type: "text", text: `Retrieved ${entries.length} entries:\n\n${formatted || "(no entries)"}` }],
        details: { entries, count: entries.length },
      };
    },

    renderCall(args, theme) {
      const parts = [theme.fg("toolTitle", theme.bold("tape_read"))];
      if (args.afterAnchor) parts.push(theme.fg("muted", `after=${args.afterAnchor}`));
      if (args.lastAnchor) parts.push(theme.fg("accent", "@last"));
      if (args.query) parts.push(theme.fg("muted", `"${args.query}"`));
      if (args.limit) parts.push(theme.fg("muted", `limit=${args.limit}`));
      return renderText(parts.join(" "));
    },

    renderResult(result, state: RenderState, theme) {
      const details = result.details as { count?: number } | undefined;
      return renderDefaultResult(result, state, theme, `${details?.count ?? 0} entries`);
    },
  });
}

export function registerTapeReset(pi: ExtensionAPI, getTapeService: TapeServiceGetter): void {
  pi.registerTool({
    name: "tape_reset",
    label: "Tape Reset",
    description: "Clear tape anchors and create a fresh session anchor",
    parameters: Type.Object({
      archive: Type.Optional(Type.Boolean({ description: "Archive old tape first (not implemented)" })),
    }),

    async execute(_toolCallId, params) {
      const tapeService = getTapeService();
      if (!tapeService) return getTapeUnavailableResult();

      const { archive = false } = params as { archive?: boolean };
      tapeService.clear();
      tapeService.recordSessionStart();

      const text = archive ? "Tape archived and reset" : "Anchor index cleared";
      return { content: [{ type: "text", text }], details: { archived: archive } };
    },

    renderCall(args, theme) {
      return renderText(
        theme.fg("toolTitle", theme.bold("tape_reset")) + (args.archive ? ` ${theme.fg("warning", "--archive")}` : ""),
      );
    },

    renderResult(result, state: RenderState, theme) {
      if (state.isPartial) return renderText(theme.fg("warning", "Resetting..."));
      return renderText(theme.fg("success", (result.content[0] as { text?: string })?.text ?? ""));
    },
  });
}

export function registerAllTapeTools(
  pi: ExtensionAPI,
  getTapeService: TapeServiceGetter,
  getSettings: TapeSettingsGetter,
  consumeHandoffMatch?: ConsumeHandoffMatch,
): void {
  registerTapeHandoff(pi, getTapeService, getSettings, consumeHandoffMatch);
  registerTapeAnchors(pi, getTapeService);
  registerTapeAnchorDelete(pi, getTapeService);
  registerTapeInfo(pi, getTapeService);
  registerTapeSearch(pi, getTapeService);
  registerTapeRead(pi, getTapeService);
  registerTapeReset(pi, getTapeService);
}
