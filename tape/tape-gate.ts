import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type PreparedBm25Docs, prepareBm25Docs, searchPreparedBm25Docs } from "../bm25.js";
import type { MemoryMdSettings, ProjectMeta } from "../types.js";
import { formatTimeSuffix, getProjectMeta, isPathInside, toTimestamp } from "../utils.js";
import type { TapeAnchor } from "./tape-anchor.js";
import { DEFAULT_FORMATTED_ENTRY_CONTENT_CHARS, extractMessageContent, formatEntryLine } from "./tape-context.js";
import { parseSessionFile } from "./tape-reader.js";
import type { PendingHandoffMatch } from "./tape-tools.js";
import type { TapeConfig, TapeKeywordConfig } from "./tape-types.js";

// Resolve tape gate state from cwd and settings.
export type TapeGateReason = "disabled" | "excluded-dir" | "missing-git" | "enabled";

export interface TapeGateResult {
  enabled: boolean;
  reason: TapeGateReason;
  project: ProjectMeta | null;
  matchedExcludeDir?: string;
}

export type KeywordHandoffInstruction = {
  primary: string;
  matched: string[];
  anchorName: string;
  message: string;
};

export type PreparedSessionBridge = {
  sessionId: string;
  anchors: PreparedBm25Docs<TapeAnchor> | null;
  messages: PreparedBm25Docs<SessionEntry> | null;
};

export type SessionBridgePrepareOptions = {
  previousSessionFile?: string;
  anchorStore?: {
    scan: (options: { sessionId?: string; type: "handoff"; limit?: number }) => TapeAnchor[];
  };
  maxGapSeconds?: number;
};

export type SessionBridgeOptions = SessionBridgePrepareOptions & {
  prompt: string;
  minScore?: number;
  maxAnchors?: number;
  maxMessages?: number;
  maxChars?: number;
};

export type PreparedSessionBridgeOptions = {
  prepared: PreparedSessionBridge | null;
  prompt: string;
  minScore?: number;
  maxAnchors?: number;
  maxMessages?: number;
  maxChars?: number;
};

const DEFAULT_SESSION_BRIDGE_MAX_GAP_SECONDS = 60;
const DEFAULT_SESSION_BRIDGE_MIN_SCORE = 0.5;
const DEFAULT_SESSION_BRIDGE_MAX_ANCHORS = 3;
const DEFAULT_SESSION_BRIDGE_MAX_MESSAGES = 5;
const DEFAULT_SESSION_BRIDGE_MAX_CHARS = 3000;

export function shouldBlockTapeHandoffCall(
  settings: MemoryMdSettings,
  state: { pendingHandoffMatch: PendingHandoffMatch | null },
  name: unknown,
): string | null {
  const handoffMode = settings.tape?.anchor?.mode ?? "auto";
  if (handoffMode !== "manual") return null;

  const handoffMatch = state.pendingHandoffMatch;
  if (handoffMatch?.trigger === "manual") return null;

  if (handoffMatch?.trigger === "keyword" && handoffMatch.instruction.anchorName === name) return null;

  if (handoffMatch?.trigger === "keyword") {
    state.pendingHandoffMatch = null;
  }

  return 'tape_handoff is disabled when tape.anchor.mode="manual" unless a keyword or manual handoff match is present.';
}

export function resolveTapeGate(cwd: string, tape?: TapeConfig): TapeGateResult {
  const absoluteCwd = path.resolve(cwd);

  if (!tape?.enabled) {
    return {
      enabled: false,
      reason: "disabled",
      project: null,
    };
  }

  for (const excludedDir of tape.excludeDirs ?? []) {
    if (isPathInside(excludedDir, absoluteCwd)) {
      return {
        enabled: false,
        reason: "excluded-dir",
        project: null,
        matchedExcludeDir: path.resolve(excludedDir),
      };
    }
  }

  const project = getProjectMeta(absoluteCwd);
  if (tape.onlyGit !== false && !project.gitRoot) {
    return {
      enabled: false,
      reason: "missing-git",
      project: null,
    };
  }

  return {
    enabled: true,
    reason: "enabled",
    project,
  };
}

// Detect keyword-triggered handoff instructions before normal tape processing.
const MIN_KEYWORD_PROMPT_LENGTH = 10;
const MAX_KEYWORD_PROMPT_LENGTH = 300;

export function normalizeTapeKeywords(config?: TapeKeywordConfig): TapeKeywordConfig {
  return {
    global: normalizeKeywordList(config?.global),
    project: normalizeKeywordList(config?.project),
  };
}

export function detectKeywordHandoff(prompt: string, config?: TapeKeywordConfig): KeywordHandoffInstruction | null {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length < MIN_KEYWORD_PROMPT_LENGTH || normalizedPrompt.length > MAX_KEYWORD_PROMPT_LENGTH) {
    return null;
  }

  const keywords = [...normalizeKeywordList(config?.global), ...normalizeKeywordList(config?.project)];
  const matched = [...new Set(keywords.filter((keyword) => matchesKeyword(normalizedPrompt, keyword)))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );

  if (matched.length === 0) return null;

  const primary = matched[0];
  const anchorName = `handoff/keyword-${slugifyKeyword(primary)}-${formatTimeSuffix()}`;
  const message = [
    `Keyword detected: ${primary}.`,
    "",
    "Before continuing, call tape_handoff with:",
    `- name: "${anchorName}"`,
    "- summary: \"<brief intent summary of the user's current prompt in the user's language>\"",
    '- purpose: "<1-2 word label for the anchor\'s purpose>"',
    "",
    "Constraints:",
    "- Make the summary specific to the actual task.",
    "- Do not use a generic keyword-only summary.",
    "- Keep the summary under 18 words.",
    "",
    "Then continue the user's task normally.",
  ].join("\n");

  return { primary, matched, anchorName, message };
}

export function buildKeywordHandoffMessage(prompt: string, config?: TapeKeywordConfig): string | null {
  return detectKeywordHandoff(prompt, config)?.message ?? null;
}

export async function prepareSessionBridge(
  options: SessionBridgePrepareOptions,
): Promise<PreparedSessionBridge | null> {
  if (!options.previousSessionFile) return null;

  const parsed = parseSessionFile(options.previousSessionFile);
  if (!parsed) return null;

  const lastEntry = parsed.entries.at(-1);
  if (!lastEntry || !isWithinBridgeWindow(lastEntry.timestamp, options.maxGapSeconds)) return null;

  const anchors = options.anchorStore?.scan({ sessionId: parsed.header.id, type: "handoff" }) ?? [];
  const messages = parsed.entries.filter(isBridgeMessageEntry);

  return {
    sessionId: parsed.header.id,
    anchors: await prepareBm25Docs(
      anchors.map((anchor) => ({
        id: anchor.id,
        content: [anchor.name, anchor.meta?.summary, anchor.meta?.purpose].filter(Boolean).join("\n"),
        data: anchor,
      })),
    ),
    messages: await prepareBm25Docs(
      messages.map((entry) => ({ id: entry.id, content: extractMessageContent(entry.message.content), data: entry })),
    ),
  };
}

export async function buildSessionBridgeContext(options: SessionBridgeOptions): Promise<string | null> {
  const prepared = await prepareSessionBridge(options);
  return renderSessionBridge({ ...options, prepared });
}

export async function renderSessionBridge(options: PreparedSessionBridgeOptions): Promise<string | null> {
  const prompt = options.prompt.trim();
  if (!prompt || !options.prepared) return null;

  const minScore = options.minScore ?? DEFAULT_SESSION_BRIDGE_MIN_SCORE;
  const anchorLines = await renderBridgeAnchors(options.prepared.anchors, prompt, options, minScore);
  const contextLines = await renderBridgeMessages(options.prepared.messages, prompt, options, minScore);

  return renderBridgeXml(
    [
      { tag: "tape_anchors", lines: anchorLines },
      { tag: "relevant_context", lines: contextLines },
    ],
    options.maxChars ?? DEFAULT_SESSION_BRIDGE_MAX_CHARS,
  );
}

function isWithinBridgeWindow(timestamp: string, maxGapSeconds = DEFAULT_SESSION_BRIDGE_MAX_GAP_SECONDS): boolean {
  return Date.now() - toTimestamp(timestamp) <= maxGapSeconds * 1000;
}

async function renderBridgeAnchors(
  anchors: PreparedBm25Docs<TapeAnchor> | null,
  prompt: string,
  options: { maxAnchors?: number },
  minScore: number,
): Promise<string[]> {
  const matches = await searchPreparedBm25Docs(
    anchors,
    prompt,
    options.maxAnchors ?? DEFAULT_SESSION_BRIDGE_MAX_ANCHORS,
  );

  const lines = matches
    .filter((match) => match.score >= minScore)
    .map(({ data }) => {
      const summary = data.meta?.summary ? ` summary="${escapeXml(data.meta.summary)}"` : "";
      const purpose = data.meta?.purpose ? ` purpose="${escapeXml(data.meta.purpose)}"` : "";
      return `  <anchor name="${escapeXml(data.name)}"${summary}${purpose} />`;
    });

  return lines;
}

async function renderBridgeMessages(
  entries: PreparedBm25Docs<SessionEntry> | null,
  prompt: string,
  options: { maxMessages?: number },
  minScore: number,
): Promise<string[]> {
  const matches = await searchPreparedBm25Docs(
    entries,
    prompt,
    options.maxMessages ?? DEFAULT_SESSION_BRIDGE_MAX_MESSAGES,
  );

  const lines = matches
    .filter((match) => match.score >= minScore)
    .map((match) => formatEntryLine(match.data, DEFAULT_FORMATTED_ENTRY_CONTENT_CHARS))
    .filter((line): line is string => line !== null)
    .map((line) => `  ${escapeXml(line)}`);

  return lines;
}

function isBridgeMessageEntry(
  entry: SessionEntry,
): entry is SessionEntry & { message: { role: string; content?: unknown } } {
  return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderBridgeXml(sections: Array<{ tag: string; lines: string[] }>, maxChars: number): string | null {
  const output = ["<session_bridge>"];

  for (const section of sections) {
    const acceptedLines: string[] = [];

    for (const line of section.lines) {
      const candidate = [
        ...output,
        `<${section.tag}>`,
        ...acceptedLines,
        line,
        `</${section.tag}>`,
        "</session_bridge>",
      ].join("\n");

      if (candidate.length > maxChars) break;
      acceptedLines.push(line);
    }

    if (acceptedLines.length > 0) {
      output.push(`<${section.tag}>`, ...acceptedLines, `</${section.tag}>`);
    }
  }

  return output.length > 1 ? [...output, "</session_bridge>"].join("\n") : null;
}

function normalizeKeywordList(keywords?: string[]): string[] {
  if (!Array.isArray(keywords)) return [];

  return [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesKeyword(prompt: string, keyword: string): boolean {
  const pattern = `(^|[^\\p{L}\\p{N}_])${escapeRegex(keyword)}(?=$|[^\\p{L}\\p{N}_])`;
  return new RegExp(pattern, "iu").test(prompt);
}

function slugifyKeyword(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "detected";
}
