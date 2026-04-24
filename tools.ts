import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  getCurrentDate,
  getMemoryCoreDir,
  getMemoryDir,
  initializeMemoryDirectory,
  isMemoryInitialized,
  listMemoryFilesAsync,
  readMemoryFileAsync,
  writeMemoryFile,
} from "./memory-core.js";
import { gitExec, pushRepository, syncRepository } from "./memory-git.js";
import type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";
import { getGitDir, getProjectName, hasSymlinkInPath, resolvePathWithin } from "./utils.js";

// Re-export types for convenience
export type { ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
export type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";

const MEMORY_SEARCH_TIMEOUT_MS = 5000;
const MAX_SEARCH_PATTERN_LENGTH = 200;
const MAX_SEARCH_RESULTS = 50;

// ============================================================================
// Render Utilities - Inline for simplicity
// ============================================================================

function renderText(text: string): Text {
  return new Text(text, 0, 0);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? `"${value}"` : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "object" && value !== null) return "{...}";
  return String(value);
}

function buildToolCallText(name: string, args: Record<string, unknown>, theme: Theme): string {
  const text = theme.fg("toolTitle", theme.bold(name));
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return text;
  const [_key, value] = entries[0];
  return `${text} ${theme.fg("accent", formatValue(value))}`;
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

function buildExpandHint(totalLines: number, theme: Theme): string {
  const remaining = totalLines - 1;
  if (remaining <= 0) return "";
  return (
    "\n" +
    theme.fg("muted", `... (${remaining} more lines,`) +
    " " +
    keyHint("app.tools.expand", "to expand") +
    theme.fg("muted", ")")
  );
}

function renderCollapsed(summary: string, fullText: string, options: { expanded: boolean }, theme: Theme): Text {
  if (options.expanded) return renderText(theme.fg("toolOutput", fullText));
  return renderText(theme.fg("success", summary) + buildExpandHint(fullText.split("\n").length, theme));
}

function renderMemoryResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  defaults?: { description?: string; tags?: string[] },
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Reading..."));
  const details = result.details as
    | { error?: boolean; frontmatter?: { description?: string; tags?: string[] } }
    | undefined;
  if (details?.error) return renderText(theme.fg("error", getResultText(result) || "Error"));

  const description = defaults?.description || details?.frontmatter?.description || "Memory file";
  const tags = defaults?.tags || details?.frontmatter?.tags || [];
  const text = getResultText(result);

  if (!options.expanded) {
    const summary = `${theme.fg("success", description)}\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}`;
    return renderText(summary + buildExpandHint(text.split("\n").length + 2, theme));
  }

  return renderText(
    theme.fg("success", description) +
      `\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}\n${theme.fg("toolOutput", text)}`,
  );
}

function renderSyncResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Syncing..."));
  const details = result.details as { success?: boolean; initialized?: boolean; timeout?: boolean } | undefined;
  if (details?.initialized === false) return renderText(theme.fg("muted", "Not initialized"));
  if (details?.timeout) return renderText(theme.fg("error", getResultText(result)));

  const text = getResultText(result);
  if (!options.expanded) {
    const lines = text.split("\n");

    if (details?.success === false) {
      return renderText(theme.fg("error", lines[0] || "Operation failed") + buildExpandHint(lines.length, theme));
    }

    const summary = details?.success
      ? theme.fg("success", lines[0] || "Success")
      : theme.fg("success", lines[0] || "Status");
    return renderText(summary + buildExpandHint(lines.length, theme));
  }

  return renderText(theme.fg("toolOutput", text));
}

function renderCountResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  label: string,
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Loading..."));
  const details = result.details as { count?: number } | undefined;
  const text = getResultText(result);
  if (!options.expanded)
    return renderText(
      theme.fg("success", `${details?.count ?? 0} ${label}`) + buildExpandHint(text.split("\n").length, theme),
    );
  return renderText(theme.fg("toolOutput", text));
}

export function registerMemorySync(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_sync",
    label: "Memory Sync",
    description: "Synchronize memory repository with git (pull/push/status)",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("pull"), Type.Literal("push"), Type.Literal("status")], {
        description: "Action to perform",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action } = params as { action: "pull" | "push" | "status" };
      const localPath = settings.localPath!;
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      if (action === "status") {
        const initialized = isMemoryInitialized(memoryDir) && fs.existsSync(getGitDir(localPath));
        if (!initialized) {
          return {
            content: [{ type: "text", text: "Memory repository not initialized. Use memory_init to set up." }],
            details: { initialized: false },
          };
        }
        const result = await gitExec(pi, localPath, ["status", "--porcelain"]);
        if (!result.success) {
          return {
            content: [{ type: "text", text: `Git status failed: ${result.stdout || "Unknown error"}` }],
            details: { success: false, error: result.stdout },
          };
        }
        const dirty = result.stdout.trim().length > 0;
        return {
          content: [{ type: "text", text: dirty ? `Changes detected:\n${result.stdout}` : "No uncommitted changes" }],
          details: { initialized: true, dirty },
        };
      }

      if (action === "pull") {
        const result = await syncRepository(pi, settings);
        return {
          content: [{ type: "text", text: result.message }],
          details: { success: result.success },
        };
      }

      if (action === "push") {
        const result = await pushRepository(pi, settings);
        return {
          content: [{ type: "text", text: result.message }],
          details: { success: result.success, committed: result.updated ?? false },
        };
      }

      return {
        content: [{ type: "text", text: "Unknown action" }],
        details: {},
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_sync", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderSyncResult(result, options, theme),
  });
}

export function registerMemoryRead(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a memory file by path",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file (e.g., 'core/user/identity.md')" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: relPath, offset, limit } = params as { path: string; offset?: number; limit?: number };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const fullPath = resolvePathWithin(memoryDir, relPath);

      if (!fullPath || hasSymlinkInPath(memoryDir, fullPath)) {
        return {
          content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
          details: { error: true },
        };
      }

      const memory = await readMemoryFileAsync(fullPath);
      if (!memory) {
        return {
          content: [{ type: "text", text: `Failed to read memory file: ${relPath}` }],
          details: { error: true },
        };
      }

      const { description = "No description", tags = [] } = memory.frontmatter;
      const lines = memory.content.split("\n");
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const endLine = limit ? startLine + Math.max(0, limit) : lines.length;
      const selectedContent = lines.slice(startLine, endLine).join("\n");

      return {
        content: [
          { type: "text", text: `# ${description}\n\nTags: ${tags.join(", ") || "none"}\n\n${selectedContent}` },
        ],
        details: { frontmatter: memory.frontmatter },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_read", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderMemoryResult(result, options, theme),
  });
}

export function registerMemoryWrite(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description: "Create or update a memory file with YAML frontmatter",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file (e.g., 'core/user/identity.md')" }),
      content: Type.String({ description: "Markdown content" }),
      description: Type.String({ description: "Description for frontmatter" }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        path: relPath,
        content,
        description,
        tags,
      } = params as { path: string; content: string; description: string; tags?: string[] };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const fullPath = resolvePathWithin(memoryDir, relPath);

      if (!fullPath || hasSymlinkInPath(memoryDir, fullPath)) {
        return {
          content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
          details: { error: true },
        };
      }

      const existing = await readMemoryFileAsync(fullPath);

      const frontmatter: MemoryFrontmatter = {
        ...existing?.frontmatter,
        description,
        created: existing?.frontmatter.created || getCurrentDate(),
        updated: getCurrentDate(),
        ...(tags && { tags }),
      };

      writeMemoryFile(fullPath, content, frontmatter);
      return {
        content: [{ type: "text", text: `Memory file written: ${relPath}` }],
        details: { path: fullPath, frontmatter },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_write", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as { frontmatter?: { description?: string; tags?: string[] } };
      return renderMemoryResult(result, options, theme, {
        description: details?.frontmatter?.description,
        tags: details?.frontmatter?.tags,
      });
    },
  });
}

export function registerMemoryList(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List all memory files in the repository",
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: "Filter by directory (e.g., 'core/user')" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { directory } = params as { directory?: string };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const listDir = directory ? resolvePathWithin(memoryDir, directory) : memoryDir;

      if (!listDir || hasSymlinkInPath(memoryDir, listDir)) {
        return {
          content: [{ type: "text", text: `Invalid memory directory: ${directory}` }],
          details: { files: [], count: 0, error: true },
        };
      }

      const files = await listMemoryFilesAsync(listDir);
      const relPaths = files.map((f) => path.relative(memoryDir, f));
      return {
        content: [
          { type: "text", text: `Memory files (${relPaths.length}):\n\n${relPaths.map((p) => `  - ${p}`).join("\n")}` },
        ],
        details: { files: relPaths, count: relPaths.length },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_list", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderCountResult(result, options, theme, "memory files"),
  });
}

export function registerMemorySearch(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search memory files by tags, description, or custom grep/rg pattern",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query for tags and description" })),
      grep: Type.Optional(Type.String({ description: "Custom grep pattern (use with tool: 'grep')" })),
      rg: Type.Optional(Type.String({ description: "Custom ripgrep pattern (use with tool: 'rg')" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { query, grep, rg } = params as {
        query?: string;
        grep?: string;
        rg?: string;
      };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const coreDir = getMemoryCoreDir(memoryDir);
      const sections: string[] = [];
      const matchedFiles = new Set<string>();

      if (!fs.existsSync(coreDir)) {
        return {
          content: [{ type: "text", text: `Memory directory not found: ${coreDir}` }],
          details: { files: [], count: 0 },
        };
      }

      if (!query && !grep && !rg) {
        return {
          content: [{ type: "text", text: "Provide query, grep, or rg to search memory files." }],
          details: { files: [], count: 0 },
        };
      }

      const customPattern = grep ?? rg;
      if (customPattern && customPattern.length > MAX_SEARCH_PATTERN_LENGTH) {
        return {
          content: [
            {
              type: "text",
              text: `Search pattern too long (${customPattern.length}). Max length is ${MAX_SEARCH_PATTERN_LENGTH}.`,
            },
          ],
          details: { files: [], count: 0, error: true },
        };
      }

      const escapedQuery = query ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
      const searchLabel = query ?? grep ?? rg ?? "search";

      async function runTool(tool: string, args: string[]): Promise<string[]> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), MEMORY_SEARCH_TIMEOUT_MS);
        const { stdout } = await pi.exec(tool, args, { signal: controller.signal }).catch(() => ({ stdout: "" }));
        clearTimeout(timeoutId);
        const results: string[] = [];

        for (const line of (stdout || "").trim().split("\n")) {
          if (!line) continue;

          const separatorIndex = line.indexOf(":");
          if (separatorIndex === -1) {
            results.push(line);
            continue;
          }

          const matchedFilePath = line.slice(0, separatorIndex);
          matchedFiles.add(matchedFilePath);
          results.push(`${path.relative(memoryDir, matchedFilePath)}: ${line.slice(separatorIndex + 1).trim()}`);
        }

        return results;
      }

      if (escapedQuery) {
        const tagResults = await runTool("grep", [
          "-rn",
          "--include=*.md",
          "-m",
          String(MAX_SEARCH_RESULTS),
          "-E",
          `^\\s*-\\s*${escapedQuery}`,
          coreDir,
        ]);
        if (tagResults.length > 0) {
          sections.push(`## Tags matching: ${query}`, ...tagResults.slice(0, 20));
        }

        const descResults = await runTool("grep", [
          "-rn",
          "--include=*.md",
          "-m",
          String(MAX_SEARCH_RESULTS),
          "-E",
          `^description:\\s*.*${escapedQuery}`,
          coreDir,
        ]);
        if (descResults.length > 0) {
          sections.push("", `## Description matching: ${query}`, ...descResults.slice(0, 20));
        }
      }

      if (grep) {
        const grepResults = await runTool("grep", [
          "-rn",
          "--include=*.md",
          "-m",
          String(MAX_SEARCH_RESULTS),
          "-E",
          grep,
          coreDir,
        ]);
        if (grepResults.length > 0) {
          sections.push("", `## Custom grep: ${grep}`, ...grepResults.slice(0, 50));
        }
      }

      if (rg) {
        const rgResults = await runTool("rg", ["-t", "md", "-m", String(MAX_SEARCH_RESULTS), rg, coreDir]);
        if (rgResults.length > 0) {
          sections.push("", `## Custom ripgrep: ${rg}`, ...rgResults.slice(0, 50));
        }
      }

      const fileList = Array.from(matchedFiles).map((filePath) => path.relative(memoryDir, filePath));

      if (sections.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${searchLabel}".` }],
          details: { files: [], count: 0 },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${fileList.length} file(s) matching "${searchLabel}":\n\n${sections.join("\n")}\n\nUse memory_read to view full content.`,
          },
        ],
        details: { files: fileList, count: fileList.length },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_search", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as { count?: number; files?: string[] };
      const summary = details?.count ? `${details.count} result(s)` : "Search complete";
      return renderCollapsed(summary, getResultText(result), options, theme);
    },
  });
}

export function registerMemoryInit(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description: "Initialize memory repository (clone or create initial structure)",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Reinitialize even if already set up" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { force = false } = params as { force?: boolean };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const alreadyInitialized = isMemoryInitialized(memoryDir);

      if (alreadyInitialized && !force) {
        return {
          content: [{ type: "text", text: "Memory repository already initialized. Use force: true to reinitialize." }],
          details: { initialized: true },
        };
      }

      const result = await syncRepository(pi, settings);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `Initialization failed: ${result.message}` }],
          details: { success: false },
        };
      }

      initializeMemoryDirectory(memoryDir);

      return {
        content: [
          {
            type: "text",
            text: `Memory repository initialized:\n${result.message}\n\nCreated directory structure:\n${["core/user", "core/project", "reference"].map((d) => `  - ${d}`).join("\n")}`,
          },
        ],
        details: { success: true },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_init", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Initializing..."));
      const details = result.details as { initialized?: boolean; success?: boolean };
      if (details?.initialized) return renderText(theme.fg("muted", "Already initialized"));
      const summary = details?.success ? "Initialized" : "Initialization failed";
      return renderCollapsed(summary, getResultText(result), options, theme);
    },
  });
}

export function registerMemoryCheck(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_check",
    label: "Memory Check",
    description: "Check current project memory folder structure",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      if (!fs.existsSync(memoryDir)) {
        return {
          content: [
            {
              type: "text",
              text: `Memory directory not found: ${memoryDir}\n\nProject memory may not be initialized yet.`,
            },
          ],
          details: { exists: false },
        };
      }

      const { execSync } = await import("node:child_process");
      let treeOutput = "";
      try {
        treeOutput = execSync(`tree -L 3 -I "node_modules" "${memoryDir}"`, { encoding: "utf-8" });
      } catch {
        try {
          treeOutput = execSync(`find "${memoryDir}" -type d -not -path "*/node_modules/*" | head -20`, {
            encoding: "utf-8",
          });
        } catch {
          treeOutput = "Unable to generate directory tree. Please check permissions.";
        }
      }

      const files = await listMemoryFilesAsync(memoryDir);
      const relPaths = files.map((f) => path.relative(memoryDir, f));
      return {
        content: [
          {
            type: "text",
            text: `Memory directory structure for project: ${getProjectName(ctx.cwd)}\n\nPath: ${memoryDir}\n\n${treeOutput}\n\nMemory files (${relPaths.length}):\n${relPaths.map((p) => `  ${p}`).join("\n")}`,
          },
        ],
        details: { path: memoryDir, fileCount: relPaths.length },
      };
    },

    renderCall: (_args, theme) => new Text(buildToolCallText("memory_check", {}, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Checking..."));
      const details = result.details as { exists?: boolean; fileCount?: number };

      if (details?.exists === false) {
        return renderCollapsed("Not initialized", getResultText(result), options, theme);
      }

      return renderCollapsed(`Structure: ${details?.fileCount ?? 0} files`, getResultText(result), options, theme);
    },
  });
}

export function registerAllMemoryTools(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  registerMemorySync(pi, settings);
  registerMemoryRead(pi, settings);
  registerMemoryWrite(pi, settings);
  registerMemoryList(pi, settings);
  registerMemorySearch(pi, settings);
  registerMemoryInit(pi, settings);
  registerMemoryCheck(pi, settings);
}
