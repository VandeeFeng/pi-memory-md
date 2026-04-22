import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getHookActions, runHookTrigger } from "./hooks.js";
import {
  buildMemoryContext,
  countMemoryContextFiles,
  expandPath,
  formatMemoryContext,
  getMemoryCoreDir,
  getMemoryDir,
  initializeMemoryDirectory,
  isMemoryInitialized,
  loadSettings,
} from "./memory-core.js";
import { gitExec, pushRepository, syncRepository } from "./memory-git.js";
import { MemoryFileSelector } from "./tape/tape-selector.js";
import { TapeService } from "./tape/tape-service.js";
import { registerAllTapeTools } from "./tape/tape-tools.js";
import { registerAllMemoryTools } from "./tools.js";
import type { HookAction, MemoryMdSettings } from "./types.js";

type ExtensionState = {
  tapeToolsRegistered: boolean;
  sessionStartHookPromise: ReturnType<typeof runHookTrigger> | null;
  initialMemoryContext: string | null;
  hasInjectedInitialContext: boolean;
  activeTapeRuntime: {
    service: TapeService;
    selector: MemoryFileSelector;
    cacheKey: string;
  } | null;
};

function createExtensionState(): ExtensionState {
  return {
    tapeToolsRegistered: false,
    sessionStartHookPromise: null,
    initialMemoryContext: null,
    hasInjectedInitialContext: false,
    activeTapeRuntime: null,
  };
}

function ensureTapeRuntime(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  options: { recordSessionStart: boolean; sessionStartReason?: "startup" | "reload" | "new" | "resume" | "fork" },
): void {
  if (!settings.tape?.enabled || !settings.localPath) {
    state.activeTapeRuntime = null;
    return;
  }

  const memoryDir = getMemoryDir(settings, ctx.cwd);
  const projectName = path.basename(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();
  const tapeBasePath = settings.tape?.tapePath
    ? expandPath(settings.tape.tapePath)
    : path.join(settings.localPath, "TAPE");
  const runtimeKey = [tapeBasePath, projectName, sessionId].join("::");

  if (!state.activeTapeRuntime || state.activeTapeRuntime.cacheKey !== runtimeKey) {
    const service = TapeService.create(tapeBasePath, projectName, sessionId, ctx.cwd);
    service.configureSessionTree(ctx.sessionManager, settings.tape?.anchor?.labelPrefix);

    state.activeTapeRuntime = {
      service,
      selector: new MemoryFileSelector(service, memoryDir),
      cacheKey: runtimeKey,
    };

    if (options.recordSessionStart) {
      service.recordSessionStart(options.sessionStartReason);
    }

    return;
  }

  state.activeTapeRuntime.service.configureSessionTree(ctx.sessionManager, settings.tape?.anchor?.labelPrefix);
}

async function runHookAction(pi: ExtensionAPI, settings: MemoryMdSettings, action: HookAction) {
  switch (action) {
    case "pull":
      return syncRepository(pi, settings);
    case "push":
      return pushRepository(pi, settings);
    default:
      return { success: false, message: `Unsupported hook action: ${action}` };
  }
}

function initMemoryContext(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  options: { showNotification: boolean; runSessionStartHooks: boolean },
): boolean {
  if (!settings.enabled) return false;

  const memoryDir = getMemoryDir(settings, ctx.cwd);
  if (!fs.existsSync(getMemoryCoreDir(memoryDir))) {
    if (options.showNotification) {
      ctx.ui.notify("Memory-md not initialized. Use /memory-init to set up project memory.", "info");
    }
    return false;
  }

  if (options.runSessionStartHooks && settings.localPath && getHookActions(settings, "sessionStart").length > 0) {
    state.sessionStartHookPromise = runHookTrigger(settings, "sessionStart", (action) =>
      runHookAction(pi, settings, action),
    ).then((results) => {
      if (settings.repoUrl) {
        for (const { action, result } of results) {
          ctx.ui.notify(`${result.message} (${action} on session start)`, result.success ? "info" : "error");
        }
      }
      return results;
    });
  }

  state.initialMemoryContext = buildMemoryContext(settings, ctx.cwd);
  state.hasInjectedInitialContext = false;
  return true;
}

function registerLifecycleHandlers(pi: ExtensionAPI, settings: MemoryMdSettings, state: ExtensionState): void {
  pi.on("tool_result", (_toolEvent, toolCtx) => {
    ensureTapeRuntime(settings, state, toolCtx, { recordSessionStart: false });

    if (!state.activeTapeRuntime) return;

    const info = state.activeTapeRuntime.service.getInfo();
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

      state.activeTapeRuntime.service.createAnchor(`auto/threshold-${timestamp}`);
      toolCtx.ui.notify(
        `Anchor auto-created: ${info.anchorCount} anchors total [threshold=${anchorThreshold}]`,
        "info",
      );
    }
  });

  pi.on("session_start", async (event, ctx) => {
    ensureTapeRuntime(settings, state, ctx, { recordSessionStart: true, sessionStartReason: event.reason });

    if (!state.tapeToolsRegistered) {
      registerAllTapeTools(pi, () => state.activeTapeRuntime?.service ?? null);
      state.tapeToolsRegistered = true;
    }

    if (event.reason === "new" || event.reason === "fork") {
      state.sessionStartHookPromise = null;
      initMemoryContext(pi, settings, state, ctx, { showNotification: true, runSessionStartHooks: false });
      return;
    }

    initMemoryContext(pi, settings, state, ctx, { showNotification: true, runSessionStartHooks: true });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ensureTapeRuntime(settings, state, ctx, { recordSessionStart: false });

    if (state.sessionStartHookPromise) {
      await state.sessionStartHookPromise;
      state.sessionStartHookPromise = null;
    }

    if (!settings.tape?.enabled) {
      state.initialMemoryContext = settings.enabled ? buildMemoryContext(settings, ctx.cwd) : null;
    }

    const mode = settings.injection || "message-append";
    const tapeEnabled = settings.tape?.enabled;

    if (tapeEnabled && state.activeTapeRuntime && (mode === "system-prompt" || !state.hasInjectedInitialContext)) {
      const { fileLimit = 10, alwaysInclude = [], strategy = "smart" } = settings.tape?.context ?? {};
      const memoryFiles = state.activeTapeRuntime.selector.selectFilesForContext(strategy, fileLimit);
      const memoryContext = state.activeTapeRuntime.selector.buildContextFromFiles([...alwaysInclude, ...memoryFiles]);
      const tapeHint = `\n\n---\n💡 Tape Context Management:\nYour conversation history is recorded in tape with anchors (checkpoints).\n- Use tape_info to check current tape status\n- Use tape_search to query historical entries by kind or content\n- Use tape_anchors to list all anchor checkpoints\n- Use tape_handoff to create a new anchor/checkpoint when starting a new task\n`;
      const fileCount = memoryFiles.length + alwaysInclude.length;

      if (mode === "system-prompt") {
        ctx.ui.notify(`Tape mode: ${fileCount} memory files injected (system-prompt)`, "info");
        return { systemPrompt: `${event.systemPrompt}\n\n${memoryContext + tapeHint}` };
      }

      state.hasInjectedInitialContext = true;
      ctx.ui.notify(`Tape mode: ${fileCount} memory files injected (message-append)`, "info");
      return { message: { customType: "pi-memory-md-tape", content: memoryContext + tapeHint, display: false } };
    }

    if (state.initialMemoryContext && (mode === "system-prompt" || !state.hasInjectedInitialContext)) {
      const fileCount = countMemoryContextFiles(state.initialMemoryContext);
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");

      if (mode === "message-append") {
        state.hasInjectedInitialContext = true;
        return {
          message: {
            customType: "pi-memory-md",
            content: formatMemoryContext(state.initialMemoryContext),
            display: false,
          },
        };
      }

      return { systemPrompt: `${event.systemPrompt}\n\n${formatMemoryContext(state.initialMemoryContext)}` };
    }

    return undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (getHookActions(settings, "sessionEnd").length === 0 || !settings.localPath) {
      return;
    }

    const memoryDir = getMemoryDir(settings, ctx.cwd);

    if (!fs.existsSync(getMemoryCoreDir(memoryDir))) {
      return;
    }

    const results = await runHookTrigger(settings, "sessionEnd", (action) => runHookAction(pi, settings, action));

    if (settings.repoUrl) {
      for (const { action, result } of results) {
        ctx.ui.notify(`${result.message} (${action} on session end)`, result.success ? "info" : "error");
      }
    }
  });
}

function registerMemoryCommands(pi: ExtensionAPI, settings: MemoryMdSettings, state: ExtensionState): void {
  pi.registerCommand("memory-status", {
    description: "Show memory repository status",
    handler: async (_args, ctx) => {
      const projectName = path.basename(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      if (!isMemoryInitialized(memoryDir)) {
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
      const alreadyInitialized = isMemoryInitialized(memoryDir);
      const result = await syncRepository(pi, settings);

      if (!result.success) {
        ctx.ui.notify(`Initialization failed: ${result.message}`, "error");
        return;
      }

      initializeMemoryDirectory(memoryDir);

      if (alreadyInitialized) {
        ctx.ui.notify(`Memory already exists: ${result.message}`, "info");
        return;
      }

      ctx.ui.notify(
        `Memory initialized: ${result.message}\n\nCreated:\n  - core/user\n  - core/project\n  - reference`,
        "info",
      );
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

      state.initialMemoryContext = memoryContext;
      state.hasInjectedInitialContext = false;

      const mode = settings.injection || "message-append";
      const fileCount = countMemoryContextFiles(memoryContext);

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
          content: formatMemoryContext(memoryContext),
          display: false,
        });
        ctx.ui.notify(`Memory refreshed: ${fileCount} files injected (${mode})`, "info");
        return;
      }

      ctx.ui.notify(`Memory cache refreshed: ${fileCount} files (will be injected on next prompt)`, "info");
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
          treeOutput = execSync(`find "${memoryDir}" -type d -not -path "*/node_modules/*"`, {
            encoding: "utf-8",
          });
        } catch {
          treeOutput = "Unable to generate directory tree.";
        }
      }

      ctx.ui.notify(treeOutput.trim(), "info");
    },
  });
}

export default function memoryMdExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const state = createExtensionState();

  registerLifecycleHandlers(pi, settings, state);
  registerAllMemoryTools(pi, settings);
  registerMemoryCommands(pi, settings, state);
}
