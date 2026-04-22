/**
 * Tape layer for pi-memory-md
 * Uses pi session as data source, only maintains anchor store data
 * Entry types are directly from pi SessionEntry
 *
 * @see https://tape.systems
 * @see https://bub.build/
 */

// always keep the comments in this file，it's necessary.

import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export type TapeContextStrategy = "recent-only" | "smart";

/**
 * Tape query options - filter pi session entries
 *
 * @description
 * - `query`: Text search in entry content
 * - `types`: Filter by session entry type (message, custom, etc.)
 * - `limit`: Maximum results to return
 * - `sinceAnchor` / `lastAnchor`: Filter entries after a specific anchor
 * - `betweenAnchors`: Get entries between two anchors
 * - `betweenDates`: Get entries within date range (ISO format)
 * - `scope`: Entry source scope (`session` or `project`)
 * - `anchorScope`: Anchor resolution scope (`current-session` or `project`)
 */
export interface TapeQueryOptions {
  /** Text search in entry content (case-insensitive) */
  query?: string;
  /** Filter by session entry type */
  types?: SessionEntry["type"][];
  /** Maximum number of results to return (default: 20) */
  limit?: number;
  /** Get entries after this anchor name */
  sinceAnchor?: string;
  /** Get entries after the last anchor in current session */
  lastAnchor?: boolean;
  /** Get entries between two anchors */
  betweenAnchors?: { start: string; end: string };
  /** Get entries within date range (ISO format) */
  betweenDates?: { start: string; end: string };
  /** Entry source scope (default: project) */
  scope?: "session" | "project";
  /** Anchor resolution scope (default: current-session) */
  anchorScope?: "current-session" | "project";
}

export type ContextStrategy = TapeContextStrategy;

export interface ContextSelection {
  files: string[];
  reason: string;
}

/**
 * Tape configuration options
 *
 * @description
 * - `tapePath`: Custom tape path (default: {localPath}/TAPE: ~/.pi/memory-md/TAPE)
 * - `context`: Memory file selection strategy
 * - `anchor`: Auto-anchor behavior settings
 */
export interface TapeConfig {
  /** Enable tape mode */
  enabled?: boolean;
  /** Custom anchor store path (optional, default: {localPath}/TAPE) */
  tapePath?: string;
  /** Memory file selection configuration */
  context?: {
    /** Selection strategy: "smart" (default) or "recent-only" */
    strategy?: TapeContextStrategy;
    /** Maximum number of memory files to inject (default: 10) */
    fileLimit?: number;
    /** Files to always include in context (default: []) */
    alwaysInclude?: string[];
  };
  /** Anchor auto-creation settings */
  anchor?: {
    /** Auto-anchor mode: "hand" (manual only), "threshold" (auto), or "manual" (default: "threshold") */
    mode?: "hand" | "threshold" | "manual";
    /** Entries since last anchor before auto-creating new anchor (default: 15) */
    threshold?: number;
    /** Prefix mirrored into pi /tree labels for anchor nodes */
    labelPrefix?: string;
  };
}

export type RenderState = { expanded: boolean; isPartial: boolean };
