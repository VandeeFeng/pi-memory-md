import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildMemoryContext,
  createDefaultFiles,
  ensureDirectoryStructure,
  getMemoryDir,
  gitExec,
  loadSettings,
  type MemoryMdSettings,
  syncRepository,
} from "./memoryMdCore.js";
import { MemoryFileSelector } from "./tape/tape-selector.js";
import { MemoryTapeService } from "./tape/tape-service.js";
import { registerAllTapeTools } from "./tape/tape-tools.js";
import { registerAllMemoryTools } from "./tools.js";

/**
 * Main extension initialization.
 */

export default function memoryMdExtension(pi: ExtensionAPI) {
  let settings: MemoryMdSettings = loadSettings();
  const repoInitialized = { value: false };
  let syncPromise: ReturnType<typeof syncRepository> | null = null;
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

    const memoryDir = getMemoryDir(settings, ctx.cwd);
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

    cachedMemoryContext = buildMemoryContext(settings, ctx.cwd);
    memoryInjected = false;
    return true;
  }

  pi.on("session_start", async (event, ctx) => {
    if (settings.tape?.enabled) {
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const projectName = path.basename(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      tapeService = MemoryTapeService.create(settings.localPath!, projectName, sessionId, ctx.cwd);
      tapeService.setSessionManager(ctx.sessionManager);
      contextSelector = new MemoryFileSelector(tapeService, memoryDir);
      tapeService.recordSessionStart();

      if (!tapeToolsRegistered) {
        registerAllTapeTools(pi, tapeService);
        tapeToolsRegistered = true;
      }

      pi.on("tool_result", (_toolEvent, _toolCtx) => {
        if (!tapeService) return;

        const info = tapeService.getInfo();
        const anchorConfig = settings.tape?.anchor ?? { mode: "threshold", threshold: 25 };

        if (anchorConfig.mode === "threshold" && info.entriesSinceLastAnchor >= (anchorConfig.threshold ?? 25)) {
          const now = new Date();
          const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
          tapeService.createAnchor(`auto/threshold-${timestamp}`);
          ctx.ui.notify(
            `Auto-created anchor: ${info.entriesSinceLastAnchor} entries since last anchor (${info.anchorCount} anchors total)`,
            "info",
          );
        }
      });
    }

    if (event.reason === "new" || event.reason === "fork") {
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
      const fileCount = cachedMemoryContext.split("\n").filter((l) => l.startsWith("-")).length;
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");

      if (mode === "message-append") {
        return {
          message: {
            customType: "pi-memory-md",
            content: `# Project Memory\n\n${cachedMemoryContext}`,
            display: false,
          },
        };
      }
      return { systemPrompt: `${event.systemPrompt}\n\n# Project Memory\n\n${cachedMemoryContext}` };
    }

    return undefined;
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
