import type { GrayMatterFile } from "gray-matter";
import type { TapeConfig } from "./tape/tape-types.js";

/**
 * Type definitions for memory files, settings, and git operations.
 */

export interface MemoryFrontmatter {
  description: string;
  limit?: number;
  tags?: string[];
  created?: string;
  updated?: string;
}

export interface MemoryFile {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

export interface ProjectMeta {
  cwd: string;
  gitRoot: string | null;
  root: string;
  name: string;
  isWorktree: boolean;
  mainRoot?: string;
}

export interface MemoryMeta extends ProjectMeta {
  initialized: boolean;
  memoryPath: string;
  project: {
    scope: "project";
    dir: string;
    exists: boolean;
    fileCount: number;
  };
  global: {
    scope: "global";
    dir: string | null;
    exists: boolean;
    fileCount: number | null;
  };
}

export type HookTrigger = "sessionStart" | "sessionEnd" | "beforeAgentStart";
export type BuiltinHookAction = "pull" | "push" | "sessionBridge";
export type HookAction = BuiltinHookAction | (string & {});
export type HookConfig = Partial<Record<HookTrigger, HookAction[]>>;
export type MemoryDeliveryMode = "system-prompt" | "message-append";

export interface MemoryMdSettings {
  enabled?: boolean;
  repoUrl?: string;
  localPath?: string;
  hooks?: HookConfig;
  delivery?: MemoryDeliveryMode;
  /** @deprecated Use `delivery` instead. */
  injection?: MemoryDeliveryMode;
  tape?: TapeConfig;
  /**
   * Character budget for the injected memory index. Entries past the budget are
   * dropped (global memory first, project entries last) and a notice is injected
   * so the model knows the index is incomplete. 0 disables the cap.
   */
  maxContextChars?: number;
  /**
   * When true, write `<memoryDir>/core/state.md` just before a compaction: files
   * edited this session plus the last request. Deterministic on purpose — no model
   * call, no extra latency. Off by default because it writes a file for you.
   */
  stateCapture?: boolean;
  memoryDir?: {
    repoUrl?: string;
    localPath?: string;
    globalMemory?: string;
  };
}

export interface GitResult {
  stdout: string;
  success: boolean;
  timeout?: boolean;
}

export interface SyncResult {
  success: boolean;
  message: string;
  updated?: boolean;
  level?: "info" | "warning" | "error";
}

export type ParsedFrontmatter = GrayMatterFile<string>["data"];
