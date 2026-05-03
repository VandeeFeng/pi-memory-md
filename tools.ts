import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  getMemoryCoreDir,
  getMemoryMeta,
  // initializeMemoryDirectory, // unused after memory-init moved to SKILL
  listMemoryFilesAsync,
} from "./memory-core.js";
import { gitExec, pushRepository, syncRepository } from "./memory-git.js";
import type { MemoryMdSettings } from "./types.js";
import { getProjectMeta, hasSymlinkInPath, resolvePathWithin } from "./utils.js";

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

// Deprecated with memory_write tool; kept for transition reference.
// function renderMemoryResult(
//   result: { content: Array<{ type: string; text?: string }>; details?: unknown },
//   options: { expanded: boolean; isPartial: boolean },
//   theme: Theme,
//   defaults?: { description?: string; tags?: string[] },
// ): Text {
//   if (options.isPartial) return renderText(theme.fg("warning", "Reading..."));
//   const details = result.details as
//     | { error?: boolean; frontmatter?: { description?: string; tags?: string[] } }
//     | undefined;
//   if (details?.error) return renderText(theme.fg("error", getResultText(result) || "Error"));
//
//   const description = defaults?.description || details?.frontmatter?.description || "Memory file";
//   const tags = defaults?.tags || details?.frontmatter?.tags || [];
//   const text = getResultText(result);
//
//   if (!options.expanded) {
//     const summary = `${theme.fg("success", description)}\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}`;
//     return renderText(summary + buildExpandHint(text.split("\n").length + 2, theme));
//   }
//
//   return renderText(
//     theme.fg("success", description) +
//       `\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}\n${theme.fg("toolOutput", text)}`,
//   );
// }

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
    description:
      "Synchronize the memory git repository. Use status to inspect changes. Do not run pull or push unless the user explicitly asks for sync/pull/push.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("pull"), Type.Literal("push"), Type.Literal("status")], {
        description: "Action to perform: status, pull, or push",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action } = params as { action: "pull" | "push" | "status" };
      if (!settings.localPath) {
        return {
          content: [{ type: "text", text: "Memory localPath is not configured." }],
          details: { success: false, initialized: false },
        };
      }

      const localPath = settings.localPath;
      const memoryMeta = await getMemoryMeta(settings, ctx.cwd);
      if (action === "status") {
        const memoryRepo = getProjectMeta(localPath);
        const initialized = memoryMeta.initialized && memoryRepo.gitRoot === memoryRepo.cwd;
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
          details: { success: result.success, pushed: result.updated ?? false },
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

// export function registerMemoryRead(pi: ExtensionAPI, settings: MemoryMdSettings): void {
//   pi.registerTool({
//     name: "memory_read",
//     label: "Memory Read",
//     description: "Read a memory file by path",
//     parameters: Type.Object({
//       path: Type.String({ description: "Relative path to memory file (e.g., 'core/user/identity.md')" }),
//       offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
//       limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
//     }),

//     async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
//       const { path: relPath, offset, limit } = params as { path: string; offset?: number; limit?: number };
//       const memoryDir = getMemoryDir(settings, ctx.cwd);
//       const fullPath = resolvePathWithin(memoryDir, relPath);

//       if (!fullPath || hasSymlinkInPath(memoryDir, fullPath)) {
//         return {
//           content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
//           details: { error: true },
//         };
//       }

//       const memory = await readMemoryFileAsync(fullPath);
//       if (!memory) {
//         return {
//           content: [{ type: "text", text: `Failed to read memory file: ${relPath}` }],
//           details: { error: true },
//         };
//       }

//       const { description = "No description", tags = [] } = memory.frontmatter;
//       const lines = memory.content.split("\n");
//       const startLine = offset ? Math.max(0, offset - 1) : 0;
//       const endLine = limit ? startLine + Math.max(0, limit) : lines.length;
//       const selectedContent = lines.slice(startLine, endLine).join("\n");

//       return {
//         content: [
//           { type: "text", text: `# ${description}\n\nTags: ${tags.join(", ") || "none"}\n\n${selectedContent}` },
//         ],
//         details: { frontmatter: memory.frontmatter },
//       };
//     },

//     renderCall: (args, theme) => new Text(buildToolCallText("memory_read", args, theme), 0, 0),
//     renderResult: (result, options, theme) => renderMemoryResult(result, options, theme),
//   });
// }

// Deprecated after migrating memory writes to the memory-write skill.
// Keep this block commented for reference during transition.
// export function registerMemoryWrite(pi: ExtensionAPI, settings: MemoryMdSettings): void {
//   pi.registerTool({
//     name: "memory_write",
//     label: "Memory Write",
//     description: "Create or update a project memory file with YAML frontmatter",
//     parameters: Type.Object({
//       path: Type.String({ description: "Project memory relative path (e.g., 'core/project/architecture.md')" }),
//       content: Type.String({ description: "Markdown content" }),
//       description: Type.String({ description: "Description for frontmatter" }),
//       tags: Type.Optional(Type.Array(Type.String())),
//     }),
//
//     async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
//       const {
//         path: relPath,
//         content,
//         description,
//         tags,
//       } = params as { path: string; content: string; description: string; tags?: string[] };
//       const memoryDir = getMemoryDir(settings, ctx.cwd);
//       const fullPath = resolvePathWithin(memoryDir, relPath);
//
//       if (!fullPath || hasSymlinkInPath(memoryDir, fullPath)) {
//         return {
//           content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
//           details: { error: true },
//         };
//       }
//
//       const existing = await readMemoryFileAsync(fullPath);
//
//       const frontmatter: MemoryFrontmatter = {
//         ...existing?.frontmatter,
//         description,
//         created: existing?.frontmatter.created || getCurrentDate(),
//         updated: getCurrentDate(),
//         ...(tags && { tags }),
//       };
//
//       writeMemoryFile(fullPath, content, frontmatter);
//       return {
//         content: [{ type: "text", text: `Memory file written: ${relPath}` }],
//         details: { path: fullPath, frontmatter },
//       };
//     },
//
//     renderCall: (args, theme) => new Text(buildToolCallText("memory_write", args, theme), 0, 0),
//     renderResult: (result, options, theme) => {
//       const details = result.details as { frontmatter?: { description?: string; tags?: string[] } };
//       return renderMemoryResult(result, options, theme, {
//         description: details?.frontmatter?.description,
//         tags: details?.frontmatter?.tags,
//       });
//     },
//   });
// }

export function registerMemoryList(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List memory files: project paths are relative, global paths are absolute",
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: "Project subdirectory (e.g., 'core/project')" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { directory } = params as { directory?: string };
      const memoryMeta = await getMemoryMeta(settings, ctx.cwd);

      function toProjectRelativePaths(files: string[]): string[] {
        return files.map((filePath) => path.relative(memoryMeta.memoryPath, filePath));
      }

      if (directory) {
        const listDir = resolvePathWithin(memoryMeta.memoryPath, directory);

        if (!listDir || hasSymlinkInPath(memoryMeta.memoryPath, listDir)) {
          return {
            content: [{ type: "text", text: `Invalid memory directory: ${directory}` }],
            details: { files: [], count: 0, error: true },
          };
        }

        const files = toProjectRelativePaths(await listMemoryFilesAsync(listDir));
        return {
          content: [
            {
              type: "text",
              text: `Memory files (${files.length}):\n\n${files.map((p) => `  - ${p}`).join("\n")}`,
            },
          ],
          details: { files, count: files.length },
        };
      }

      if (!memoryMeta.global.dir || memoryMeta.global.dir === memoryMeta.memoryPath) {
        const files = toProjectRelativePaths(await listMemoryFilesAsync(memoryMeta.memoryPath));
        return {
          content: [
            {
              type: "text",
              text: `Memory files (${files.length}):\n\n${files.map((p) => `  - ${p}`).join("\n")}`,
            },
          ],
          details: { files, count: files.length },
        };
      }

      const [globalFiles, projectFiles] = await Promise.all([
        listMemoryFilesAsync(memoryMeta.global.dir),
        listMemoryFilesAsync(memoryMeta.memoryPath),
      ]);
      const files = [...globalFiles, ...toProjectRelativePaths(projectFiles)];

      return {
        content: [
          { type: "text", text: `Memory files (${files.length}):\n\n${files.map((p) => `  - ${p}`).join("\n")}` },
        ],
        details: { files, count: files.length },
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
      "Search memory files. Defaults to project memory. Use query for frontmatter tags/descriptions, grep or rg for full-text markdown search.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search tags and frontmatter description, not full content" })),
      grep: Type.Optional(Type.String({ description: "Full-text grep regex for markdown memory files" })),
      rg: Type.Optional(Type.String({ description: "Full-text ripgrep pattern for markdown memory files" })),
      scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("all")], {
          description: "Memory scope to search. Defaults to project.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        query,
        grep,
        rg,
        scope = "project",
      } = params as {
        query?: string;
        grep?: string;
        rg?: string;
        scope?: "project" | "global" | "all";
      };
      const memoryMeta = await getMemoryMeta(settings, ctx.cwd);
      const searchRoots = [
        ...(scope === "project" || scope === "all" ? [{ label: "project", memoryDir: memoryMeta.memoryPath }] : []),
        ...(memoryMeta.global.dir &&
        memoryMeta.global.dir !== memoryMeta.memoryPath &&
        (scope === "global" || scope === "all")
          ? [{ label: "global", memoryDir: memoryMeta.global.dir }]
          : []),
      ].map((root) => ({ ...root, coreDir: getMemoryCoreDir(root.memoryDir) }));
      const existingRoots = searchRoots.filter((root) => fs.existsSync(root.coreDir));
      const sections: string[] = [];
      const matchedFiles = new Map<string, string>();

      if (existingRoots.length === 0) {
        return {
          content: [{ type: "text", text: `Memory directory not found for scope: ${scope}` }],
          details: { files: [], count: 0, scope },
        };
      }

      if (!query && !grep && !rg) {
        return {
          content: [{ type: "text", text: "Provide query, grep, or rg to search memory files." }],
          details: { files: [], count: 0, scope },
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
          details: { files: [], count: 0, scope, error: true },
        };
      }

      const escapedQuery = query ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
      const searchLabel = query ?? grep ?? rg ?? "search";

      function formatMatchedPath(filePath: string, memoryDir: string, label: string): string {
        const relativePath = path.relative(memoryDir, filePath);
        return label === "global" ? filePath : relativePath;
      }

      async function runTool(tool: string, args: string[], memoryDir: string, label: string): Promise<string[]> {
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
          const displayPath = formatMatchedPath(matchedFilePath, memoryDir, label);
          matchedFiles.set(displayPath, displayPath);
          results.push(`${displayPath}: ${line.slice(separatorIndex + 1).trim()}`);
        }

        return results;
      }

      for (const { label, memoryDir, coreDir } of existingRoots) {
        const sectionPrefix = scope === "all" ? `${label} ` : "";

        if (escapedQuery) {
          const tagResults = await runTool(
            "grep",
            ["-rn", "--include=*.md", "-m", String(MAX_SEARCH_RESULTS), "-E", `^\\s*-\\s*${escapedQuery}`, coreDir],
            memoryDir,
            label,
          );
          if (tagResults.length > 0) {
            sections.push(`## ${sectionPrefix}Tags matching: ${query}`, ...tagResults.slice(0, 20));
          }

          const descResults = await runTool(
            "grep",
            [
              "-rn",
              "--include=*.md",
              "-m",
              String(MAX_SEARCH_RESULTS),
              "-E",
              `^description:\\s*.*${escapedQuery}`,
              coreDir,
            ],
            memoryDir,
            label,
          );
          if (descResults.length > 0) {
            sections.push("", `## ${sectionPrefix}Description matching: ${query}`, ...descResults.slice(0, 20));
          }
        }

        if (grep) {
          const grepResults = await runTool(
            "grep",
            ["-rn", "--include=*.md", "-m", String(MAX_SEARCH_RESULTS), "-E", grep, coreDir],
            memoryDir,
            label,
          );
          if (grepResults.length > 0) {
            sections.push("", `## ${sectionPrefix}Custom grep: ${grep}`, ...grepResults.slice(0, 50));
          }
        }

        if (rg) {
          const rgResults = await runTool(
            "rg",
            ["-t", "md", "-m", String(MAX_SEARCH_RESULTS), rg, coreDir],
            memoryDir,
            label,
          );
          if (rgResults.length > 0) {
            sections.push("", `## ${sectionPrefix}Custom ripgrep: ${rg}`, ...rgResults.slice(0, 50));
          }
        }
      }

      const fileList = Array.from(matchedFiles.keys());

      if (sections.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${searchLabel}".` }],
          details: { files: [], count: 0, scope },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${fileList.length} file(s) matching "${searchLabel}":\n\n${sections.join("\n")}\n\nUse read to view full content.`,
          },
        ],
        details: { files: fileList, count: fileList.length, scope },
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

// export function registerMemoryInit(pi: ExtensionAPI, settings: MemoryMdSettings): void {
//   pi.registerTool({
//     name: "memory_init",
//     label: "Memory Init",
//     description: "Initialize memory repository (clone or create initial structure)",
//     parameters: Type.Object({
//       force: Type.Optional(Type.Boolean({ description: "Reinitialize even if already set up" })),
//     }),

//     async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
//       const { force = false } = params as { force?: boolean };
//       const memoryDir = getMemoryDir(settings, ctx.cwd);
//       const alreadyInitialized = isMemoryInitialized(memoryDir);

//       if (alreadyInitialized && !force) {
//         return {
//           content: [{ type: "text", text: "Memory repository already initialized. Use force: true to reinitialize." }],
//           details: { initialized: true },
//         };
//       }

//       const result = await syncRepository(pi, settings);
//       if (!result.success) {
//         return {
//           content: [{ type: "text", text: `Initialization failed: ${result.message}` }],
//           details: { success: false },
//         };
//       }

//       const globalMemoryDir = getGlobalMemoryDir(settings);
//       if (globalMemoryDir) {
//         initializeMemoryDirectory(globalMemoryDir);
//       }
//       initializeMemoryDirectory(memoryDir);

//       const createdDirs = [
//         ...(globalMemoryDir
//           ? [`global: ${globalMemoryDir}`, "global/core/user", "global/core/project", "global/reference"]
//           : []),
//         `project: ${memoryDir}`,
//         "project/core/user",
//         "project/core/project",
//         "project/reference",
//       ];

//       return {
//         content: [
//           {
//             type: "text",
//             text: `Memory repository initialized:\n${result.message}\n\nCreated directory structure:\n${createdDirs.map((d) => `  - ${d}`).join("\n")}`,
//           },
//         ],
//         details: { success: true, globalMemoryDir, projectMemoryDir: memoryDir },
//       };
//     },

//     renderCall: (args, theme) => new Text(buildToolCallText("memory_init", args, theme), 0, 0),
//     renderResult: (result, options, theme) => {
//       if (options.isPartial) return renderText(theme.fg("warning", "Initializing..."));
//       const details = result.details as { initialized?: boolean; success?: boolean };
//       if (details?.initialized) return renderText(theme.fg("muted", "Already initialized"));
//       const summary = details?.success ? "Initialized" : "Initialization failed";
//       return renderCollapsed(summary, getResultText(result), options, theme);
//     },
//   });
// }

export function registerMemoryCheck(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_check",
    label: "Memory Check",
    description: "Check current project memory folder structure",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const info = await getMemoryMeta(settings, ctx.cwd);
      if (!fs.existsSync(info.memoryPath)) {
        const missingGlobalMessage =
          info.global.dir && !info.global.exists
            ? `\n\nShared global memory directory not found: ${info.global.dir}`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Project memory directory not found: ${info.project.dir}${missingGlobalMessage}\n\nMemory may not be initialized yet.`,
            },
          ],
          details: { exists: false },
        };
      }

      const requiredDirs = [
        ...(info.global.dir && info.global.exists && info.global.dir !== info.project.dir
          ? [{ label: "Shared global", path: info.global.dir }]
          : []),
        { label: "Project", path: info.memoryPath },
      ];

      const sections = await Promise.all(
        requiredDirs.map(async ({ label, path: memoryDir }) => {
          const files = await listMemoryFilesAsync(memoryDir);
          const relPaths = files.map((f) => path.relative(memoryDir, f));
          return [
            `## ${label} memory`,
            `Path: ${memoryDir}`,
            `Memory files (${relPaths.length}):`,
            relPaths.map((p) => `  ${p}`).join("\n"),
          ].join("\n");
        }),
      );
      const globalMemoryWarning =
        info.global.dir && !info.global.exists
          ? `Warning: shared global memory directory not found: ${info.global.dir}\n\n`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `Memory directory structure for project: ${info.name}\n\n${globalMemoryWarning}${sections.join("\n\n")}`,
          },
        ],
        details: {
          fileCount: (info.project.fileCount ?? 0) + (info.global.fileCount ?? 0),
          globalMemoryMissing: !!info.global.dir && !info.global.exists,
        },
      };
    },

    renderCall: (_args, theme) => new Text(buildToolCallText("memory_check", {}, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Checking..."));
      const details = result.details as
        | {
            exists?: boolean;
            fileCount?: number;
            globalMemoryMissing?: boolean;
          }
        | undefined;

      if (details?.exists === false) {
        return renderCollapsed("Not initialized", getResultText(result), options, theme);
      }

      const summary = details?.globalMemoryMissing
        ? `Structure: ${details?.fileCount ?? 0} files (global missing)`
        : `Structure: ${details?.fileCount ?? 0} files`;
      return renderCollapsed(summary, getResultText(result), options, theme);
    },
  });
}

export function registerAllMemoryTools(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  registerMemorySync(pi, settings);
  // registerMemoryRead(pi, settings);
  // registerMemoryWrite(pi, settings);
  registerMemoryList(pi, settings);
  registerMemorySearch(pi, settings);
  // registerMemoryInit(pi, settings);
  registerMemoryCheck(pi, settings);
}
