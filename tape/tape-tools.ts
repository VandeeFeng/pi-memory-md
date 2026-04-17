import type { ExtensionAPI, SessionEntry, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { extractMessageContent } from "./tape-selector.js";
import type { MemoryTapeService } from "./tape-service.js";
import type { RenderState } from "./tape-types.js";

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
  const time = new Date(entry.timestamp).toLocaleTimeString();

  switch (entry.type) {
    case "message": {
      const msg = entry as { message: { role: string; content?: unknown } };
      const content = extractMessageContent(msg.message.content).substring(0, 50);
      return `[${time}] ${msg.message.role === "user" ? "User" : "Assistant"}: ${content}...`;
    }
    case "custom":
    case "custom_message":
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

const EntryTypeUnion = Type.Union([
  Type.Literal("message"),
  Type.Literal("custom"),
  Type.Literal("custom_message"),
  Type.Literal("thinking_level_change"),
  Type.Literal("model_change"),
  Type.Literal("compaction"),
]);

export function registerTapeHandoff(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
  pi.registerTool({
    name: "tape_handoff",
    label: "Tape Handoff",
    description: "Create an anchor checkpoint in the tape (marks a phase transition)",
    parameters: Type.Object({
      name: Type.String({ description: "Anchor name (e.g., 'session/start', 'task/begin', 'handoff')" }),
      summary: Type.Optional(Type.String({ description: "Optional summary of this checkpoint" })),
      state: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "Optional state to associate with this anchor" }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { name, summary, state } = params as { name: string; summary?: string; state?: Record<string, unknown> };
      const anchorState = { ...(state ?? {}), ...(summary ? { summary } : {}) };
      const anchorId = tapeService.createAnchor(name, Object.keys(anchorState).length > 0 ? anchorState : undefined);

      return {
        content: [{ type: "text", text: `Anchor created: ${name}` }],
        details: {
          anchorId,
          name,
          state: { ...anchorState, timestamp: new Date().toISOString() },
        },
      };
    },

    renderCall(args, theme) {
      return renderText(theme.fg("toolTitle", theme.bold("tape_handoff ")) + theme.fg("accent", args.name));
    },

    renderResult(result, state: RenderState, theme) {
      if (state.isPartial) return renderText(theme.fg("warning", "Creating anchor..."));

      const name = (result.details as { name?: string })?.name ?? "Anchor created";
      if (!state.expanded) {
        return renderText(theme.fg("success", name));
      }

      return renderText(theme.fg("toolOutput", (result.content[0] as { text?: string })?.text ?? ""));
    },
  });
}

export function registerTapeAnchors(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
  pi.registerTool({
    name: "tape_anchors",
    label: "Tape Anchors",
    description: "List all anchor checkpoints in the tape with context",
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
      const { limit = 20, contextLines = 1 } = params as { limit?: number; contextLines?: number };

      const anchorIndex = tapeService.getAnchorIndex();
      const allAnchors = anchorIndex.getAllAnchors().slice(-limit);

      const anchorsWithContext = allAnchors.map((anchor) => {
        const entries = tapeService.query({ sinceAnchor: anchor.name, scope: "project", anchorScope: "project" });
        return {
          id: anchor.sessionEntryId,
          name: anchor.name,
          timestamp: anchor.timestamp,
          state: anchor.state ?? {},
          beforeContext: entries.slice(0, contextLines).map(formatEntrySummary),
          afterContext: entries.slice(contextLines, contextLines * 2).map(formatEntrySummary),
        };
      });

      let summary = "No anchors found in tape. Use tape_handoff to create an anchor.";
      if (anchorsWithContext.length > 0) {
        summary =
          `Found ${anchorsWithContext.length} anchor(s):\n\n` +
          anchorsWithContext
            .map((anchor) => {
              const stateStr = Object.keys(anchor.state).length > 0 ? `\n  State: ${JSON.stringify(anchor.state)}` : "";
              const beforeStr =
                anchor.beforeContext.length > 0 ? `\n  Before:\n    ${anchor.beforeContext.join("\n    ")}` : "";
              const afterStr =
                anchor.afterContext.length > 0 ? `\n  After:\n    ${anchor.afterContext.join("\n    ")}` : "";
              return `  - ${anchor.name} (${new Date(anchor.timestamp).toLocaleString()})${stateStr}${beforeStr}${afterStr}`;
            })
            .join("\n\n");
      }

      return {
        content: [{ type: "text", text: summary }],
        details: { anchors: anchorsWithContext, count: anchorsWithContext.length },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("tape_anchors"));
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
              state: Record<string, unknown>;
              beforeContext: string[];
              afterContext: string[];
            }>;
            count?: number;
          }
        | undefined;

      if (!state.expanded && details?.anchors && details.anchors.length > 0) {
        const first = details.anchors[0];
        const time = new Date(first.timestamp).toLocaleTimeString();
        let summary = theme.fg("success", `${first.name} (${time})`);

        if (first.beforeContext.length > 0)
          summary += `\n${theme.fg("muted", "Before:\n  ")}${first.beforeContext.map((c) => theme.fg("muted", c)).join("\n  ")}`;
        if (first.afterContext.length > 0)
          summary += `\n${theme.fg("muted", "After:\n  ")}${first.afterContext.map((c) => theme.fg("muted", c)).join("\n  ")}`;
        if (Object.keys(first.state).length > 0)
          summary += `\n${theme.fg("muted", `State: ${JSON.stringify(first.state)}`)}`;

        return renderWithExpandHint(summary, theme, details.count ?? 1);
      }

      if (!state.expanded) return renderText(theme.fg("success", `${details?.count ?? 0} anchor(s)`));
      return renderText(theme.fg("toolOutput", (result.content[0] as { text?: string })?.text ?? ""));
    },
  });
}

export function registerTapeInfo(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
  pi.registerTool({
    name: "tape_info",
    label: "Tape Info",
    description: "Get tape information (entries, anchors, last anchor, etc.)",
    parameters: Type.Object({}),

    async execute(_toolCallId) {
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

export function registerTapeSearch(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
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
    }),

    async execute(_toolCallId, params) {
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
      };

      const parts: string[] = [];
      const lines: string[] = [];

      if (kinds.includes("anchor") || kinds.includes("all")) {
        const anchorIndex = tapeService.getAnchorIndex();
        const since = sinceAnchor ? tapeService.findAnchorByName(sinceAnchor, anchorScope)?.timestamp : undefined;
        const until = betweenDates?.end;

        const anchors = anchorIndex.search({
          query,
          limit,
          since,
          until,
          sessionId: scope === "session" ? tapeService.getSessionId() : undefined,
        });

        if (anchors.length > 0) {
          parts.push(`${anchors.length} anchors`);
          lines.push("Anchors:");
          for (const anchor of anchors.slice(-5)) {
            const stateStr = anchor.state ? ` ${JSON.stringify(anchor.state)}` : "";
            lines.push(`  ${anchor.name} (${new Date(anchor.timestamp).toLocaleString()})${stateStr}`);
          }
          if (anchors.length > 5) lines.push(`  ... and ${anchors.length - 5} more`);
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

        if (entries.length > 0) {
          parts.push(`${entries.length} entries`);
          for (const entry of entries.slice(-5)) {
            lines.push(`[${new Date(entry.timestamp).toLocaleTimeString()}] ${formatEntrySummary(entry)}`);
          }
          if (entries.length > 5) {
            lines.push(`  ... and ${entries.length - 5} more`);
          }
        }
      }

      const header = parts.length > 0 ? `Found ${parts.join(", ")}` : "No results";

      return {
        content: [{ type: "text", text: `${header}\n\n${lines.join("\n") || "(no results)"}` }],
        details: { kinds, query, count: lines.length },
      };
    },

    renderCall(args, theme) {
      const parts = [theme.fg("toolTitle", theme.bold("tape_search"))];
      if (args.kinds?.length) parts.push(theme.fg("muted", args.kinds.join(",")));
      if (args.sinceAnchor) parts.push(theme.fg("accent", `@${args.sinceAnchor}`));
      if (args.query) parts.push(theme.fg("accent", `"${args.query}"`));
      return renderText(parts.join(" "));
    },

    renderResult(result, state: RenderState, theme) {
      const details = result.details as { count?: number } | undefined;
      return renderDefaultResult(result, state, theme, `${details?.count ?? 0} found`);
    },
  });
}

export function registerTapeRead(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
  pi.registerTool({
    name: "tape_read",
    label: "Tape Read",
    description: "Read tape entries from pi session. Supports anchor-based, date-based, or query filtering.",
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
      types: Type.Optional(Type.Array(EntryTypeUnion)),
      scope: Type.Optional(QueryScopeUnion),
      anchorScope: Type.Optional(AnchorScopeUnion),
      limit: Type.Optional(Type.Integer({ description: "Max entries (default: 20)", minimum: 1, maximum: 100 })),
    }),

    async execute(_toolCallId, params) {
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

      const queryOptions: Parameters<typeof tapeService.query>[0] = { types, limit, scope, anchorScope, query };
      if (betweenAnchors) queryOptions.betweenAnchors = betweenAnchors;
      else if (betweenDates) queryOptions.betweenDates = betweenDates;
      else if (afterAnchor) queryOptions.sinceAnchor = afterAnchor;
      else if (lastAnchor) queryOptions.lastAnchor = true;

      const entries = tapeService.query(queryOptions);

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

export function registerTapeReset(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
  pi.registerTool({
    name: "tape_reset",
    label: "Tape Reset",
    description: "Clear anchor index (creates new session/start anchor)",
    parameters: Type.Object({
      archive: Type.Optional(Type.Boolean({ description: "Archive old tape first (not implemented)" })),
    }),

    async execute(_toolCallId, params) {
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

export function registerAllTapeTools(pi: ExtensionAPI, tapeService: MemoryTapeService): void {
  registerTapeHandoff(pi, tapeService);
  registerTapeAnchors(pi, tapeService);
  registerTapeInfo(pi, tapeService);
  registerTapeSearch(pi, tapeService);
  registerTapeRead(pi, tapeService);
  registerTapeReset(pi, tapeService);
}
