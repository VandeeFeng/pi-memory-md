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

export type HookTrigger = "sessionStart" | "sessionEnd";
export type BuiltinHookAction = "pull" | "push";
export type HookAction = BuiltinHookAction | (string & {});
export type HookConfig = Partial<Record<HookTrigger, HookAction[]>>;

export interface MemoryMdSettings {
  enabled?: boolean;
  repoUrl?: string;
  localPath?: string;
  hooks?: HookConfig;
  injection?: "system-prompt" | "message-append";
  tape?: TapeConfig;
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
}

export type ParsedFrontmatter = GrayMatterFile<string>["data"];
