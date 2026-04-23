import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getHookActions, runHookTrigger } from "./hooks.js";
import {
  buildMemoryContext,
  countMemoryContextFiles,
  formatMemoryContext,
  getMemoryCoreDir,
  getMemoryDir,
  initializeMemoryDirectory,
  isMemoryInitialized,
  loadSettings,
} from "./memory-core.js";
import { gitExec, pushRepository, syncRepository } from "./memory-git.js";
import type { KeywordHandoffInstruction } from "./tape/tape-selector.js";
import { detectKeywordHandoff, MemoryFileSelector } from "./tape/tape-selector.js";
import { TapeService } from "./tape/tape-service.js";
import { registerAllTapeTools } from "./tape/tape-tools.js";
import { registerAllMemoryTools } from "./tools.js";
import type { HookAction, MemoryMdSettings } from "./types.js";
import { getProjectName, getTapeBasePath } from "./utils.js";

type ExtensionState = {
  tapeToolsRegistered: boolean;
  sessionStartHookPromise: ReturnType<typeof runHookTrigger> | null;
  initialMemoryContext: string | null;
  hasInjectedInitialContext: boolean;
  pendingKeywordHandoff: KeywordHandoffInstruction | null;
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
    pendingKeywordHandoff: null,
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
  const projectName = getProjectName(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();
  const tapeBasePath = getTapeBasePath(settings.localPath, settings.tape?.tapePath);
  const runtimeKey = [tapeBasePath, projectName, sessionId].join("::");

  if (!state.activeTapeRuntime || state.activeTapeRuntime.cacheKey !== runtimeKey) {
    const service = TapeService.create(tapeBasePath, projectName, sessionId, ctx.cwd);
    service.configureSessionTree(ctx.sessionManager, settings.tape?.anchor?.labelPrefix);

    state.activeTapeRuntime = {
      service,
      selector: new MemoryFileSelector(service, memoryDir, ctx.cwd, {
        whitelist: settings.tape?.context?.whitelist,
        blacklist: settings.tape?.context?.blacklist,
      }),
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
          if (result.success && !result.updated) continue;
          ctx.ui.notify(`${result.message} (start/${action})`, result.success ? "info" : "error");
        }
      }
      return results;
    });
  }

  state.initialMemoryContext = buildMemoryContext(settings, ctx.cwd);
  state.hasInjectedInitialContext = false;
  return true;
}

function queueKeywordHandoffMessage(pi: ExtensionAPI, keywordHandoff: KeywordHandoffInstruction | null): void {
  if (!keywordHandoff) return;

  pi.sendMessage(
    {
      customType: "pi-memory-md-tape-keyword",
      content: keywordHandoff.message,
      display: false,
    },
    { triggerTurn: false },
  );
}

function buildTapeHint(settings: MemoryMdSettings): string {
  const handoffMode = settings.tape?.anchor?.mode ?? "auto";
  const lines = [
    "---",
    "💡 Tape is enabled for this conversation. Use tape tools when you need anchors or tape history.",
  ];

  if (handoffMode === "manual") {
    lines.push(
      "Handoff mode: manual. `tape_handoff` is blocked unless the keyword is triggered or user create manually.",
    );
  }

  return `\n\n${lines.join("\n")}\n`;
}

function registerLifecycleHandlers(pi: ExtensionAPI, settings: MemoryMdSettings, state: ExtensionState): void {
  pi.on("session_start", async (event, ctx) => {
    ensureTapeRuntime(settings, state, ctx, { recordSessionStart: true, sessionStartReason: event.reason });

    if (!state.tapeToolsRegistered) {
      registerAllTapeTools(
        pi,
        () => state.activeTapeRuntime?.service ?? null,
        () => settings,
        () => {
          const keywordHandoff = state.pendingKeywordHandoff;
          state.pendingKeywordHandoff = null;
          return keywordHandoff;
        },
      );
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
    const keywordHandoff = tapeEnabled ? detectKeywordHandoff(event.prompt, settings.tape?.anchor?.keywords) : null;
    state.pendingKeywordHandoff = keywordHandoff;

    if (keywordHandoff) {
      ctx.ui.notify(`Tape keyword detected: ${keywordHandoff.primary}`, "info");
    }

    if (tapeEnabled && state.activeTapeRuntime && (mode === "system-prompt" || !state.hasInjectedInitialContext)) {
      const { fileLimit = 10, strategy = "smart", memoryScan = [72, 168] } = settings.tape?.context ?? {};
      const memoryFiles = state.activeTapeRuntime.selector.selectFilesForContext(strategy, fileLimit, { memoryScan });
      const selectedFiles = state.activeTapeRuntime.selector.finalizeContextFiles(memoryFiles);
      const highlightedFiles = [...new Set(memoryFiles.filter((filePath) => selectedFiles.includes(filePath)))].slice(
        0,
        3,
      );
      const memoryContext = state.activeTapeRuntime.selector.buildContextFromFiles(selectedFiles, {
        highlightedFiles,
      });
      const tapeHint = buildTapeHint(settings);
      const fileCount = selectedFiles.length;

      if (mode === "system-prompt") {
        queueKeywordHandoffMessage(pi, keywordHandoff);
        const injectedPrompt = [memoryContext + tapeHint].filter(Boolean).join("\n\n");
        ctx.ui.notify(`Tape mode: ${fileCount} memory files injected (system-prompt)`, "info");
        return { systemPrompt: `${event.systemPrompt}\n\n${injectedPrompt}` };
      }

      queueKeywordHandoffMessage(pi, keywordHandoff);
      state.hasInjectedInitialContext = true;
      const injectedMessage = [memoryContext + tapeHint].filter(Boolean).join("\n\n");
      ctx.ui.notify(`Tape mode: ${fileCount} memory files injected (message-append)`, "info");
      return { message: { customType: "pi-memory-md-tape", content: injectedMessage, display: false } };
    }

    if (keywordHandoff) {
      queueKeywordHandoffMessage(pi, keywordHandoff);
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
        if (result.success && !result.updated) continue;
        ctx.ui.notify(`${result.message} (end/${action})`, result.success ? "info" : "error");
      }
    }
  });
}

function buildManualAnchorMessage(prompt: string): string {
  return [
    "The user explicitly requested a manual tape anchor via /memory-anchor.",
    "",
    "Before continuing, call tape_handoff with:",
    '- trigger: "manual"',
    '- name: "<hierarchical anchor name derived from the user request>"',
    '- summary: "<brief intent summary in the user\'s language, under 18 words>"',
    '- purpose: "<1-2 word label>"',
    "",
    "Constraints:",
    "- Derive the anchor fields from the user prompt below.",
    "- Keep the name concrete and reusable.",
    "- Do not ask follow-up questions.",
    "- After creating the anchor, continue normally.",
    "",
    `User prompt: ${prompt}`,
  ].join("\n");
}

function registerMemoryCommands(pi: ExtensionAPI, settings: MemoryMdSettings, state: ExtensionState): void {
  pi.registerCommand("memory-status", {
    description: "Show memory repository status",
    handler: async (_args, ctx) => {
      const projectName = getProjectName(ctx.cwd);
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

  if (settings.tape?.enabled) {
    pi.registerCommand("memory-anchor", {
      description: "Ask the LLM to create a manual tape anchor from your prompt",
      handler: async (args, ctx) => {
        const prompt = args.trim();
        if (!prompt) {
          ctx.ui.notify("Usage: /memory-anchor <prompt>", "warning");
          return;
        }

        ensureTapeRuntime(settings, state, ctx, { recordSessionStart: false });
        if (!state.activeTapeRuntime?.service) {
          ctx.ui.notify("Tape runtime is unavailable.", "error");
          return;
        }

        pi.sendMessage(
          {
            customType: "pi-memory-md-tape-manual-anchor",
            content: buildManualAnchorMessage(prompt),
            display: false,
          },
          { triggerTurn: true },
        );
        ctx.ui.notify("Manual anchor request queued", "info");
      },
    });
  }
}

export default function memoryMdExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const state = createExtensionState();

  registerLifecycleHandlers(pi, settings, state);
  registerAllMemoryTools(pi, settings);
  registerMemoryCommands(pi, settings, state);
}
