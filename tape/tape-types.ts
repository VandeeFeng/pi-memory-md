/**
 * Tape layer for pi-memory-md
 * Records memory operations and provides dynamic context injection
 */

// always keep the comments in this file，it's necessary.

export type TapeEntryKind =
  // Memory operations
  | "memory/read"
  | "memory/write"
  | "memory/search"
  | "memory/sync"
  | "memory/init"
  // Conversation events
  | "message/user"
  | "message/assistant"
  | "tool_call"
  | "tool_result"
  // Checkpoints
  | "session/start"
  | "anchor";

export type TapeContextStrategy = "recent-only" | "smart";

export interface TapeEntry {
  id: string;
  kind: TapeEntryKind;
  timestamp: string;
  turn?: number; // Track conversation turn
  payload: Record<string, unknown>;
}

export interface TapeQueryOptions {
  query?: string; // Text search in entry payload
  kinds?: TapeEntryKind[];
  limit?: number;
  since?: string; // ISO timestamp
  sinceAnchor?: string; // anchor ID
  lastAnchor?: boolean; // Get entries after the last anchor
  betweenAnchors?: { start: string; end: string }; // Get entries between two anchors (by name)
  betweenDates?: { start: string; end: string }; // Get entries between two dates (ISO format)
}

export type ContextStrategy = TapeContextStrategy;

export interface ContextSelection {
  files: string[];
  reason: string;
}

export interface TapeConfig {
  tapePath?: string;
  context?: {
    strategy: TapeContextStrategy; // "smart" (default) or "recent-only"
    fileLimit?: number; // Max files to inject (default: 10)
    alwaysInclude?: string[]; // Files to always include (default: [])
    maxTapeTokens?: number; // Max tokens for tape context (default: 1000)
    maxTapeEntries?: number; // Max entries to consider before token limit (default: 40)
    includeConversationHistory?: boolean; // Include conversation history (default: true)
  };
  anchor?: {
    mode: "hand" | "threshold"; // Auto-anchor strategy (default: "threshold")
    threshold?: number; // Entries since last anchor before auto-creating (default: 15)
  };
}

export type RenderState = { expanded: boolean; isPartial: boolean };
