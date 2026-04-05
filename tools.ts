import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { MemoryFrontmatter, MemoryMdSettings } from "./memory-md.js";
import type { MemoryTapeService } from "./tape/tape-service.js";
export { registerAllTapeTools } from "./tape/tape-tools.js";
import {
  getCurrentDate,
  getMemoryDir,
  gitExec,
  listMemoryFiles,
  readMemoryFile,
  syncRepository,
  writeMemoryFile,
} from "./memory-md.js";

const TIMEOUT_MESSAGE =
  "Unable to connect to GitHub repository, connection timeout (10s). Please check your network connection or try again later.";

function renderWithExpandHint(text: string, theme: Theme, lineCount: number): Text {
  const remaining = lineCount - 1;
  if (remaining > 0) {
    text +=
      "\n" +
        theme.fg("muted", `... (${remaining} more lines,`) +
        " " +
        keyHint("app.tools.expand", "to expand") +
        theme.fg("muted", ")");
  }
  return new Text(text, 0, 0);
}

export function registerMemorySync(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
  tapeService?: MemoryTapeService,
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
      const memoryDir = getMemoryDir(settings, ctx);
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
          const commitMessage = `Update memory - ${timestamp}`;
          const commitResult = await gitExec(pi, localPath, ["commit", "-m", commitMessage]);

          if (!commitResult.success) {
            return {
              content: [{ type: "text", text: "Commit failed - nothing pushed" }],
              details: { success: false },
            };
          }
        }

        const result = await gitExec(pi, localPath, ["push"]);
        if (result.timeout) {
          return {
            content: [{ type: "text", text: TIMEOUT_MESSAGE }],
            details: { success: false, timeout: true },
          };
        }

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: hasChanges
                  ? `Committed and pushed changes to repository`
                  : `No changes to commit, repository up to date`,
              },
            ],
            details: { success: true, committed: hasChanges },
          };
        }

        return {
          content: [{ type: "text", text: "Push failed - check git status and authentication" }],
          details: { success: false },
        };
      }

      return {
        content: [{ type: "text", text: "Unknown action" }],
        details: {},
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("memory_sync "));
      text += theme.fg("accent", args.action);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const content = result.content[0];
      if (content?.type !== "text") {
        return new Text(theme.fg("dim", "Empty result"), 0, 0);
      }

      if (isPartial) {
        return new Text(theme.fg("warning", "Syncing..."), 0, 0);
      }

      if (!expanded) {
        const lines = content.text.split("\n");
        const summary = lines[0];
        return renderWithExpandHint(theme.fg("success", summary), theme, lines.length);
      }

      return new Text(theme.fg("toolOutput", content.text), 0, 0);
    },
  });
}

export function registerMemoryRead(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  tapeService?: MemoryTapeService,
): void {
  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a memory file by path",
    parameters: Type.Object({
      path: Type.String({
        description: "Relative path to memory file (e.g., 'core/user/identity.md')",
      }),
    }) as any,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: relPath } = params as { path: string };
      const memoryDir = getMemoryDir(settings, ctx);
      const fullPath = path.join(memoryDir, relPath);

      const memory = readMemoryFile(fullPath);
      if (!memory) {
        return {
          content: [{ type: "text", text: `Failed to read memory file: ${relPath}` }],
          details: { error: true },
        };
      }

      const description = memory.frontmatter.description || "No description";
      const tags = memory.frontmatter.tags?.join(", ") || "none";

      return {
        content: [
          {
            type: "text",
            text: `# ${description}\n\nTags: ${tags}\n\n${memory.content}`,
          },
        ],
        details: { frontmatter: memory.frontmatter },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("memory_read "));
      text += theme.fg("accent", args.path);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as { error?: boolean; frontmatter?: MemoryFrontmatter } | undefined;
      const content = result.content[0];

      if (isPartial) {
        return new Text(theme.fg("warning", "Reading..."), 0, 0);
      }

      if (details?.error) {
        const text = content?.type === "text" ? content.text : "Error";
        return new Text(theme.fg("error", text), 0, 0);
      }

      const desc = details?.frontmatter?.description || "Memory file";
      const tags = details?.frontmatter?.tags?.join(", ") || "none";
      const text = content?.type === "text" ? content.text : "";

      if (!expanded) {
        const lines = text.split("\n");
        const summary = `${theme.fg("success", desc)}\n${theme.fg("muted", `Tags: ${tags}`)}`;
        return renderWithExpandHint(summary, theme, lines.length + 2);
      }

      let resultText = theme.fg("success", desc);
      resultText += `\n${theme.fg("muted", `Tags: ${tags}`)}`;
      if (text) {
        resultText += `\n${theme.fg("toolOutput", text)}`;
      }
      return new Text(resultText, 0, 0);
    },
  });
}

export function registerMemoryWrite(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  tapeService?: MemoryTapeService,
): void {
  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description: "Create or update a memory file with YAML frontmatter",
    parameters: Type.Object({
      path: Type.String({
        description: "Relative path to memory file (e.g., 'core/user/identity.md')",
      }),
      content: Type.String({ description: "Markdown content" }),
      description: Type.String({ description: "Description for frontmatter" }),
      tags: Type.Optional(Type.Array(Type.String())),
    }) as any,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        path: relPath,
        content,
        description,
        tags,
      } = params as {
        path: string;
        content: string;
        description: string;
        tags?: string[];
      };

      const memoryDir = getMemoryDir(settings, ctx);
      const fullPath = path.join(memoryDir, relPath);

      const existing = readMemoryFile(fullPath);
      const existingFrontmatter = existing?.frontmatter || { description };

      const frontmatter: MemoryFrontmatter = {
        ...existingFrontmatter,
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

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("memory_write "));
      text += theme.fg("accent", args.path);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const content = result.content[0];
      if (content?.type !== "text") {
        return new Text(theme.fg("dim", "Empty result"), 0, 0);
      }

      if (isPartial) {
        return new Text(theme.fg("warning", "Writing..."), 0, 0);
      }

      if (!expanded) {
        const details = result.details as { frontmatter?: MemoryFrontmatter } | undefined;
        const lineCount = details?.frontmatter ? 3 : 1;
        return renderWithExpandHint(theme.fg("success", `Written: ${content.text}`), theme, lineCount);
      }

      const details = result.details as { path?: string; frontmatter?: MemoryFrontmatter } | undefined;
      let text = theme.fg("success", content.text);
      if (details?.frontmatter) {
        const fm = details.frontmatter;
        text += `\n${theme.fg("muted", `Description: ${fm.description}`)}`;
        if (fm.tags) {
          text += `\n${theme.fg("muted", `Tags: ${fm.tags.join(", ")}`)}`;
        }
      }
      return new Text(text, 0, 0);
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
    }) as any,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { directory } = params as { directory?: string };
      const memoryDir = getMemoryDir(settings, ctx);
      const searchDir = directory ? path.join(memoryDir, directory) : memoryDir;
      const files = listMemoryFiles(searchDir);
      const relPaths = files.map((f) => path.relative(memoryDir, f));

      return {
        content: [
          {
            type: "text",
            text: `Memory files (${relPaths.length}):\n\n${relPaths.map((p) => `  - ${p}`).join("\n")}`,
          },
        ],
        details: { files: relPaths, count: relPaths.length },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("memory_list"));
      if (args.directory) {
        text += ` ${theme.fg("accent", args.directory)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as { count?: number } | undefined;

      if (isPartial) {
        return new Text(theme.fg("warning", "Listing..."), 0, 0);
      }

      if (!expanded) {
        const count = details?.count ?? 0;
        const content = result.content[0];
        const lines = content?.type === "text" ? content.text.split("\n") : [];
        return renderWithExpandHint(theme.fg("success", `${count} memory files`), theme, lines.length);
      }

      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}

export function registerMemorySearch(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  tapeService?: MemoryTapeService,
): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search memory files by content or tags",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      searchIn: Type.Union([Type.Literal("content"), Type.Literal("tags"), Type.Literal("description")], {
        description: "Where to search",
      }),
    }) as any,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { query, searchIn } = params as {
        query: string;
        searchIn: "content" | "tags" | "description";
      };
      const memoryDir = getMemoryDir(settings, ctx);
      const files = listMemoryFiles(memoryDir);
      const results: Array<{ path: string; match: string }> = [];

      const queryLower = query.toLowerCase();

      for (const filePath of files) {
        const memory = readMemoryFile(filePath);
        if (!memory) continue;

        const relPath = path.relative(memoryDir, filePath);
        const { frontmatter, content } = memory;

        if (searchIn === "content") {
          if (content.toLowerCase().includes(queryLower)) {
            const lines = content.split("\n");
            const matchLine = lines.find((line) => line.toLowerCase().includes(queryLower));
            results.push({ path: relPath, match: matchLine || content.substring(0, 100) });
          }
        } else if (searchIn === "tags") {
          if (frontmatter.tags?.some((tag) => tag.toLowerCase().includes(queryLower))) {
            results.push({ path: relPath, match: `Tags: ${frontmatter.tags?.join(", ")}` });
          }
        } else if (searchIn === "description") {
          if (frontmatter.description.toLowerCase().includes(queryLower)) {
            results.push({ path: relPath, match: frontmatter.description });
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} result(s):\n\n${results.map((r) => `  ${r.path}\n  ${r.match}`).join("\n\n")}`,
          },
        ],
        details: { results, count: results.length },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("memory_search "));
      text += theme.fg("accent", `"${args.query}"`);
      text += ` ${theme.fg("muted", args.searchIn)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as { count?: number } | undefined;

      if (isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }

      if (!expanded) {
        const count = details?.count ?? 0;
        const content = result.content[0];
        const lines = content?.type === "text" ? content.text.split("\n") : [];
        return renderWithExpandHint(theme.fg("success", `${count} result(s)`), theme, lines.length);
      }

      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}

export function registerMemoryInit(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
  tapeService?: MemoryTapeService,
): void {
  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description: "Initialize memory repository (clone or create initial structure)",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Reinitialize even if already set up" })),
    }) as any,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { force = false } = params as { force?: boolean };

      if (isRepoInitialized.value && !force) {
        return {
          content: [
            {
              type: "text",
              text: "Memory repository already initialized. Use force: true to reinitialize.",
            },
          ],
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

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("memory_init"));
      if (args.force) {
        text += ` ${theme.fg("warning", "--force")}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as { initialized?: boolean; success?: boolean } | undefined;
      const content = result.content[0];

      if (isPartial) {
        return new Text(theme.fg("warning", "Initializing..."), 0, 0);
      }

      if (details?.initialized) {
        return new Text(theme.fg("muted", "Already initialized"), 0, 0);
      }

      if (!expanded) {
        const success = details?.success;
        const contentText = content?.type === "text" ? content.text : "";
        const lines = contentText.split("\n");
        const summary = success ? theme.fg("success", "Initialized") : theme.fg("error", "Initialization failed");
        return renderWithExpandHint(summary, theme, lines.length);
      }

      const text = content?.type === "text" ? content.text : "";
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}

export function registerMemoryCheck(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_check",
    label: "Memory Check",
    description: "Check current project memory folder structure",
    parameters: Type.Object({}) as any,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const memoryDir = getMemoryDir(settings, ctx);

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

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("memory_check")), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as { exists?: boolean; path?: string; fileCount?: number } | undefined;
      const content = result.content[0];

      if (isPartial) {
        return new Text(theme.fg("warning", "Checking..."), 0, 0);
      }

      if (!expanded) {
        const exists = details?.exists ?? true;
        const fileCount = details?.fileCount ?? 0;
        const contentText = content?.type === "text" ? content.text : "";
        const lines = contentText.split("\n");
        const summary = exists
          ? theme.fg("success", `Structure: ${fileCount} files`)
          : theme.fg("error", "Not initialized");
        return renderWithExpandHint(summary, theme, lines.length);
      }

      const text = content?.type === "text" ? content.text : "";
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}

export function registerAllTools(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
  tapeService?: MemoryTapeService,
): void {
  registerMemorySync(pi, settings, isRepoInitialized, tapeService);
  registerMemoryRead(pi, settings, tapeService);
  registerMemoryWrite(pi, settings, tapeService);
  registerMemoryList(pi, settings);
  registerMemorySearch(pi, settings, tapeService);
  registerMemoryInit(pi, settings, isRepoInitialized, tapeService);
  registerMemoryCheck(pi, settings);
}
