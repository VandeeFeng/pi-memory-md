import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getHookActions, runHookTrigger } from "./hooks.js";
import { gitExec, pushRepository, syncRepository } from "./memoryGit.js";
import {
  buildMemoryContext,
  createDefaultFiles,
  ensureDirectoryStructure,
  getMemoryDir,
  loadSettings,
} from "./memoryMdCore.js";
import { MemoryFileSelector } from "./tape/tape-selector.js";
import { MemoryTapeService } from "./tape/tape-service.js";
import { registerAllTapeTools } from "./tape/tape-tools.js";
import { registerAllMemoryTools } from "./tools.js";
import type { HookAction, MemoryMdSettings } from "./types.js";

/**
 * Main extension initialization.
 */

export default function memoryMdExtension(pi: ExtensionAPI): void {
  const settings: MemoryMdSettings = loadSettings();
  const repoInitialized = { value: false };
  let hookPromise: ReturnType<typeof runHookTrigger> | null = null;
  let cachedMemoryContext: string | null = null;
  let memoryInjected = false;
  let tapeService: MemoryTapeService | null = null;
  let tapeRuntimeKey: string | null = null;
  let contextSelector: MemoryFileSelector | null = null;
  let tapeToolsRegistered = false;

  function withMemoryTitle(context: string): string {
    return context.trimStart().startsWith("# Project Memory") ? context : `# Project Memory\n\n${context}`;
  }

  function ensureTapeRuntime(ctx: ExtensionContext, options: { recordSessionStart: boolean }): void {
    if (!settings.tape?.enabled || !settings.localPath) {
      tapeService = null;
      tapeRuntimeKey = null;
      contextSelector = null;
      return;
    }

    const memoryDir = getMemoryDir(settings, ctx.cwd);
    const projectName = path.basename(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const runtimeKey = [settings.localPath, projectName, sessionId].join("::");

    if (!tapeService || tapeRuntimeKey !== runtimeKey) {
      tapeService = MemoryTapeService.create(settings.localPath, projectName, sessionId, ctx.cwd);
      tapeService.configureSessionTree(ctx.sessionManager, settings.tape?.anchor?.labelPrefix);
      contextSelector = new MemoryFileSelector(tapeService, memoryDir);
      tapeRuntimeKey = runtimeKey;

      if (options.recordSessionStart) {
        tapeService.recordSessionStart();
      }

      return;
    }

    tapeService.configureSessionTree(ctx.sessionManager, settings.tape?.anchor?.labelPrefix);

    if (!contextSelector) {
      contextSelector = new MemoryFileSelector(tapeService, memoryDir);
    }
  }

  async function runHookAction(action: HookAction) {
    switch (action) {
      case "pull":
        return syncRepository(pi, settings, repoInitialized);
      case "push":
        return pushRepository(pi, settings);
      default:
        return { success: false, message: `Unsupported hook action: ${action}` };
    }
  }

  function initMemoryContext(
    ctx: ExtensionContext,
    options: { showNotification: boolean; runSessionStartHooks: boolean },
  ): boolean {
    if (!settings.enabled) return false;

    const memoryDir = getMemoryDir(settings, ctx.cwd);
    const coreDir = path.join(memoryDir, "core");

    if (!fs.existsSync(coreDir)) {
      if (options.showNotification) {
        ctx.ui.notify("Memory-md not initialized. Use /memory-init to set up project memory.", "info");
      }
      return false;
    }

    if (options.runSessionStartHooks && settings.localPath && getHookActions(settings, "sessionStart").length > 0) {
      hookPromise = runHookTrigger(settings, "sessionStart", runHookAction).then((results) => {
        if (settings.repoUrl) {
          for (const { action, result } of results) {
            ctx.ui.notify(`${result.message} (${action} on session start)`, result.success ? "info" : "error");
          }
        }
        return results;
      });
    }

    cachedMemoryContext = buildMemoryContext(settings, ctx.cwd);
    memoryInjected = false;
    return true;
  }

  pi.on("tool_result", (_toolEvent, toolCtx) => {
    ensureTapeRuntime(toolCtx, { recordSessionStart: false });

    if (!tapeService) return;

    const info = tapeService.getInfo();
    const anchorMode = settings.tape?.anchor?.mode ?? "threshold";
    const anchorThreshold = settings.tape?.anchor?.threshold ?? 25;

    if (anchorMode === "threshold" && info.entriesSinceLastAnchor >= anchorThreshold) {
      const now = new Date();
      const timestamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");

      tapeService.createAnchor(`auto/threshold-${timestamp}`);
      toolCtx.ui.notify(
        `Auto-created anchor: ${info.entriesSinceLastAnchor} entries since last anchor (${info.anchorCount} anchors total)`,
        "info",
      );
    }
  });

  pi.on("session_start", async (event, ctx) => {
    ensureTapeRuntime(ctx, { recordSessionStart: true });

    if (!tapeToolsRegistered) {
      registerAllTapeTools(pi, () => tapeService);
      tapeToolsRegistered = true;
    }

    if (event.reason === "new" || event.reason === "fork") {
      hookPromise = null;
      initMemoryContext(ctx, { showNotification: true, runSessionStartHooks: false });
    } else {
      initMemoryContext(ctx, { showNotification: true, runSessionStartHooks: true });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ensureTapeRuntime(ctx, { recordSessionStart: false });

    if (hookPromise) {
      await hookPromise;
      hookPromise = null;
    }

    if (!settings.tape?.enabled) {
      cachedMemoryContext = settings.enabled ? buildMemoryContext(settings, ctx.cwd) : null;
    }

    const mode = settings.injection || "message-append";
    const tapeEnabled = settings.tape?.enabled;

    if (tapeEnabled && tapeService && contextSelector && !memoryInjected) {
      const { fileLimit = 10, alwaysInclude = [], strategy = "smart" } = settings.tape?.context ?? {};

      const memoryFiles = contextSelector.selectFilesForContext(strategy, fileLimit);
      const memoryContext = contextSelector.buildContextFromFiles([...alwaysInclude, ...memoryFiles]);
      const tapeHint = `\n\n---\n💡 Tape Context Management:\nYour conversation history is recorded in tape with anchors (checkpoints).\n- Use tape_info to check current tape status\n- Use tape_search to query historical entries by kind or content\n- Use tape_anchors to list all anchor checkpoints\n- Use tape_handoff to create a new anchor/checkpoint when starting a new task\n`;
      const fileCount = memoryFiles.length + alwaysInclude.length;

      memoryInjected = true;

      if (mode === "system-prompt") {
        ctx.ui.notify(`Tape mode: ${fileCount} memory files injected (overrides system prompt)`, "info");
        return { systemPrompt: memoryContext + tapeHint };
      }

      ctx.ui.notify(`Tape mode: ${fileCount} memory files injected (message-append)`, "info");
      return { message: { customType: "pi-memory-md-tape", content: memoryContext + tapeHint, display: false } };
    }

    if (cachedMemoryContext && !memoryInjected) {
      memoryInjected = true;
      const fileCount = cachedMemoryContext.split("\n").filter((line) => line.startsWith("-")).length;
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");

      if (mode === "message-append") {
        return {
          message: {
            customType: "pi-memory-md",
            content: withMemoryTitle(cachedMemoryContext),
            display: false,
          },
        };
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${withMemoryTitle(cachedMemoryContext)}` };
    }

    return undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (getHookActions(settings, "sessionEnd").length === 0 || !settings.localPath) {
      return;
    }

    const memoryDir = getMemoryDir(settings, ctx.cwd);
    const coreDir = path.join(memoryDir, "core");

    if (!fs.existsSync(coreDir)) {
      return;
    }

    const results = await runHookTrigger(settings, "sessionEnd", runHookAction);
    if (settings.repoUrl) {
      for (const { action, result } of results) {
        ctx.ui.notify(`${result.message} (${action} on session end)`, result.success ? "info" : "error");
      }
    }
  });

  registerAllMemoryTools(pi, settings, repoInitialized);

  pi.registerCommand("memory-status", {
    description: "Show memory repository status",
    handler: async (_args, ctx) => {
      const projectName = path.basename(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx.cwd);
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
      const memoryDir = getMemoryDir(settings, ctx.cwd);
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
      const memoryContext = buildMemoryContext(settings, ctx.cwd);

      if (!memoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      cachedMemoryContext = memoryContext;
      memoryInjected = false;

      const mode = settings.injection || "message-append";
      const fileCount = memoryContext.split("\n").filter((line) => line.startsWith("-")).length;

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
          content: withMemoryTitle(memoryContext),
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
      const memoryDir = getMemoryDir(settings, ctx.cwd);

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
