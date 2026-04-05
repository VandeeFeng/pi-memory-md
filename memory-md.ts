import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GrayMatterFile } from "gray-matter";
import matter from "gray-matter";
import { registerAllTools, registerAllTapeTools } from "./tools.js";
import { MemoryTapeService } from "./tape/tape-service.js";
import { MemoryFileSelector, ConversationSelector } from "./tape/tape-selector.js";
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

export interface MemoryMdSettings {
  enabled?: boolean;
  repoUrl?: string;
  localPath?: string;
  autoSync?: {
    onSessionStart?: boolean;
  };
  injection?: "system-prompt" | "message-append";
  systemPrompt?: {
    maxTokens?: number;
    includeProjects?: string[];
  };
  tape?: TapeConfig & { enabled?: boolean };
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

/**
 * Helper functions for paths, dates, and settings.
 */

const DEFAULT_LOCAL_PATH = path.join(os.homedir(), ".pi", "memory-md");

let localPath: string;

export function getLocalPath(): string {
  return localPath;
}

export function getCurrentDate(): string {
  return new Date().toISOString().split("T")[0];
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function getMemoryDir(settings: MemoryMdSettings, ctx: ExtensionContext): string {
  if (!localPath) {
    localPath = settings.localPath || DEFAULT_LOCAL_PATH;
  }
  return path.join(localPath, path.basename(ctx.cwd));
}

function getRepoName(settings: MemoryMdSettings): string {
  if (!settings.repoUrl) return "memory-md";
  const match = settings.repoUrl.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : "memory-md";
}

function loadSettings(): MemoryMdSettings {
  const DEFAULT_SETTINGS: MemoryMdSettings = {
    enabled: true,
    repoUrl: "",
    localPath: DEFAULT_LOCAL_PATH,
    autoSync: { onSessionStart: true },
    injection: "message-append",
    systemPrompt: {
      maxTokens: 10000,
      includeProjects: ["current"],
    },
    tape: {
      enabled: false,
      context: {
        strategy: "smart",
        fileLimit: 10,
      },
      tapePath: undefined, // Use default ~/.pi/memory-md/TAPE or {localPath}/TAPE
    },
  };

  const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!fs.existsSync(globalSettings)) {
    return DEFAULT_SETTINGS;
  }

  try {
    const content = fs.readFileSync(globalSettings, "utf-8");
    const parsed = JSON.parse(content);
    const loadedSettings = { ...DEFAULT_SETTINGS, ...(parsed["pi-memory-md"] as MemoryMdSettings) };

    if (loadedSettings.localPath) {
      loadedSettings.localPath = expandPath(loadedSettings.localPath);
    }

    return loadedSettings;
  } catch (error) {
    console.warn("Failed to load memory settings:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Git sync operations (fetch, pull, push, status).
 */

const TIMEOUT_MS = 10000;
const TIMEOUT_MESSAGE =
  "Unable to connect to GitHub repository, connection timeout (10s). Please check your network connection or try again later.";

export async function gitExec(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<GitResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await pi.exec("git", args, { cwd, signal: controller.signal });
    clearTimeout(timeoutId);
    return { stdout: result.stdout || "", success: true };
  } catch (error) {
    clearTimeout(timeoutId);
    const err = error as { name?: string; code?: string };
    const isTimeout = err?.name === "AbortError" || err?.code === "ABORT_ERR";
    if (isTimeout) return { stdout: "", success: false, timeout: true };
    return { stdout: "", success: false };
  }
}

export async function syncRepository(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): Promise<SyncResult> {
  const { localPath, repoUrl } = settings;

  if (!repoUrl || !localPath) {
    return { success: false, message: "GitHub repo URL or local path not configured" };
  }

  const repoName = getRepoName(settings);

  if (fs.existsSync(localPath)) {
    const gitDir = path.join(localPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return { success: false, message: `Directory exists but is not a git repo: ${localPath}` };
    }

    const pullResult = await gitExec(pi, localPath, ["pull", "--rebase", "--autostash"]);
    if (pullResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
    if (!pullResult.success) return { success: false, message: "Pull failed - check repo URL and authentication" };

    isRepoInitialized.value = true;
    const updated = pullResult.stdout.includes("Updating") || pullResult.stdout.includes("Fast-forward");

    return {
      success: true,
      message: updated ? `Pulled latest changes from [${repoName}]` : `[${repoName}] is already latest`,
      updated,
    };
  }

  fs.mkdirSync(localPath, { recursive: true });

  const memoryDirName = path.basename(localPath);
  const parentDir = path.dirname(localPath);
  const cloneResult = await gitExec(pi, parentDir, ["clone", repoUrl, memoryDirName]);

  if (cloneResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
  if (cloneResult.success) {
    isRepoInitialized.value = true;
    return { success: true, message: `Cloned [${repoName}] successfully`, updated: true };
  }

  return { success: false, message: "Clone failed - check repo URL and authentication" };
}

/**
 * Memory file read/write/list operations.
 */

function validateFrontmatter(data: ParsedFrontmatter): { valid: boolean; error?: string } {
  if (!data) {
    return { valid: false, error: "No frontmatter found (requires --- delimiters)" };
  }

  const frontmatter = data as MemoryFrontmatter;

  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    return { valid: false, error: "'description' must be a string if provided" };
  }

  if (frontmatter.limit !== undefined && (typeof frontmatter.limit !== "number" || frontmatter.limit <= 0)) {
    return { valid: false, error: "'limit' must be a positive number" };
  }

  if (frontmatter.tags !== undefined && !Array.isArray(frontmatter.tags)) {
    return { valid: false, error: "'tags' must be an array of strings" };
  }

  return { valid: true };
}

export function readMemoryFile(filePath: string): MemoryFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(content);

    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return {
        path: filePath,
        frontmatter: { description: "No description" },
        content: content,
      };
    }

    const validation = validateFrontmatter(parsed.data);

    if (!validation.valid) {
      return {
        path: filePath,
        frontmatter: { description: "No description" },
        content: content,
      };
    }

    return {
      path: filePath,
      frontmatter: parsed.data as MemoryFrontmatter,
      content: parsed.content,
    };
  } catch (error) {
    console.error(`Failed to read memory file ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function listMemoryFiles(memoryDir: string): string[] {
  const files: string[] = [];

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walkDir(memoryDir);
  return files;
}

export function writeMemoryFile(filePath: string, content: string, frontmatter: MemoryFrontmatter): void {
  const fileDir = path.dirname(filePath);
  fs.mkdirSync(fileDir, { recursive: true });
  const frontmatterStr = matter.stringify(content, frontmatter);
  fs.writeFileSync(filePath, frontmatterStr);
}

/**
 * Build memory context for agent prompt.
 */

function ensureDirectoryStructure(memoryDir: string): void {
  const dirs = [
    path.join(memoryDir, "core", "user"),
    path.join(memoryDir, "core", "project"),
    path.join(memoryDir, "reference"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createDefaultFiles(memoryDir: string): void {
  const identityFile = path.join(memoryDir, "core", "user", "identity.md");
  if (!fs.existsSync(identityFile)) {
    writeMemoryFile(identityFile, "# User Identity\n\nCustomize this file with your information.", {
      description: "User identity and background",
      tags: ["user", "identity"],
      created: getCurrentDate(),
    });
  }

  const preferFile = path.join(memoryDir, "core", "user", "prefer.md");
  if (!fs.existsSync(preferFile)) {
    writeMemoryFile(
      preferFile,
      "# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming preferred",
      {
        description: "User habits and code style preferences",
        tags: ["user", "preferences"],
        created: getCurrentDate(),
      },
    );
  }
}

function buildMemoryContext(settings: MemoryMdSettings, ctx: ExtensionContext): string {
  const coreDir = path.join(getMemoryDir(settings, ctx), "core");

  if (!fs.existsSync(coreDir)) {
    return "";
  }

  const files = listMemoryFiles(coreDir);
  if (files.length === 0) {
    return "";
  }

  const memoryDir = getMemoryDir(settings, ctx);
  const lines: string[] = [
    "# Project Memory",
    "",
    "Available memory files (use memory_read to view full content):",
    "",
  ];

  for (const filePath of files) {
    const memory = readMemoryFile(filePath);
    if (memory) {
      const relPath = path.relative(memoryDir, filePath);
      const { description, tags } = memory.frontmatter;
      const tagStr = tags?.join(", ") || "none";
      lines.push(`- ${relPath}`);
      lines.push(`  Description: ${description}`);
      lines.push(`  Tags: ${tagStr}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Main extension initialization.
 *
 * Lifecycle:
 * 1. session_start: Handle all session transitions with event.reason:
 *    - startup/reload/resume: Show notification, auto-sync
 *    - new/fork: Show notification, no auto-sync (same project, already synced)
 * 2. before_agent_start: Wait for sync, then inject memory on first agent turn
 * 4. Register tools and commands for memory operations
 *
 * Memory injection modes:
 * - message-append (default): Send as custom message with display: false, not visible in TUI but persists in session
 * - system-prompt: Append to system prompt on each agent turn (rebuilds every prompt)
 *
 * Key optimization:
 * - Sync runs asynchronously without blocking user input
 * - Memory is injected after user sends first message (before_agent_start)
 * - Memory is re-injected when using /new to start a new session in the same pi process
 *
 * Configuration:
 * Set injection in settings to choose between "message-append" or "system-prompt"
 *
 * Commands:
 * - /memory-status: Show repository status
 * - /memory-init: Initialize memory repository
 * - /memory-refresh: Manually refresh memory context
 */

export default function memoryMdExtension(pi: ExtensionAPI) {
  let settings: MemoryMdSettings = loadSettings();
  const repoInitialized = { value: false };
  let syncPromise: Promise<SyncResult> | null = null;
  let cachedMemoryContext: string | null = null;
  let memoryInjected = false;
  let tapeService: MemoryTapeService | null = null;
  let contextSelector: MemoryFileSelector | null = null;
  let tapeToolsRegistered = false;

  function initMemoryContext(
    ctx: ExtensionContext,
    options: { showNotification: boolean; autoSync: boolean },
  ): boolean {
    settings = loadSettings();

    if (!settings.enabled) return false;

    const memoryDir = getMemoryDir(settings, ctx);
    const coreDir = path.join(memoryDir, "core");

    if (!fs.existsSync(coreDir)) {
      if (options.showNotification) {
        ctx.ui.notify("Memory-md not initialized. Use /memory-init to set up project memory.", "info");
      }
      return false;
    }

    if (options.autoSync && settings.autoSync?.onSessionStart && settings.localPath) {
      syncPromise = syncRepository(pi, settings, repoInitialized).then((syncResult) => {
        if (settings.repoUrl) {
          ctx.ui.notify(syncResult.message, syncResult.success ? "info" : "error");
        }
        return syncResult;
      });
    }

    cachedMemoryContext = buildMemoryContext(settings, ctx);
    memoryInjected = false;
    return true;
  }

  pi.on("session_start", async (event, ctx) => {
    // https://github.com/badlogic/pi-mono/releases/tag/v0.65.0
    // Removed extension post-transition events session_switch and session_fork. Use session_start with event.reason ("startup" | "reload" | "new" | "resume" | "fork"). For "new", "resume", and "fork", session_start includes previousSessionFile.
    // I like this new uniform logic event.reason: "startup" | "reload" | "new" | "resume" | "fork"
    // It's better than session_switch and session_fork!

    // Initialize tape service if tape mode is enabled
    if (settings.tape?.enabled) {
      const memoryDir = getMemoryDir(settings, ctx);
      const projectName = path.basename(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      tapeService = MemoryTapeService.create(memoryDir, settings.tape, projectName, sessionId);
      contextSelector = new MemoryFileSelector(tapeService, memoryDir);
      tapeService.recordSessionStart();

      // Always register tape tools in tape mode (LLM queries history on demand)
      if (!tapeToolsRegistered) {
        registerAllTapeTools(pi, tapeService);
        tapeToolsRegistered = true;
      }

      // Record user messages
      pi.on("message_start", (msgEvent, _msgCtx) => {
        if (!tapeService) return;
        const message = msgEvent.message as { role: string; content?: string | Array<{ type: string; text?: string }> };
        if (message.role !== "user") return;
        const content = typeof message.content === "string" ? message.content : 
          Array.isArray(message.content) ? message.content.map(c => c.text || "").join("") : "";
        tapeService.startNewTurn();
        tapeService.recordUserMessage(content);
      });



      // Record assistant messages (only when complete, not during streaming)
      pi.on("message_end", (msgEvent, _msgCtx) => {
        if (!tapeService) return;
        const message = msgEvent.message as { role: string; content?: string | Array<{ type: string; text?: string }> };
        if (message.role !== "assistant") return;
        const content = typeof message.content === "string" ? message.content : 
          Array.isArray(message.content) ? message.content.map(c => c.text || "").join("") : "";
        tapeService.recordAssistantMessage(content);
      });

      // Record tool calls
      pi.on("tool_call", (toolEvent, _toolCtx) => {
        if (!tapeService) return;
        tapeService.recordToolCall(toolEvent.toolName, toolEvent.input as Record<string, unknown>);
      });

      // Register tool_result listener to record memory operations and tool results
      pi.on("tool_result", (toolEvent, _toolCtx) => {
        if (!tapeService) return;

        const { toolName, input, details } = toolEvent;

        // Step 1: Record all operations first (tool_result + specific memory operations)
        tapeService.recordToolResult(toolName, details);

        // Record memory operations specifically
        if (toolName === "memory_read") {
          const params = input as { path: string };
          tapeService.recordMemoryRead(params.path);
        }

        if (toolName === "memory_write") {
          const params = input as { path: string; description: string; tags?: string[] };
          tapeService.recordMemoryWrite(params.path, { description: params.description, tags: params.tags });
        }

        if (toolName === "memory_search") {
          const params = input as { query: string; searchIn: string };
          const searchDetails = details as { count?: number } | undefined;
          tapeService.recordMemorySearch(params.query, params.searchIn, searchDetails?.count || 0);
        }

        if (toolName === "memory_sync") {
          const params = input as { action: string };
          const syncDetails = details as { success?: boolean; initialized?: boolean } | undefined;
          tapeService.recordMemorySync(params.action, { success: syncDetails?.success, initialized: syncDetails?.initialized });
        }

        if (toolName === "memory_init") {
          const params = input as { force?: boolean };
          tapeService.recordMemoryInit(params.force || false);
        }

        // Step 2: After all recordings, check if we need to create a new anchor
        const info = tapeService.getInfo();
        const anchorConfig = settings.tape?.anchor ?? { mode: "threshold", threshold: 15 };
        
        if (anchorConfig.mode === "threshold" && info.entriesSinceLastAnchor >= (anchorConfig.threshold ?? 15)) {
          const now = new Date();
          const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
          tapeService.createAnchor(`auto/threshold-${timestamp}`, { 
            reason: "Entries since last anchor exceeded threshold",
            entriesSinceLastAnchor: info.entriesSinceLastAnchor,
            threshold: anchorConfig.threshold
          });
          ctx.ui.notify(`Auto-created anchor: ${info.entriesSinceLastAnchor} entries since last anchor (${info.anchorCount} anchors total)`, "info");
        }
      });
    }

    if (event.reason === "new" || event.reason === "fork") {
      // Clear any pending sync from previous session to avoid waiting for it
      syncPromise = null;
      initMemoryContext(ctx, { showNotification: true, autoSync: false });
    } else {
      initMemoryContext(ctx, { showNotification: true, autoSync: true });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (syncPromise) {
      await syncPromise;
      syncPromise = null;
    }

    const mode = settings.injection || "message-append";
    const tapeEnabled = settings.tape?.enabled;

    // Tape mode: inject dynamic context with smart selection, only once
    if (tapeEnabled && tapeService && contextSelector) {
      try {
        const tapeConfig = settings.tape;
        const contextConfig = tapeConfig?.context || {
          strategy: "smart",
          fileLimit: 10,
          alwaysInclude: [],
        };
        const limit = contextConfig.fileLimit || 10;
        const alwaysInclude = contextConfig.alwaysInclude || [];

        // Only inject memory files once per session
        if (!memoryInjected) {
          const memoryFiles = contextSelector.selectFilesForContext(contextConfig.strategy || "smart", limit);
          const memoryContext = contextSelector.buildContextFromFiles([
            ...alwaysInclude,
            ...memoryFiles,
          ]);

          const tapeHint = `

---
💡 Tape Context Management:
Your conversation history is recorded in tape with anchors (checkpoints).
- Use tape_info to check current tape status
- Use tape_search to query historical entries by kind or content
- Use tape_anchors to list all anchor checkpoints
- Use tape_handoff to create a new anchor/checkpoint when starting a new task
`;

          const fileCount = memoryFiles.length + alwaysInclude.length;

          // In system-prompt mode, tape overrides system prompt
          if (mode === "system-prompt") {
            memoryInjected = true;
            ctx.ui.notify(
              `Tape mode: ${fileCount} memory files injected (overrides system prompt)`,
              "info",
            );
            return {
              systemPrompt: memoryContext + tapeHint,
            };
          }

          // In message-append mode, return as custom message
          memoryInjected = true;
          ctx.ui.notify(
            `Tape mode: ${fileCount} memory files injected (message-append)`,
            "info",
          );
          return {
            message: {
              customType: "pi-memory-md-tape",
              content: memoryContext + tapeHint,
              display: false,
            },
          };
        }
      } catch (error) {
        console.error("Tape injection failed:", error);
      }
      return undefined;
    }

    // Non-tape modes: use cached memory context
    if (!cachedMemoryContext) return undefined;

    const isFirstInjection = !memoryInjected;

    if (isFirstInjection) {
      memoryInjected = true;
      const fileCount = cachedMemoryContext.split("\n").filter((l) => l.startsWith("-")).length;
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");
    }

    if (mode === "message-append" && isFirstInjection) {
      return {
        message: {
          customType: "pi-memory-md",
          content: `# Project Memory\n\n${cachedMemoryContext}`,
          display: false,
        },
      };
    }

    if (mode === "system-prompt") {
      return {
        systemPrompt: `${event.systemPrompt}\n\n# Project Memory\n\n${cachedMemoryContext}`,
      };
    }

    return undefined;
  });

  registerAllTools(pi, settings, repoInitialized);

  pi.registerCommand("memory-status", {
    description: "Show memory repository status",
    handler: async (_args, ctx) => {
      const projectName = path.basename(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx);
      const coreUserDir = path.join(memoryDir, "core", "user");

      if (!fs.existsSync(coreUserDir)) {
        ctx.ui.notify(`Memory: ${projectName} | Not initialized | Use /memory-init to set up`, "info");
        return;
      }

      const result = await gitExec(pi, settings.localPath!, ["status", "--porcelain"]);
      const isDirty = result.stdout.trim().length > 0;

      ctx.ui.notify(
        `Memory: ${projectName} | Repo: ${isDirty ? "Uncommitted changes" : "Clean"} | Path: ${memoryDir}`,
        isDirty ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("memory-init", {
    description: "Initialize memory repository",
    handler: async (_args, ctx) => {
      const memoryDir = getMemoryDir(settings, ctx);
      const alreadyInitialized = fs.existsSync(path.join(memoryDir, "core", "user"));

      const result = await syncRepository(pi, settings, repoInitialized);

      if (!result.success) {
        ctx.ui.notify(`Initialization failed: ${result.message}`, "error");
        return;
      }

      ensureDirectoryStructure(memoryDir);
      createDefaultFiles(memoryDir);

      if (alreadyInitialized) {
        ctx.ui.notify(`Memory already exists: ${result.message}`, "info");
      } else {
        ctx.ui.notify(
          `Memory initialized: ${result.message}\n\nCreated:\n  - core/user\n  - core/project\n  - reference`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("memory-refresh", {
    description: "Refresh memory context from files",
    handler: async (_args, ctx) => {
      const memoryContext = buildMemoryContext(settings, ctx);

      if (!memoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      cachedMemoryContext = memoryContext;
      memoryInjected = false;

      const mode = settings.injection || "message-append";
      const fileCount = memoryContext.split("\n").filter((l) => l.startsWith("-")).length;

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
          content: `# Project Memory (Refreshed)\n\n${memoryContext}`,
          display: false,
        });
        ctx.ui.notify(`Memory refreshed: ${fileCount} files injected (${mode})`, "info");
      } else {
        ctx.ui.notify(`Memory cache refreshed: ${fileCount} files (will be injected on next prompt)`, "info");
      }
    },
  });

  pi.registerCommand("memory-check", {
    description: "Check memory folder structure",
    handler: async (_args, ctx) => {
      const memoryDir = getMemoryDir(settings, ctx);

      if (!fs.existsSync(memoryDir)) {
        ctx.ui.notify(`Memory directory not found: ${memoryDir}`, "error");
        return;
      }

      const { execSync } = await import("node:child_process");
      let treeOutput = "";

      try {
        treeOutput = execSync(`tree -L 3 -I "node_modules" "${memoryDir}"`, { encoding: "utf-8" });
      } catch {
        try {
          treeOutput = execSync(`find "${memoryDir}" -type d -not -path "*/node_modules/*"`, { encoding: "utf-8" });
        } catch {
          treeOutput = "Unable to generate directory tree.";
        }
      }

      ctx.ui.notify(treeOutput.trim(), "info");
    },
  });
}
