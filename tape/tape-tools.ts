import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { MemoryTapeService } from "./tape-service.js";
import { formatEntriesAsMessages } from "./tape-selector.js";

type RenderState = { expanded: boolean; isPartial: boolean };

function renderWithExpandHint(text: string, theme: Theme, lineCount: number): Text {
  const remaining = lineCount - 1;
  if (remaining > 0) {
    text +=
      "\n" +
      theme.fg("muted", `... (${remaining} more lines,`) +
      " " +
      keyHint("app.tools.expand", "to expand") +
      theme.fg("muted", ")");
  }
  return new Text(text, 0, 0);
}

function renderText(text: string): Text {
  return new Text(text, 0, 0);
}

function renderPartial(theme: Theme, message: string): Text {
  return renderText(theme.fg("warning", message));
}

function renderCollapsed(theme: Theme, summary: string): Text {
  return renderText(theme.fg("success", summary));
}

function renderExpanded(theme: Theme, content: unknown): Text {
  const text =
    content && typeof content === "object" && "type" in content && content.type === "text" && "text" in content
      ? (content as { text: string }).text
      : "";
  return renderText(theme.fg("toolOutput", text));
}

export function registerTapeHandoff(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  pi.registerTool({
    name: "tape_handoff",
    label: "Tape Handoff",
    description: "Create an anchor checkpoint in the tape (marks a phase transition)",
    parameters: Type.Object({
      name: Type.String({
        description: "Anchor name (e.g., 'session/start', 'task/begin', 'handoff')",
      }),
      summary: Type.Optional(Type.String({
        description: "Optional summary of this checkpoint",
      })),
      state: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Optional state to associate with this anchor",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { name, summary, state } = params as {
        name: string;
        summary?: string;
        state?: Record<string, unknown>;
      };

      const anchorId = tapeService.createAnchor(name);

      return {
        content: [{ type: "text", text: `Anchor created: ${name}` }],
        details: {
          anchorId,
          name,
          state: {
            ...state,
            ...(summary && { summary }),
            timestamp: new Date().toISOString(),
          },
        },
      };
    },

    renderCall(args, theme) {
      return renderText(theme.fg("toolTitle", theme.bold("tape_handoff ")) + theme.fg("accent", args.name));
    },

    renderResult(result, { isPartial, expanded }: RenderState, theme) {
      const content = result.content[0];
      
      if (isPartial) return renderPartial(theme, "Creating anchor...");
      
      if (!expanded) {
        const name = (result.details as { name?: string })?.name ?? "Anchor created";
        const lines = content?.type === "text" ? content.text.split("\n") : [];
        return renderWithExpandHint(theme.fg("success", name), theme, lines.length);
      }
      
      return renderExpanded(theme, content);
    },
  });
}

export function registerTapeAnchors(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  pi.registerTool({
    name: "tape_anchors",
    label: "Tape Anchors",
    description: "List all anchor checkpoints in the tape with context",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({
        description: "Maximum number of anchors to return (default: 20)",
        minimum: 1,
        maximum: 100,
      })),
      contextLines: Type.Optional(Type.Integer({
        description: "Number of context lines before/after each anchor (default: 1)",
        minimum: 0,
        maximum: 5,
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { limit = 20, contextLines = 1 } = params as { limit?: number; contextLines?: number };
      
      // Get all entries to find context
      const allEntries = tapeService.query({});
      const anchorEntries = tapeService.query({ kinds: ["anchor", "session/start"], limit });

      const anchorsWithContext = anchorEntries.map((anchorEntry) => {
        const anchorIndex = allEntries.findIndex((e) => e.id === anchorEntry.id);
        
        // Get context before anchor
        const beforeContext = [];
        for (let i = anchorIndex - 1; i >= Math.max(0, anchorIndex - contextLines); i--) {
          beforeContext.unshift(formatEntrySummary(allEntries[i]));
        }

        // Get context after anchor
        const afterContext = [];
        for (let i = anchorIndex + 1; i < Math.min(allEntries.length, anchorIndex + 1 + contextLines); i++) {
          afterContext.push(formatEntrySummary(allEntries[i]));
        }

        return {
          id: anchorEntry.id,
          name: (anchorEntry.payload.name as string) ?? "unnamed",
          timestamp: anchorEntry.timestamp,
          state: (anchorEntry.payload.state as Record<string, unknown>) ?? {},
          beforeContext,
          afterContext,
        };
      });

      const summary =
        anchorsWithContext.length === 0
          ? "No anchors found in tape. Use tape_handoff to create an anchor."
          : `Found ${anchorsWithContext.length} anchor(s):\n\n` +
            anchorsWithContext
              .map((a) => {
                const stateStr = Object.keys(a.state).length > 0 ? `\n  State: ${JSON.stringify(a.state)}` : "";
                
                let contextStr = "";
                if (a.beforeContext.length > 0) {
                  contextStr += "\n  Before:\n    " + a.beforeContext.join("\n    ");
                }
                if (a.afterContext.length > 0) {
                  contextStr += "\n  After:\n    " + a.afterContext.join("\n    ");
                }
                
                return `  - ${a.name} (${new Date(a.timestamp).toLocaleString()})${stateStr}${contextStr}`;
              })
              .join("\n\n");

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

    renderResult(result, { isPartial, expanded }: RenderState, theme) {
      const details = result.details as { anchors?: Array<{ name: string; timestamp: string; state: Record<string, unknown>; beforeContext: string[]; afterContext: string[] }>; count?: number } | undefined;
      const content = result.content[0];

      if (isPartial) {
        return renderPartial(theme, "Listing anchors...");
      }

      if (!expanded && details?.anchors && details.anchors.length > 0) {
        const first = details.anchors[0];
        const time = new Date(first.timestamp).toLocaleTimeString();
        
        // Calculate total line count for expand hint
        let lineCount = 1; // anchor name line
        if (first.beforeContext.length > 0) {
          lineCount += 1 + first.beforeContext.length; // "Before:" + context lines
        }
        if (first.afterContext.length > 0) {
          lineCount += 1 + first.afterContext.length; // "After:" + context lines
        }
        if (Object.keys(first.state).length > 0) {
          lineCount += 1; // state line
        }
        
        // Total anchors to show (for hint)
        const totalAnchors = details.count ?? 1;
        
        let summary = theme.fg("success", `${first.name} (${time})`);

        if (first.beforeContext.length > 0) {
          summary += "\n" + theme.fg("muted", "Before:");
          first.beforeContext.forEach((ctx) => {
            summary += "\n  " + theme.fg("muted", ctx);
          });
        }

        if (first.afterContext.length > 0) {
          summary += "\n" + theme.fg("muted", "After:");
          first.afterContext.forEach((ctx) => {
            summary += "\n  " + theme.fg("muted", ctx);
          });
        }
        
        if (Object.keys(first.state).length > 0) {
          summary += "\n" + theme.fg("muted", `State: ${JSON.stringify(first.state)}`);
        }

        return renderWithExpandHint(summary, theme, totalAnchors);
      }

      if (!expanded) {
        return renderCollapsed(theme, `${details?.count ?? 0} anchor(s)`);
      }

      return renderExpanded(theme, content);
    },
  });
}

function formatEntrySummary(entry: { kind: string; timestamp: string; payload: Record<string, unknown> }): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  
  switch (entry.kind) {
    case "message/user":
      return `[${time}] User: ${(entry.payload.content as string)?.substring(0, 50) ?? ""}...`;
    case "message/assistant":
      return `[${time}] Assistant: ${(entry.payload.content as string)?.substring(0, 50) ?? ""}...`;
    case "tool_call":
      return `[${time}] Tool: ${entry.payload.tool}`;
    case "tool_result":
      return `[${time}] Result: ${entry.payload.tool}`;
    case "memory/read":
      return `[${time}] Memory read: ${entry.payload.path}`;
    case "memory/write":
      return `[${time}] Memory write: ${entry.payload.path}`;
    case "anchor":
      return `[${time}] Anchor: ${entry.payload.name ?? "unnamed"}`;
    case "session/start":
      return `[${time}] Session start`;
    default:
      return `[${time}] ${entry.kind}`;
  }
}

export function registerTapeInfo(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  pi.registerTool({
    name: "tape_info",
    label: "Tape Info",
    description: "Get tape information (entries, anchors, last anchor, etc.)",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const info = tapeService.getInfo();
      const lastAnchorName = info.lastAnchor
        ? (info.lastAnchor.payload.name as string) ?? info.lastAnchor.kind
        : "none";
      const tapeFileCount = tapeService.getTapeFileCount();

      const recommendation =
        info.entriesSinceLastAnchor > 20
          ? "\n\n💡 Recommendation: Context is getting large. Consider using tape_handoff to create a new checkpoint."
          : info.entriesSinceLastAnchor > 10
            ? "\n\n⚠️  Warning: Context is growing. You may want to use tape_handoff soon."
            : "";

      const summary = [
        `📊 Tape Information:`,
        `  Tape files: ${tapeFileCount}`,
        `  Total entries: ${info.totalEntries}`,
        `  Anchors: ${info.anchorCount}`,
        `  Last anchor: ${lastAnchorName}`,
        `  Entries since last anchor: ${info.entriesSinceLastAnchor}`,
        `  Memory operations: ${info.memoryReads} reads, ${info.memoryWrites} writes`,
        recommendation,
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: {
          tapeFileCount,
          totalEntries: info.totalEntries,
          anchorCount: info.anchorCount,
          lastAnchor: info.lastAnchor?.id,
          lastAnchorName,
          entriesSinceLastAnchor: info.entriesSinceLastAnchor,
          memoryReads: info.memoryReads,
          memoryWrites: info.memoryWrites,
        },
      };
    },

    renderCall(_args, theme) {
      return renderText(theme.fg("toolTitle", theme.bold("tape_info")));
    },

    renderResult(result, { isPartial, expanded }: RenderState, theme) {
      const content = result.content[0];
      
      if (isPartial) return renderPartial(theme, "Getting info...");
      
      if (!expanded) {
        const details = result.details as { totalEntries?: number; anchorCount?: number } | undefined;
        const lines = content?.type === "text" ? content.text.split("\n") : [];
        const summary = `📊 ${details?.totalEntries ?? 0} entries, ${details?.anchorCount ?? 0} anchors`;
        return renderWithExpandHint(theme.fg("success", summary), theme, lines.length);
      }
      
      return renderExpanded(theme, content);
    },
  });
}

const ENTRY_KINDS = [
  "memory/read",
  "memory/write",
  "memory/search",
  "message/user",
  "message/assistant",
  "tool_call",
  "tool_result",
  "anchor",
  "session/start",
] as const;

export function registerTapeSearch(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  pi.registerTool({
    name: "tape_search",
    label: "Tape Search",
    description: "Search tape entries by kind or content",
    parameters: Type.Object({
      kinds: Type.Optional(Type.Array(Type.Union(
        ENTRY_KINDS.map((k) => Type.Literal(k))
      ))),
      limit: Type.Optional(Type.Integer({
        description: "Maximum number of results (default: 20)",
        minimum: 1,
        maximum: 100,
      })),
      sinceAnchor: Type.Optional(Type.String({
        description: "Anchor ID to search from (entries after this anchor)",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { kinds, limit = 20, sinceAnchor } = params as {
        kinds?: string[];
        limit?: number;
        sinceAnchor?: string;
      };

      const entries = tapeService.query({ kinds: kinds as any, limit, sinceAnchor });

      const summary = [
        `Tape search results: ${entries.length} match(es)`,
        ...(kinds ? [`Filtered by kinds: ${kinds.join(", ")}`] : []),
        ...(sinceAnchor ? [`Since anchor: ${sinceAnchor}`] : []),
        "",
        ...entries.slice(0, limit).map((e) => {
          const timestamp = new Date(e.timestamp).toLocaleTimeString();
          const payload = JSON.stringify(e.payload).slice(0, 80);
          return `[${timestamp}] ${e.kind}: ${payload}...`;
        }),
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { entries, count: entries.length, filtered: kinds?.length ? entries.length : 0 },
      };
    },

    renderCall(args, theme) {
      const text = theme.fg("toolTitle", theme.bold("tape_search")) + (args.kinds ? ` ${theme.fg("muted", args.kinds.join(","))}` : "");
      return renderText(text);
    },

    renderResult(result, { isPartial, expanded }: RenderState, theme) {
      const content = result.content[0];
      
      if (isPartial) return renderPartial(theme, "Searching...");
      
      if (!expanded) {
        const details = result.details as { count?: number } | undefined;
        const lines = content?.type === "text" ? content.text.split("\n") : [];
        const summary = `${details?.count ?? 0} match(es)`;
        return renderWithExpandHint(theme.fg("success", summary), theme, lines.length);
      }
      
      return renderExpanded(theme, content);
    },
  });
}

export function registerTapeReset(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  pi.registerTool({
    name: "tape_reset",
    label: "Tape Reset",
    description: "Reset the tape (creates a new session/start anchor)",
    parameters: Type.Object({
      archive: Type.Optional(Type.Boolean({
        description: "Archive old tape before reset (default: false)",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { archive = false } = params as { archive?: boolean };

      tapeService.clear();
      tapeService.recordSessionStart();

      const summary = archive
        ? "Tape archived and reset with new session/start anchor"
        : "Tape reset with new session/start anchor";

      return {
        content: [{ type: "text", text: summary }],
        details: { archived: archive },
      };
    },

    renderCall(args, theme) {
      const text = theme.fg("toolTitle", theme.bold("tape_reset")) + (args.archive ? ` ${theme.fg("warning", "--archive")}` : "");
      return renderText(text);
    },

    renderResult(result, { isPartial, expanded }: RenderState, theme) {
      const content = result.content[0] as { type: string; text: string } | undefined;
      
      if (isPartial) return renderPartial(theme, "Resetting...");
      
      if (!expanded) {
        const lines = content?.text?.split("\n") ?? [];
        return renderWithExpandHint(theme.fg("success", content?.text ?? ""), theme, lines.length);
      }
      
      return renderText(theme.fg("success", content?.text ?? ""));
    },
  });
}

export function registerTapeRead(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  pi.registerTool({
    name: "tape_read",
    label: "Tape Read",
    description: "Read tape entries as formatted messages (for context). Supports fluent query: after anchor, between dates, text search, kind filter, limit",
    parameters: Type.Object({
      afterAnchor: Type.Optional(Type.String({
        description: "Anchor name to read entries after (e.g., 'task/start')",
      })),
      lastAnchor: Type.Optional(Type.Boolean({
        description: "Read entries after the last anchor (default: false)",
      })),
      betweenAnchors: Type.Optional(Type.Object({
        start: Type.String({ description: "Start anchor name" }),
        end: Type.String({ description: "End anchor name" }),
      }, { description: "Read entries between two anchors" })),
      betweenDates: Type.Optional(Type.Object({
        start: Type.String({ description: "Start date (ISO format, e.g., '2026-01-01')" }),
        end: Type.String({ description: "End date (ISO format, e.g., '2026-01-31')" }),
      }, { description: "Read entries between two dates" })),
      query: Type.Optional(Type.String({
        description: "Text search in entry content",
      })),
      kinds: Type.Optional(Type.Array(Type.Union(
        ENTRY_KINDS.map((k) => Type.Literal(k))
      ))),
      limit: Type.Optional(Type.Integer({
        description: "Maximum number of entries to return (default: 20)",
        minimum: 1,
        maximum: 100,
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const {
        afterAnchor,
        betweenAnchors,
        betweenDates,
        kinds,
        lastAnchor = false,
        limit = 20,
        query,
      } = params as {
        afterAnchor?: string;
        lastAnchor?: boolean;
        betweenAnchors?: { start: string; end: string };
        betweenDates?: { start: string; end: string };
        query?: string;
        kinds?: string[];
        limit?: number;
      };

      let entries;
      if (betweenAnchors) {
        const startAnchor = tapeService.findAnchorByName(betweenAnchors.start);
        const endAnchor = tapeService.findAnchorByName(betweenAnchors.end);
        if (!startAnchor || !endAnchor) {
          return {
            content: [{ type: "text", text: "Error: Anchor not found" }],
            details: { error: "One or both anchors not found" },
          };
        }
        entries = tapeService.query({ sinceAnchor: startAnchor.id, kinds: kinds as any, limit });
        const endAnchorEntries = tapeService.query({ sinceAnchor: endAnchor.id, limit: 1 });
        if (endAnchorEntries.length > 0) {
          const endIdx = entries.findIndex((e) => e.id === endAnchor.id);
          if (endIdx >= 0) entries = entries.slice(0, endIdx);
        }
      } else if (betweenDates) {
        entries = tapeService.query({ betweenDates, query, kinds: kinds as any, limit });
      } else if (afterAnchor) {
        const anchor = tapeService.findAnchorByName(afterAnchor);
        if (!anchor) {
          return {
            content: [{ type: "text", text: `Error: Anchor '${afterAnchor}' not found` }],
            details: { error: "Anchor not found" },
          };
        }
        entries = tapeService.query({ sinceAnchor: anchor.id, query, kinds: kinds as any, limit });
      } else if (lastAnchor) {
        entries = tapeService.query({ lastAnchor: true, query, kinds: kinds as any, limit });
      } else {
        entries = tapeService.query({ query, kinds: kinds as any, limit });
      }

      const messages = formatEntriesAsMessages(entries);
      const summary =
        `Retrieved ${messages.length} messages from tape:\n\n` +
        messages.map((m) => `${m.role}: ${m.content.slice(0, 100)}${m.content.length > 100 ? "..." : ""}`).join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { messages, count: messages.length },
      };
    },

    renderCall(args, theme) {
      const parts = [theme.fg("toolTitle", theme.bold("tape_read"))];
      if (args.afterAnchor) parts.push(theme.fg("muted", `afterAnchor=${args.afterAnchor}`));
      if (args.lastAnchor) parts.push(theme.fg("muted", "lastAnchor"));
      if (args.query) parts.push(theme.fg("muted", `query="${args.query}"`));
      if (args.limit) parts.push(theme.fg("muted", `limit=${args.limit}`));
      return renderText(parts.join(" "));
    },

    renderResult(result, { isPartial, expanded }: RenderState, theme) {
      const content = result.content[0];
      
      if (isPartial) return renderPartial(theme, "Reading tape...");
      
      if (!expanded) {
        const details = result.details as { count?: number } | undefined;
        const lines = content?.type === "text" ? content.text.split("\n") : [];
        const summary = `${details?.count ?? 0} messages`;
        return renderWithExpandHint(theme.fg("success", summary), theme, lines.length);
      }
      
      return renderExpanded(theme, content);
    },
  });
}

export function registerAllTapeTools(
  pi: ExtensionAPI,
  tapeService: MemoryTapeService,
): void {
  registerTapeHandoff(pi, tapeService);
  registerTapeAnchors(pi, tapeService);
  registerTapeInfo(pi, tapeService);
  registerTapeSearch(pi, tapeService);
  registerTapeRead(pi, tapeService);
  registerTapeReset(pi, tapeService);
}
