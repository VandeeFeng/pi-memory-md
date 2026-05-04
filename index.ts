import fs from "node:fs";
import { setImmediate as waitForNextTick } from "node:timers/promises";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getHookActions, runHookTrigger } from "./hooks.js";
import {
  buildMemoryContextAsync,
  countMemoryContextFiles,
  DEFAULT_MEMORY_SCAN,
  formatMemoryContext,
  getMemoryCoreDir,
  getMemoryDir,
  getMemoryMeta,
  // initializeMemoryDirectory, // TODO: unused after memory-init moved to SKILL
  loadSettings,
  renderMemoryTree,
} from "./memory-core.js";
import { gitExec, pushRepository, syncRepository } from "./memory-git.js";
import { MemoryFileSelector } from "./tape/tape-context.js";
import {
  detectKeywordHandoff,
  type KeywordHandoffInstruction,
  resolveTapeGate,
  shouldBlockTapeHandoffCall,
  type TapeGateResult,
} from "./tape/tape-gate.js";
import { TapeService } from "./tape/tape-service.js";
import type { PendingHandoffMatch } from "./tape/tape-tools.js";
import { registerAllTapeTools } from "./tape/tape-tools.js";
import { registerAllMemoryTools } from "./tools.js";
import type { HookAction, MemoryMdSettings } from "./types.js";
import { getTapeBasePath } from "./utils.js";

type CachedContext = { content: string; fileCount: number };

type ExtensionState = {
  tapeToolsRegistered: boolean;
  sessionStartHookPromise: ReturnType<typeof runHookTrigger> | null;
  contextWarmupPromise: Promise<void> | null;
  initialMemoryContext: CachedContext | null;
  initialTapeContext: CachedContext | null;
  hasDeliveredInitialContext: boolean;
  pendingHandoffMatch: PendingHandoffMatch | null;
  tapeGate: TapeGateResult | null;
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
    contextWarmupPromise: null,
    initialMemoryContext: null,
    initialTapeContext: null,
    hasDeliveredInitialContext: false,
    pendingHandoffMatch: null,
    tapeGate: null,
    activeTapeRuntime: null,
  };
}

function ensureTapeRuntime(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  options: { recordSessionStart: boolean; sessionStartReason?: "startup" | "reload" | "new" | "resume" | "fork" },
): void {
  const tapeGate = resolveTapeGate(ctx.cwd, settings.tape);
  state.tapeGate = tapeGate;

  if (!tapeGate.enabled || !settings.localPath || !tapeGate.project) {
    state.activeTapeRuntime = null;
    return;
  }

  const memoryDir = getMemoryDir(settings, ctx.cwd);
  const project = tapeGate.project;

  const sessionId = ctx.sessionManager.getSessionId();
  const tapeBasePath = getTapeBasePath(settings.localPath, settings.tape?.tapePath);
  const runtimeKey = [tapeBasePath, project.name, sessionId].join("::");

  if (!state.activeTapeRuntime || state.activeTapeRuntime.cacheKey !== runtimeKey) {
    state.activeTapeRuntime?.service.detachSessionTree();
    const service = TapeService.create(tapeBasePath, project.name, sessionId, ctx.cwd);
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

function notifyHookResults(
  ctx: ExtensionContext,
  settings: MemoryMdSettings,
  phase: "sessionStart" | "sessionEnd",
  results: Awaited<ReturnType<typeof runHookTrigger>>,
): void {
  if (!settings.repoUrl) return;

  const label = phase === "sessionStart" ? "start" : "end";
  for (const { action, result } of results) {
    if (result.success && !result.updated) continue;
    ctx.ui.notify(`${result.message} (${label}/${action})`, result.level ?? (result.success ? "info" : "error"));
  }
}

function runHookTriggerWithNotify(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
  phase: "sessionStart" | "sessionEnd",
): ReturnType<typeof runHookTrigger> {
  return runHookTrigger(settings, phase, (action) => runHookAction(pi, settings, action)).then((results) => {
    notifyHookResults(ctx, settings, phase, results);
    return results;
  });
}

async function cacheInitialContext(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
): Promise<void> {
  const baseMemoryContext = settings.enabled ? await buildMemoryContextAsync(settings, ctx.cwd) : null;
  state.initialMemoryContext = baseMemoryContext
    ? {
        content: formatMemoryContext(baseMemoryContext),
        fileCount: countMemoryContextFiles(baseMemoryContext),
      }
    : null;

  const tapeRuntime = state.tapeGate?.enabled === true ? state.activeTapeRuntime : null;
  if (!tapeRuntime) {
    state.initialTapeContext = null;
    return;
  }

  const { fileLimit = 10, strategy = "smart", memoryScan = DEFAULT_MEMORY_SCAN } = settings.tape?.context ?? {};
  const memoryFiles = await tapeRuntime.selector.selectFilesForContext(strategy, fileLimit, { memoryScan });
  const selectedFiles = await tapeRuntime.selector.finalizeContextFiles(memoryFiles);

  const content = await tapeRuntime.selector.buildContextFromFilesAsync(selectedFiles, {
    highlightedFiles: [...new Set(memoryFiles.filter((filePath) => selectedFiles.includes(filePath)))].slice(0, 3),
    handoffMode: settings.tape?.anchor?.mode ?? "auto",
  });

  state.initialTapeContext = {
    content,
    fileCount: selectedFiles.length,
  };
}

function scheduleContextWarmup(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  waitFor?: Promise<unknown> | null,
): void {
  const warmup = (async () => {
    if (waitFor) {
      await waitFor;
    }
    await waitForNextTick();
    await cacheInitialContext(settings, state, ctx);
  })();

  const trackedWarmup = warmup.finally(() => {
    if (state.contextWarmupPromise === trackedWarmup) {
      state.contextWarmupPromise = null;
    }
  });
  state.contextWarmupPromise = trackedWarmup;
}

function initDeliveryContent(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  options: { runSessionStartHooks: boolean },
): boolean {
  if (!settings.enabled) return false;

  const memoryDir = getMemoryDir(settings, ctx.cwd);
  const memoryExists = fs.existsSync(getMemoryCoreDir(memoryDir));

  state.hasDeliveredInitialContext = false;
  state.initialMemoryContext = null;
  state.initialTapeContext = null;

  if (!memoryExists && !settings.tape?.enabled) {
    return false;
  }

  if (options.runSessionStartHooks && settings.localPath && getHookActions(settings, "sessionStart").length > 0) {
    state.sessionStartHookPromise = runHookTriggerWithNotify(pi, settings, ctx, "sessionStart");
  } else {
    state.sessionStartHookPromise = null;
  }

  scheduleContextWarmup(settings, state, ctx, state.sessionStartHookPromise);
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

async function prepareBeforeAgentStart(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
): Promise<void> {
  ensureTapeRuntime(settings, state, ctx, { recordSessionStart: false });

  const needsContextInit = !state.initialMemoryContext && !state.initialTapeContext && !state.contextWarmupPromise;
  if (needsContextInit) {
    const initialized = initDeliveryContent(pi, settings, state, ctx, { runSessionStartHooks: false });
    if (!initialized && !state.contextWarmupPromise) {
      state.contextWarmupPromise = Promise.resolve();
    }
  }

  if (state.contextWarmupPromise) await state.contextWarmupPromise;

  if (state.sessionStartHookPromise) {
    await state.sessionStartHookPromise;
    state.sessionStartHookPromise = null;
  }
}

function handleTapeBeforeAgentStart(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  event: BeforeAgentStartEvent,
): { tapeEnabled: boolean; tapeActive: boolean } {
  const tapeEnabled = settings.tape?.enabled === true;
  const tapeActive = state.tapeGate?.enabled === true && state.activeTapeRuntime !== null;
  const keywordHandoff = tapeActive ? detectKeywordHandoff(event.prompt, settings.tape?.anchor?.keywords) : null;

  if (state.pendingHandoffMatch?.trigger !== "manual") {
    state.pendingHandoffMatch = keywordHandoff ? { trigger: "keyword", instruction: keywordHandoff } : null;
  }

  if (keywordHandoff) {
    ctx.ui.notify(`Tape keyword detected: ${keywordHandoff.primary}`, "info");
  }

  queueKeywordHandoffMessage(pi, keywordHandoff);
  return { tapeEnabled, tapeActive };
}

function deliverStartupContext(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  event: BeforeAgentStartEvent,
  tapeState: { tapeEnabled: boolean; tapeActive: boolean },
): BeforeAgentStartEventResult | undefined {
  const mode = settings.delivery ?? settings.injection ?? "message-append";
  const shouldDeliverInitialContext = mode === "system-prompt" || !state.hasDeliveredInitialContext;

  if (tapeState.tapeActive && state.initialTapeContext && shouldDeliverInitialContext) {
    const { content, fileCount } = state.initialTapeContext;
    ctx.ui.notify(`Tape mode: ${fileCount} memory files delivered (${mode})`, "info");

    if (mode === "system-prompt") {
      return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
    }

    state.hasDeliveredInitialContext = true;
    return { message: { customType: "pi-memory-md-tape", content, display: false } };
  }

  if (tapeState.tapeEnabled && !tapeState.tapeActive) return undefined;

  if (state.initialMemoryContext && shouldDeliverInitialContext) {
    const { content, fileCount } = state.initialMemoryContext;
    ctx.ui.notify(`Memory delivered: ${fileCount} files (${mode})`, "info");

    if (mode === "message-append") {
      state.hasDeliveredInitialContext = true;
      return { message: { customType: "pi-memory-md", content, display: false } };
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  }

  return undefined;
}

function registerLifecycleHandlers(pi: ExtensionAPI, settings: MemoryMdSettings, state: ExtensionState): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "tape_handoff") return;

    const reason = shouldBlockTapeHandoffCall(settings, state, event.input.name);
    if (!reason) return;

    return { block: true, reason };
  });

  pi.on("session_start", async (event, ctx) => {
    ensureTapeRuntime(settings, state, ctx, { recordSessionStart: true, sessionStartReason: event.reason });

    if (!state.tapeToolsRegistered) {
      registerAllTapeTools(
        pi,
        () => state.activeTapeRuntime?.service ?? null,
        () => settings,
        () => {
          const handoffMatch = state.pendingHandoffMatch;
          state.pendingHandoffMatch = null;
          return handoffMatch;
        },
      );
      state.tapeToolsRegistered = true;
    }

    if (event.previousSessionFile && (event.reason === "new" || event.reason === "fork")) {
      state.sessionStartHookPromise = null;
      initDeliveryContent(pi, settings, state, ctx, { runSessionStartHooks: false });
      return;
    }

    initDeliveryContent(pi, settings, state, ctx, { runSessionStartHooks: true });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await prepareBeforeAgentStart(pi, settings, state, ctx);
    const tapeState = handleTapeBeforeAgentStart(pi, settings, state, ctx, event);
    return deliverStartupContext(settings, state, ctx, event, tapeState);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeTapeRuntime = state.activeTapeRuntime;
    state.activeTapeRuntime = null;
    activeTapeRuntime?.service.detachSessionTree();

    if (getHookActions(settings, "sessionEnd").length === 0 || !settings.localPath) {
      return;
    }

    const memoryDir = getMemoryDir(settings, ctx.cwd);

    if (!fs.existsSync(getMemoryCoreDir(memoryDir))) {
      return;
    }

    await runHookTriggerWithNotify(pi, settings, ctx, "sessionEnd");
  });
}

function buildManualAnchorMessage(prompt: string): string {
  return [
    "The user explicitly requested a manual tape anchor via /memory-anchor.",
    "",
    "Before continuing, call tape_handoff with:",
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
  // memory-init moved to SKILL
  // pi.registerCommand("memory-init", {
  //   description: "Initialize memory repository",
  //   handler: async (_args, ctx) => {
  //     const memoryDir = getMemoryDir(settings, ctx.cwd);
  //     const alreadyInitialized = isMemoryInitialized(memoryDir);
  //     const result = await syncRepository(pi, settings);

  //     if (!result.success) {
  //       ctx.ui.notify(`Initialization failed: ${result.message}`, "error");
  //       return;
  //     }

  //     initializeMemoryDirectory(memoryDir);

  //     if (alreadyInitialized) {
  //       ctx.ui.notify(`Memory already exists: ${result.message}`, "info");
  //       return;
  //     }

  //     ctx.ui.notify(
  //       `Memory initialized: ${result.message}\n\nCreated:\n  - core/user\n  - core/project\n  - reference`,
  //       "info",
  //     );
  //   },
  // });

  pi.registerCommand("memory-refresh", {
    description: "Refresh memory context from files",
    handler: async (_args, ctx) => {
      await cacheInitialContext(settings, state, ctx);

      if (!state.initialMemoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      state.hasDeliveredInitialContext = false;

      const mode = settings.delivery ?? settings.injection ?? "message-append";

      const { content, fileCount } = state.initialMemoryContext;

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
          content,
          display: false,
        });
        ctx.ui.notify(`Memory refreshed: ${fileCount} files delivered (${mode})`, "info");
        return;
      }

      ctx.ui.notify(`Memory cache refreshed: ${fileCount} files (will be delivered on next prompt)`, "info");
    },
  });

  pi.registerCommand("memory-check", {
    description: "Check memory repository status and folder structure",
    handler: async (args, ctx) => {
      const info = await getMemoryMeta(settings, ctx.cwd);

      if (!info.initialized) {
        ctx.ui.notify(
          `Memory: ${info.name} | Repo: Not initialized | Use /memory-init to set up | Path: ${info.memoryPath}`,
          "info",
        );
        return;
      }

      const statusResult = settings.localPath
        ? await gitExec(pi, settings.localPath, ["status", "--porcelain"])
        : { stdout: "", success: false };
      const isDirty = statusResult.stdout.trim().length > 0;
      const repoStatus = settings.localPath ? (isDirty ? "Uncommitted changes" : "Clean") : "Not configured";
      ctx.ui.notify(
        `Memory: ${info.name} | Repo: ${repoStatus} | Files: ${info.project.fileCount ?? 0} | Path: ${info.memoryPath}`,
        isDirty ? "warning" : "info",
      );

      const requestedTreeOutputLines = Number.parseInt(args.trim(), 10);
      const maxTreeOutputLines =
        Number.isFinite(requestedTreeOutputLines) && requestedTreeOutputLines > 0 ? requestedTreeOutputLines : 25;
      ctx.ui.notify(renderMemoryTree(info.memoryPath, maxTreeOutputLines), "info");
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

        state.pendingHandoffMatch = { trigger: "manual" };

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
