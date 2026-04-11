import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  getCurrentDate,
  getMemoryDir,
  gitExec,
  listMemoryFiles,
  readMemoryFile,
  syncRepository,
  writeMemoryFile,
} from "./memoryMdCore.js";
import { type SearchField, searchMemoryFiles } from "./search-engine.js";
import type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";

// Re-export types for convenience
export type { ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
export type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";

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

export function registerMemorySync(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): void {
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
      const coreUserDir = path.join(memoryDir, "core", "user");

      if (action === "status") {
        const initialized = isRepoInitialized.value && fs.existsSync(coreUserDir);
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
        const result = await syncRepository(pi, settings, isRepoInitialized);
        return {
          content: [{ type: "text", text: result.message }],
          details: { success: result.success },
        };
      }

      if (action === "push") {
        const statusResult = await gitExec(pi, localPath, ["status", "--porcelain"]);
        const hasChanges = statusResult.stdout.trim().length > 0;

        if (hasChanges) {
          await gitExec(pi, localPath, ["add", "."]);
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const commitResult = await gitExec(pi, localPath, ["commit", "-m", `Update memory - ${timestamp}`]);
          if (!commitResult.success) {
            return {
              content: [{ type: "text", text: commitResult.stdout || "Commit failed" }],
              details: { success: false },
            };
          }
        }

        const result = await gitExec(pi, localPath, ["push"]);
        if (result.timeout) {
          return {
            content: [
              {
                type: "text",
                text: "Unable to connect to GitHub repository, connection timeout (10s). Please check your network connection or try again later.",
              },
            ],
            details: { success: false, timeout: true },
          };
        }

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: hasChanges
                  ? "Committed and pushed changes to repository"
                  : "No changes to commit, repository up to date",
              },
            ],
            details: { success: true, committed: hasChanges },
          };
        }
        return {
          content: [{ type: "text", text: result.stdout || "Push failed" }],
          details: { success: false },
        };
      }

      return {
        content: [{ type: "text", text: "Unknown action" }],
        details: {},
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_sync", args, theme), 0, 0),
    renderResult: (result, options, theme) =>
      options.isPartial ? renderText(theme.fg("warning", "Syncing...")) : renderSyncResult(result, options, theme),
  });
}

export function registerMemoryRead(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a memory file by path",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file (e.g., 'core/user/identity.md')" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: relPath } = params as { path: string };
      const fullPath = path.join(getMemoryDir(settings, ctx.cwd), relPath);
      const memory = readMemoryFile(fullPath);

      if (!memory) {
        return {
          content: [{ type: "text", text: `Failed to read memory file: ${relPath}` }],
          details: { error: true },
        };
      }

      const { description = "No description", tags = [] } = memory.frontmatter;
      return {
        content: [
          { type: "text", text: `# ${description}\n\nTags: ${tags.join(", ") || "none"}\n\n${memory.content}` },
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
      const fullPath = path.join(getMemoryDir(settings, ctx.cwd), relPath);
      const existing = readMemoryFile(fullPath);

      const frontmatter: MemoryFrontmatter = {
        ...existing?.frontmatter,
        description,
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
      const files = listMemoryFiles(directory ? path.join(memoryDir, directory) : memoryDir);
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
    description:
      "Search memory files by content, tags, or description." +
      " Supports regex (e.g. 'typescript|javascript', 'fail.*build')." +
      " Multi-word queries use OR logic ranked by relevance -- use keywords, not full sentences.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance.",
      }),
      searchIn: Type.Union(
        [Type.Literal("content"), Type.Literal("tags"), Type.Literal("description"), Type.Literal("all")],
        { description: "Where to search" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { query, searchIn } = params as { query: string; searchIn: SearchField };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const filePaths = listMemoryFiles(memoryDir);

      // Build file map
      const fileMap = new Map<string, import("./types.js").MemoryFile>();
      for (const filePath of filePaths) {
        const memory = readMemoryFile(filePath);
        if (!memory) continue;
        const relPath = path.relative(memoryDir, filePath);
        fileMap.set(relPath, memory);
      }

      const hits = searchMemoryFiles({ files: fileMap, query, searchIn });

      const results = hits.map((h) => ({
        path: h.path,
        match: h.snippet,
        matchCount: h.matchCount,
        matchedIn: h.matchedIn,
      }));

      return {
        content: [
          {
            type: "text",
            text:
              results.length === 0
                ? "No results found."
                : `Found ${results.length} result(s):\n\n${results.map((r) => `  ${r.path}\n  ${r.match}`).join("\n\n")}`,
          },
        ],
        details: { results, count: results.length },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_search", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderCountResult(result, options, theme, "result(s)"),
  });
}

export function registerMemoryInit(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): void {
  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description: "Initialize memory repository (clone or create initial structure)",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Reinitialize even if already set up" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { force = false } = params as { force?: boolean };
      if (isRepoInitialized.value && !force) {
        return {
          content: [{ type: "text", text: "Memory repository already initialized. Use force: true to reinitialize." }],
          details: { initialized: true },
        };
      }
      const result = await syncRepository(pi, settings, isRepoInitialized);
      return {
        content: [
          {
            type: "text",
            text: result.success
              ? `Memory repository initialized:\n${result.message}\n\nCreated directory structure:\n${["core/user", "core/project", "reference"].map((d) => `  - ${d}`).join("\n")}`
              : `Initialization failed: ${result.message}`,
          },
        ],
        details: { success: result.success },
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

      const files = listMemoryFiles(memoryDir);
      const relPaths = files.map((f) => path.relative(memoryDir, f));
      return {
        content: [
          {
            type: "text",
            text: `Memory directory structure for project: ${path.basename(ctx.cwd)}\n\nPath: ${memoryDir}\n\n${treeOutput}\n\nMemory files (${relPaths.length}):\n${relPaths.map((p) => `  ${p}`).join("\n")}`,
          },
        ],
        details: { path: memoryDir, fileCount: relPaths.length },
      };
    },

    renderCall: (_args, theme) => new Text(buildToolCallText("memory_check", {}, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Checking..."));
      const details = result.details as { exists?: boolean; fileCount?: number };
      const summary = (details?.exists ?? true) ? `Structure: ${details?.fileCount ?? 0} files` : "Not initialized";
      return renderCollapsed(summary, getResultText(result), options, theme);
    },
  });
}

export function registerAllMemoryTools(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): void {
  registerMemorySync(pi, settings, isRepoInitialized);
  registerMemoryRead(pi, settings);
  registerMemoryWrite(pi, settings);
  registerMemoryList(pi, settings);
  registerMemorySearch(pi, settings);
  registerMemoryInit(pi, settings, isRepoInitialized);
  registerMemoryCheck(pi, settings);
}
