import path from "node:path";
import { findGitTopLevel, formatTimeSuffix, isPathInside } from "../utils.js";
import type { TapeConfig, TapeKeywordConfig } from "./tape-types.js";

// Gate tape usage by checking whether the current cwd should activate tape.
export type TapeActivationReason = "disabled" | "excluded-dir" | "missing-git" | "enabled";

export interface TapeActivationResult {
  enabled: boolean;
  reason: TapeActivationReason;
  cwd: string;
  projectRoot: string | null;
  projectName: string | null;
  matchedExcludeDir?: string;
}

export type KeywordHandoffInstruction = {
  primary: string;
  matched: string[];
  anchorName: string;
  message: string;
};

export function findMatchedExcludeDir(cwd: string, excludeDirs: string[]): string | null {
  const currentDir = path.resolve(cwd);

  for (const excludedDir of excludeDirs) {
    if (isPathInside(excludedDir, currentDir)) {
      return path.resolve(excludedDir);
    }
  }

  return null;
}

export function resolveTapeActivation(cwd: string, tape?: TapeConfig): TapeActivationResult {
  const normalizedCwd = path.resolve(cwd);

  if (!tape?.enabled) {
    return {
      enabled: false,
      reason: "disabled",
      cwd: normalizedCwd,
      projectRoot: null,
      projectName: null,
    };
  }

  const matchedExcludeDir = findMatchedExcludeDir(normalizedCwd, tape.excludeDirs ?? []);
  if (matchedExcludeDir) {
    return {
      enabled: false,
      reason: "excluded-dir",
      cwd: normalizedCwd,
      projectRoot: null,
      projectName: null,
      matchedExcludeDir,
    };
  }

  if (tape.onlyGit !== false) {
    const projectRoot = findGitTopLevel(normalizedCwd);
    if (!projectRoot) {
      return {
        enabled: false,
        reason: "missing-git",
        cwd: normalizedCwd,
        projectRoot: null,
        projectName: null,
      };
    }

    return {
      enabled: true,
      reason: "enabled",
      cwd: normalizedCwd,
      projectRoot,
      projectName: path.basename(projectRoot),
    };
  }

  return {
    enabled: true,
    reason: "enabled",
    cwd: normalizedCwd,
    projectRoot: normalizedCwd,
    projectName: path.basename(normalizedCwd),
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
