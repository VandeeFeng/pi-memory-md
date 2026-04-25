import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  getCurrentDate,
  getIncludedProjectDirs,
  getMemoryBasePath,
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
import { getProjectMeta, hasSymlinkInPath, isPathInside, resolvePathWithin } from "./utils.js";

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
        const memoryRepo = getProjectMeta(localPath);
        const initialized = isMemoryInitialized(memoryDir) && memoryRepo.gitRoot === memoryRepo.cwd;
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
      const basePath = getMemoryBasePath(settings);

      // Resolution order:
      //  1. Current project (memoryDir)
      //  2. _shared or included-project path relative to basePath (e.g. "_shared/core/...").
      // Both paths are validated with resolvePathWithin + hasSymlinkInPath against
      // their own base directory so traversal / symlink escape is blocked.
      type Resolved = { fullPath: string; base: string };
      const candidates: Array<{ base: string }> = [{ base: memoryDir }, { base: basePath }];
      let resolved: Resolved | null = null;
      let invalidSeen = false;

      for (const { base } of candidates) {
        const candidate = resolvePathWithin(base, relPath);
        if (!candidate) {
          invalidSeen = true;
          continue;
        }
        if (hasSymlinkInPath(base, candidate)) {
          invalidSeen = true;
          continue;
        }
        if (fs.existsSync(candidate)) {
          resolved = { fullPath: candidate, base };
          break;
        }
      }

      if (!resolved) {
        return {
          content: [
            {
              type: "text",
              text: invalidSeen ? `Invalid memory path: ${relPath}` : `Memory file not found: ${relPath}`,
            },
          ],
          details: { error: true },
        };
      }

      const memory = await readMemoryFileAsync(resolved.fullPath);
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
    description:
      "Create or update a memory file with YAML frontmatter. Set shared=true to write to _shared/ for cross-project access.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file (e.g., 'core/user/identity.md')" }),
      content: Type.String({ description: "Markdown content" }),
      description: Type.String({ description: "Description for frontmatter" }),
      tags: Type.Optional(Type.Array(Type.String())),
      shared: Type.Optional(
        Type.Boolean({ description: "If true, write to _shared/ folder instead of the current project" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        path: relPath,
        content,
        description,
        tags,
        shared,
      } = params as {
        path: string;
        content: string;
        description: string;
        tags?: string[];
        shared?: boolean;
      };

      // Guard: reject scope-prefixed paths (e.g. "_shared/core/..." with shared=true)
      // which would nest under <base>/_shared/_shared/. Pre-fix writes produced
      // orphan files that had to be cleaned up manually.
      if (shared && hasScopePrefix(relPath, "_shared")) {
        return {
          content: [
            {
              type: "text",
              text: `Do not prefix path with "_shared/" when shared=true. Use e.g. "core/user/prefer.md" instead of "_shared/core/user/prefer.md". Got: ${relPath}`,
            },
          ],
          details: { error: true },
        };
      }

      const baseDir = shared ? path.join(getMemoryBasePath(settings), "_shared") : getMemoryDir(settings, ctx.cwd);
      const fullPath = resolvePathWithin(baseDir, relPath);

      if (!fullPath || hasSymlinkInPath(baseDir, fullPath)) {
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
        content: [{ type: "text", text: `Memory file written: ${shared ? "_shared/" : ""}${relPath}` }],
        details: { path: fullPath, frontmatter, shared },
      };
    },

    renderCall: (args, theme) => {
      let text = buildToolCallText("memory_write", args, theme);
      if (args.shared)
        text =
          theme.fg("toolTitle", theme.bold("memory_write")) +
          " " +
          theme.fg("warning", "[shared] ") +
          theme.fg("accent", formatValue(args.path));
      return new Text(text, 0, 0);
    },
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
    description:
      "List memory files. By default only the auto-delivered hot tier (core/) is listed. Pass includeCold=true to also show warehouse files (notes/, docs/, research/, archive/, tools/, techniques/, reference/, etc.) that live outside core/.",
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: "Filter by directory (e.g., 'core/user')" })),
      includeCold: Type.Optional(
        Type.Boolean({
          description:
            "If true, include warehouse files outside core/. Default false (only core/ auto-delivered tier shown).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { directory, includeCold } = params as { directory?: string; includeCold?: boolean };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const basePath = getMemoryBasePath(settings);

      // Resolve the listing directory under each scope with resolvePathWithin
      // so callers can't traverse out with "../".
      function resolveScopeDir(base: string): string | null {
        if (!directory) return base;
        const resolved = resolvePathWithin(base, directory);
        if (!resolved || hasSymlinkInPath(base, resolved)) return null;
        return resolved;
      }

      // When includeCold is false (default), confine listings to core/ which is
      // the auto-delivered hot tier. When a `directory` filter is supplied,
      // honor that verbatim so callers can still drill into warehouse subdirs
      // on purpose without flipping includeCold.
      function scopeListDir(base: string): string | null {
        if (directory) return resolveScopeDir(base);
        return includeCold ? base : path.join(base, "core");
      }

      const listDir = scopeListDir(memoryDir);
      if (directory && listDir === null) {
        return {
          content: [{ type: "text", text: `Invalid memory directory: ${directory}` }],
          details: { files: [], count: 0, error: true },
        };
      }

      const relPaths: string[] = [];
      if (listDir && fs.existsSync(listDir)) {
        for (const f of await listMemoryFilesAsync(listDir)) {
          relPaths.push(path.relative(memoryDir, f));
        }
      }

      // Shared + included-project listings are keyed relative to basePath
      // (e.g. "_shared/core/..." or "<project>/core/...") so the same path
      // can be passed back into memory_read unchanged.
      const sharedPaths: string[] = [];
      const sharedBase = path.join(basePath, "_shared");
      const sharedListDir = scopeListDir(sharedBase);
      if (sharedListDir && fs.existsSync(sharedListDir)) {
        for (const f of await listMemoryFilesAsync(sharedListDir)) {
          sharedPaths.push(path.relative(basePath, f));
        }
      }

      const includedPaths: string[] = [];
      for (const d of getIncludedProjectDirs(settings, ctx.cwd)) {
        const scopeDir = scopeListDir(d);
        if (!scopeDir || !fs.existsSync(scopeDir)) continue;
        for (const f of await listMemoryFilesAsync(scopeDir)) {
          includedPaths.push(path.relative(basePath, f));
        }
      }

      const allShared = [...sharedPaths, ...includedPaths];
      const allPaths = [...relPaths, ...allShared];
      const tier = directory ? `directory=${directory}` : includeCold ? "all tiers" : "core/ only";
      let text = `Memory files (${allPaths.length}, ${tier}):\n\n`;
      if (relPaths.length > 0) {
        text += `Project:\n${relPaths.map((p) => `  - ${p}`).join("\n")}\n`;
      }
      if (allShared.length > 0) {
        text += `\nShared:\n${allShared.map((p) => `  - ${p}`).join("\n")}\n`;
      }
      if (!includeCold && !directory) {
        text += `\n(Pass includeCold=true to also list warehouse files outside core/.)\n`;
      }
      return {
        content: [{ type: "text", text }],
        details: { files: allPaths, count: allPaths.length, tier: includeCold ? "all" : "core" },
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
      const basePath = getMemoryBasePath(settings);
      const coreDir = getMemoryCoreDir(memoryDir);
      const sections: string[] = [];
      const matchedFiles = new Set<string>();

      // Map each search directory to the base used for display-relative paths
      // so results render as e.g. "_shared/core/..." or "<project>/core/..."
      // instead of messy "../_shared/..." strings relative to memoryDir.
      const searchDirs: Array<{ dir: string; displayBase: string }> = [];
      if (fs.existsSync(coreDir)) searchDirs.push({ dir: coreDir, displayBase: memoryDir });
      const sharedCoreDir = path.join(basePath, "_shared", "core");
      if (fs.existsSync(sharedCoreDir)) searchDirs.push({ dir: sharedCoreDir, displayBase: basePath });
      for (const d of getIncludedProjectDirs(settings, ctx.cwd)) {
        const ic = path.join(d, "core");
        if (fs.existsSync(ic)) searchDirs.push({ dir: ic, displayBase: basePath });
      }

      if (searchDirs.length === 0) {
        return { content: [{ type: "text", text: "No memory directories found" }], details: { files: [], count: 0 } };
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

      async function runTool(tool: string, args: string[], displayBase: string): Promise<string[]> {
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
          results.push(`${path.relative(displayBase, matchedFilePath)}: ${line.slice(separatorIndex + 1).trim()}`);
        }

        return results;
      }

      if (escapedQuery) {
        for (const { dir, displayBase } of searchDirs) {
          const tagResults = await runTool(
            "grep",
            ["-rn", "--include=*.md", "-m", String(MAX_SEARCH_RESULTS), "-E", `^\\s*-\\s*${escapedQuery}`, dir],
            displayBase,
          );
          if (tagResults.length > 0) sections.push(`## Tags matching: ${query}`, ...tagResults.slice(0, 20));
          const descResults = await runTool(
            "grep",
            [
              "-rn",
              "--include=*.md",
              "-m",
              String(MAX_SEARCH_RESULTS),
              "-E",
              `^description:\\s*.*${escapedQuery}`,
              dir,
            ],
            displayBase,
          );
          if (descResults.length > 0)
            sections.push("", `## Description matching: ${query}`, ...descResults.slice(0, 20));
        }
      }

      if (grep) {
        for (const { dir, displayBase } of searchDirs) {
          const grepResults = await runTool(
            "grep",
            ["-rn", "--include=*.md", "-m", String(MAX_SEARCH_RESULTS), "-E", grep, dir],
            displayBase,
          );
          if (grepResults.length > 0) sections.push("", `## Custom grep: ${grep}`, ...grepResults.slice(0, 50));
        }
      }

      if (rg) {
        for (const { dir, displayBase } of searchDirs) {
          const rgResults = await runTool("rg", ["-t", "md", "-m", String(MAX_SEARCH_RESULTS), rg, dir], displayBase);
          if (rgResults.length > 0) sections.push("", `## Custom ripgrep: ${rg}`, ...rgResults.slice(0, 50));
        }
      }

      const fileList = Array.from(matchedFiles).map((filePath) => {
        // Prefer a base that actually contains the file so display paths stay clean.
        const base = searchDirs.find((s) => filePath.startsWith(`${s.dir}${path.sep}`))?.displayBase ?? memoryDir;
        return path.relative(base, filePath);
      });

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
            text: `Memory directory structure for project: ${getProjectMeta(ctx.cwd).name}\n\nPath: ${memoryDir}\n\n${treeOutput}\n\nMemory files (${relPaths.length}):\n${relPaths.map((p) => `  ${p}`).join("\n")}`,
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

// ============================================================================
// Shared helpers for memory_delete / memory_move
// ============================================================================

function resolveBase(settings: MemoryMdSettings, cwd: string, shared?: boolean): string {
  return shared ? path.join(getMemoryBasePath(settings), "_shared") : getMemoryDir(settings, cwd);
}

function labelFor(relPath: string, shared?: boolean): string {
  return `${shared ? "_shared/" : ""}${relPath}`;
}

/**
 * Detects when a caller accidentally passed a scope-prefixed relative path
 * (e.g. "_shared/core/user/prefer.md" together with shared=true), which would
 * nest into `<base>/_shared/core/...`. Normalizes separators so both posix and
 * windows-style paths are caught.
 */
function hasScopePrefix(relPath: string, scope: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.split("/")[0] === scope;
}

/**
 * Walk upward from `startDir` removing empty parent directories. Stops when:
 *  - directory is no longer inside `base`
 *  - directory equals `base`
 *  - directory is not empty
 *  - readdir/rmdir throws (best-effort cleanup)
 */
function pruneEmptyParents(startDir: string, base: string): void {
  const resolvedBase = path.resolve(base);
  let current = path.resolve(startDir);
  while (current !== resolvedBase && isPathInside(resolvedBase, current)) {
    try {
      if (fs.readdirSync(current).length !== 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function registerMemoryDelete(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a memory file. Set shared=true to delete from _shared/ folder.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file" }),
      shared: Type.Optional(Type.Boolean({ description: "If true, delete from _shared/" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: relPath, shared } = params as { path: string; shared?: boolean };
      const baseDir = resolveBase(settings, ctx.cwd, shared);
      const fullPath = resolvePathWithin(baseDir, relPath);

      if (!fullPath || hasSymlinkInPath(baseDir, fullPath)) {
        return {
          content: [{ type: "text", text: `Invalid memory path: ${labelFor(relPath, shared)}` }],
          details: { error: true },
        };
      }
      if (!fs.existsSync(fullPath)) {
        return {
          content: [{ type: "text", text: `File not found: ${labelFor(relPath, shared)}` }],
          details: { error: true },
        };
      }

      fs.unlinkSync(fullPath);
      pruneEmptyParents(path.dirname(fullPath), baseDir);

      return {
        content: [{ type: "text", text: `Deleted: ${labelFor(relPath, shared)}` }],
        details: { deleted: true, shared },
      };
    },

    renderCall: (args, theme) => {
      let text = `${theme.fg("toolTitle", theme.bold("memory_delete"))} `;
      if (args.shared) text += theme.fg("warning", "[shared] ");
      text += theme.fg("accent", formatValue(args.path));
      return new Text(text, 0, 0);
    },
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Deleting..."));
      const details = result.details as { error?: boolean } | undefined;
      const text = getResultText(result);
      return renderText(details?.error ? theme.fg("error", text) : theme.fg("success", text));
    },
  });
}

export function registerMemoryMove(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_move",
    label: "Memory Move",
    description: "Move a memory file. Set toShared=true to move to _shared/, fromShared=true if source is in _shared/.",
    parameters: Type.Object({
      from: Type.String({ description: "Source relative path" }),
      to: Type.String({ description: "Destination relative path" }),
      fromShared: Type.Optional(Type.Boolean({ description: "Source is in _shared/" })),
      toShared: Type.Optional(Type.Boolean({ description: "Destination is in _shared/" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { from, to, fromShared, toShared } = params as {
        from: string;
        to: string;
        fromShared?: boolean;
        toShared?: boolean;
      };

      // Guard destination against scope-prefixed path that would nest under
      // <dstBase>/_shared/. Source is intentionally NOT guarded so pre-existing
      // orphan files inside _shared/_shared/ can be moved out with fromShared=true.
      if (toShared && hasScopePrefix(to, "_shared")) {
        return {
          content: [
            {
              type: "text",
              text: `Do not prefix destination with "_shared/" when toShared=true. Got: ${to}`,
            },
          ],
          details: { error: true },
        };
      }

      const srcBase = resolveBase(settings, ctx.cwd, fromShared);
      const dstBase = resolveBase(settings, ctx.cwd, toShared);
      const srcPath = resolvePathWithin(srcBase, from);
      const dstPath = resolvePathWithin(dstBase, to);

      if (!srcPath || hasSymlinkInPath(srcBase, srcPath)) {
        return {
          content: [{ type: "text", text: `Invalid source path: ${labelFor(from, fromShared)}` }],
          details: { error: true },
        };
      }
      if (!dstPath || hasSymlinkInPath(dstBase, dstPath)) {
        return {
          content: [{ type: "text", text: `Invalid destination path: ${labelFor(to, toShared)}` }],
          details: { error: true },
        };
      }
      if (!fs.existsSync(srcPath)) {
        return {
          content: [{ type: "text", text: `Source not found: ${labelFor(from, fromShared)}` }],
          details: { error: true },
        };
      }
      if (fs.existsSync(dstPath)) {
        return {
          content: [{ type: "text", text: `Destination exists: ${labelFor(to, toShared)}` }],
          details: { error: true },
        };
      }

      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.renameSync(srcPath, dstPath);
      pruneEmptyParents(path.dirname(srcPath), srcBase);

      const srcLabel = labelFor(from, fromShared);
      const dstLabel = labelFor(to, toShared);
      return {
        content: [{ type: "text", text: `Moved: ${srcLabel} \u2192 ${dstLabel}` }],
        details: { from: srcLabel, to: dstLabel },
      };
    },

    renderCall: (args, theme) => {
      const srcLabel = `${args.fromShared ? "_shared/" : ""}${args.from}`;
      const dstLabel = `${args.toShared ? "_shared/" : ""}${args.to}`;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("memory_move"))} ${theme.fg("accent", `${srcLabel} \u2192 ${dstLabel}`)}`,
        0,
        0,
      );
    },
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Moving..."));
      const details = result.details as { error?: boolean } | undefined;
      const text = getResultText(result);
      return renderText(details?.error ? theme.fg("error", text) : theme.fg("success", text));
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
  registerMemoryDelete(pi, settings);
  registerMemoryMove(pi, settings);
}
