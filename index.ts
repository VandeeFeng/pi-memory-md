import fs from "node:fs";
import { setImmediate as waitForNextTick } from "node:timers/promises";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getHookActions, getSessionStartCause, runHookTrigger } from "./hooks.js";
import {
  buildMemoryContextAsync,
  countMemoryContextFiles,
  DEFAULT_MEMORY_SCAN,
  formatMemoryContext,
  getMemoryCoreDir,
  getMemoryDir,
  getMemoryMeta,
  // initializeMemoryDirectory, // unused after memory-init moved to SKILL
  loadSettings,
  renderMemoryTree,
  writeSessionStateFile,
} from "./memory-core.js";

import { gitExec, pushRepository, syncRepository } from "./memory-git.js";
import { extractMessageContent, MemoryFileSelector } from "./tape/tape-context.js";
import {
  detectKeywordHandoff,
  type KeywordHandoffInstruction,
  type PreparedSessionBridge,
  prepareSessionBridge,
  renderSessionBridge,
  resolveTapeGate,
  shouldBlockTapeHandoffCall,
  type TapeGateResult,
} from "./tape/tape-gate.js";
import { DEFAULT_MEMORY_REVIEW_LIMIT, normalizeMemoryReviewLimit, openMemoryReview } from "./tape/tape-review.js";
import { TapeService } from "./tape/tape-service.js";
import { registerAllTapeThreadTools } from "./tape/tape-thread-tools.js";
import type { PendingHandoffMatch } from "./tape/tape-tools.js";
import { registerAllTapeTools } from "./tape/tape-tools.js";
import { registerAllMemoryTools } from "./tools.js";
import type { HookAction, MemoryMdSettings } from "./types.js";
import { getTapeBasePath } from "./utils.js";

// Shared extension state cached across pi lifecycle events.
type CachedContext = { content: string; fileCount: number };
type InitialContextState = { status: "pending" } | { status: "empty" } | { status: "ready"; value: CachedContext };

type ExtensionState = {
  tapeToolsRegistered: boolean;
  sessionStartHookPromise: ReturnType<typeof runHookTrigger> | null;
  contextWarmupPromise: Promise<void> | null;
  initialMemoryContext: InitialContextState;
  initialTapeContext: InitialContextState;
  hasDeliveredInitialContext: boolean;
  pendingHandoffMatch: PendingHandoffMatch | null;
  pendingThreadTrigger: "manual" | null;
  tapeGate: TapeGateResult | null;
  activeTapeRuntime: {
    service: TapeService;
    selector: MemoryFileSelector;
    cacheKey: string;
  } | null;
  sessionBridge: {
    previousSessionFile?: string;
    delivered: boolean;
    warmupPromise?: Promise<PreparedSessionBridge | null>;
  };
};

function createExtensionState(): ExtensionState {
  return {
    tapeToolsRegistered: false,
    sessionStartHookPromise: null,
    contextWarmupPromise: null,
    initialMemoryContext: { status: "pending" },
    initialTapeContext: { status: "pending" },
    hasDeliveredInitialContext: false,
    pendingHandoffMatch: null,
    pendingThreadTrigger: null,
    tapeGate: null,
    activeTapeRuntime: null,
    sessionBridge: { delivered: false },
  };
}

// Tape runtime setup and reuse for the current project/session.
function getReadyContext(context: InitialContextState): CachedContext | undefined {
  return context.status === "ready" ? context.value : undefined;
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

// Context warmup and delivery for memory, tape, and session bridge.
async function cacheInitialContext(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
): Promise<void> {
  const baseMemoryContext = settings.enabled ? await buildMemoryContextAsync(settings, ctx.cwd) : null;
  state.initialMemoryContext = baseMemoryContext
    ? {
        status: "ready",
        value: {
          content: formatMemoryContext(baseMemoryContext),
          fileCount: countMemoryContextFiles(baseMemoryContext),
        },
      }
    : { status: "empty" };

  const tapeRuntime = state.tapeGate?.enabled === true ? state.activeTapeRuntime : null;
  if (!tapeRuntime) {
    state.initialTapeContext = { status: "empty" };
    return;
  }

  const { fileLimit = 10, strategy = "smart", memoryScan = DEFAULT_MEMORY_SCAN } = settings.tape?.context ?? {};
  const memoryFiles = await tapeRuntime.selector.selectFilesForContext(strategy, fileLimit, { memoryScan });
  const selectedFiles = await tapeRuntime.selector.finalizeContextFiles(memoryFiles);

  if (selectedFiles.length === 0) {
    state.initialTapeContext = { status: "empty" };
    return;
  }

  const content = await tapeRuntime.selector.buildContextFromFilesAsync(selectedFiles, {
    highlightedFiles: [...new Set(memoryFiles.filter((filePath) => selectedFiles.includes(filePath)))].slice(0, 3),
    handoffMode: settings.tape?.anchor?.mode ?? "auto",
  });

  state.initialTapeContext = content?.trim()
    ? { status: "ready", value: { content, fileCount: selectedFiles.length } }
    : { status: "empty" };
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
  state.initialMemoryContext = { status: "pending" };
  state.initialTapeContext = { status: "pending" };

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

  const needsContextInit =
    state.initialMemoryContext.status === "pending" &&
    state.initialTapeContext.status === "pending" &&
    !state.contextWarmupPromise;
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

  if (state.pendingThreadTrigger === "manual" && !event.prompt.includes("/memory-thread")) {
    state.pendingThreadTrigger = null;
  }

  if (keywordHandoff) {
    ctx.ui.notify(`Tape keyword detected: ${keywordHandoff.primary}`, "info");
  }

  queueKeywordHandoffMessage(pi, keywordHandoff);
  return { tapeEnabled, tapeActive };
}

function appendSessionBridge(content: string, sessionBridgeContext: string | null): string {
  return sessionBridgeContext ? `${content}\n\n${sessionBridgeContext}` : content;
}

function queueSessionBridgeMessage(pi: ExtensionAPI, sessionBridgeContext: string | null): void {
  if (!sessionBridgeContext) return;

  pi.sendMessage(
    { customType: "pi-memory-md-session-bridge", content: sessionBridgeContext, display: false },
    { triggerTurn: false },
  );
}

function scheduleSessionBridgeWarmup(settings: MemoryMdSettings, state: ExtensionState): void {
  if (!getHookActions(settings, "beforeAgentStart").includes("sessionBridge")) return;
  if (!state.sessionBridge.previousSessionFile) return;

  state.sessionBridge.warmupPromise = prepareSessionBridge({
    previousSessionFile: state.sessionBridge.previousSessionFile,
    anchorStore: state.activeTapeRuntime?.service.getAnchorStore(),
  }).catch(() => null);
}

async function maybeBuildSessionBridgeContext(
  settings: MemoryMdSettings,
  state: ExtensionState,
  event: BeforeAgentStartEvent,
): Promise<string | null> {
  if (state.sessionBridge.delivered) return null;
  state.sessionBridge.delivered = true;

  if (!getHookActions(settings, "beforeAgentStart").includes("sessionBridge")) return null;

  return renderSessionBridge({
    prepared: (await state.sessionBridge.warmupPromise) ?? null,
    prompt: event.prompt,
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATE_CAPTURE_TOOL_NAMES = new Set(["edit", "write"]);
const STATE_CAPTURE_PROMPT_MAX_CHARS = 600;

/**
 * Deterministic snapshot of what this session changed: no model call, so enabling
 * it cannot slow a compaction down or spend tokens.
 */
function collectSessionState(ctx: ExtensionContext): {
  filesTouched: string[];
  lastPrompt: string;
  compactionCount: number;
} {
  const entries = (ctx.sessionManager.getEntries?.() ?? []) as Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;
  const filesTouched = new Set<string>();
  let lastPrompt = "";
  let compactionCount = 0;

  for (const entry of entries) {
    if (entry.type === "compaction") compactionCount += 1;

    const content = entry.message?.content;
    if (!content) continue;

    if (entry.message?.role === "user") {
      const text = extractMessageContent(content).trim();
      if (text) lastPrompt = text.slice(0, STATE_CAPTURE_PROMPT_MAX_CHARS);
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const part of content) {
      const toolCall = part as { type?: string; name?: string; arguments?: Record<string, unknown> };
      if (toolCall.type !== "toolCall" || !toolCall.name || !STATE_CAPTURE_TOOL_NAMES.has(toolCall.name)) continue;
      const args = toolCall.arguments ?? {};
      const filePath = args.path ?? args.file_path ?? args.filePath;
      if (typeof filePath === "string" && filePath.trim()) filesTouched.add(filePath.trim());
    }
  }

  return { filesTouched: [...filesTouched].sort(), lastPrompt, compactionCount };
}

/**
 * `ctx.ui` belongs to the session that created it: a session replacement leaves a
 * stale context whose notify throws. Only that case is swallowed.
 */
function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch (error) {
    if (!describeError(error).includes("extension ctx is stale")) throw error;
  }
}

function deliverStartupContext(
  settings: MemoryMdSettings,
  state: ExtensionState,
  ctx: ExtensionContext,
  event: BeforeAgentStartEvent,
  tapeState: { tapeEnabled: boolean; tapeActive: boolean },
  sessionBridgeContext: string | null,
): BeforeAgentStartEventResult | undefined {
  const mode = settings.delivery ?? settings.injection ?? "message-append";
  const shouldDeliverInitialContext = mode === "system-prompt" || !state.hasDeliveredInitialContext;

  if (tapeState.tapeActive && shouldDeliverInitialContext) {
    const tapeContext = getReadyContext(state.initialTapeContext);
    if (!tapeContext || tapeContext.content.trim().length === 0) {
      if (mode === "message-append") {
        state.hasDeliveredInitialContext = true;
      }
      return undefined;
    }

    const { content, fileCount } = tapeContext;
    ctx.ui.notify(`Tape mode: ${fileCount} memory files delivered (${mode})`, "info");

    if (mode === "system-prompt") {
      return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
    }

    state.hasDeliveredInitialContext = true;
    return {
      message: {
        customType: "pi-memory-md-tape",
        content: appendSessionBridge(content, sessionBridgeContext),
        display: false,
      },
    };
  }

  if (tapeState.tapeEnabled && !tapeState.tapeActive) return undefined;

  const memoryContext = getReadyContext(state.initialMemoryContext);
  if (memoryContext && shouldDeliverInitialContext) {
    const { content, fileCount } = memoryContext;
    ctx.ui.notify(`Memory delivered: ${fileCount} files (${mode})`, "info");

    if (mode === "message-append") {
      state.hasDeliveredInitialContext = true;
      return {
        message: {
          customType: "pi-memory-md",
          content: appendSessionBridge(content, sessionBridgeContext),
          display: false,
        },
      };
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  }

  if (sessionBridgeContext && shouldDeliverInitialContext && mode === "message-append") {
    state.hasDeliveredInitialContext = true;
    return { message: { customType: "pi-memory-md-session-bridge", content: sessionBridgeContext, display: false } };
  }

  return undefined;
}

// Pi lifecycle handlers and hook execution.
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

    try {
      ctx.ui.notify(`${result.message} (${label}/${action})`, result.level ?? (result.success ? "info" : "error"));
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("extension ctx is stale"))) throw error;
    }
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

function registerLifecycleHandlers(pi: ExtensionAPI, settings: MemoryMdSettings, state: ExtensionState): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "tape_handoff") return;

    const reason = shouldBlockTapeHandoffCall(settings, state, event.input.name);
    if (!reason) return;

    return { block: true, reason };
  });

  pi.on("session_start", async (event, ctx) => {
    state.hasDeliveredInitialContext = false;
    state.sessionBridge = {
      previousSessionFile: ["new", "resume", "fork"].includes(event.reason) ? event.previousSessionFile : undefined,
      delivered: false,
    };

    ensureTapeRuntime(settings, state, ctx, { recordSessionStart: true, sessionStartReason: event.reason });
    scheduleSessionBridgeWarmup(settings, state);

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
      if (settings.tape?.enabled === true && settings.tape.thread !== false) {
        registerAllTapeThreadTools(
          pi,
          () => state.activeTapeRuntime?.service ?? null,
          () => settings,
          () => state.pendingThreadTrigger,
        );
      }
      state.tapeToolsRegistered = true;
    }

    initDeliveryContent(pi, settings, state, ctx, {
      runSessionStartHooks: getSessionStartCause(event.reason) === "runtimeStart",
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await prepareBeforeAgentStart(pi, settings, state, ctx);
    const tapeState = handleTapeBeforeAgentStart(pi, settings, state, ctx, event);
    const sessionBridgeContext = await maybeBuildSessionBridgeContext(settings, state, event);
    if ((settings.delivery ?? settings.injection ?? "message-append") === "system-prompt") {
      queueSessionBridgeMessage(pi, sessionBridgeContext);
    }
    return deliverStartupContext(settings, state, ctx, event, tapeState, sessionBridgeContext);
  });

  // Compaction is the last moment before the transcript is summarized, so it is the
  // last moment a deterministic snapshot of the session can be persisted. Opt-in:
  // it writes a file on the user's behalf.
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!settings.enabled || settings.stateCapture !== true) return;

    const memoryDir = getMemoryDir(settings, ctx.cwd);
    if (!fs.existsSync(getMemoryCoreDir(memoryDir))) return;

    try {
      const state = collectSessionState(ctx);
      writeSessionStateFile(memoryDir, { ...state, cwd: ctx.cwd });
      safeNotify(ctx, "Session state captured to core/state.md before compaction", "info");
    } catch (error) {
      safeNotify(ctx, `Session state capture failed: ${describeError(error)}`, "warning");
    }
  });

  // Compaction summarizes the transcript, and the index sits at the front of it as a
  // custom message, so a long session can lose the whole memory index mid-flight
  // (pi chooses custom messages as a cut point). Re-inject it after every successful
  // compaction. system-prompt delivery already re-appends it on each agent start.
  pi.on("session_compact", async (_event, ctx) => {
    if (!settings.enabled) return;
    if ((settings.delivery ?? settings.injection ?? "message-append") !== "message-append") return;

    try {
      await cacheInitialContext(settings, state, ctx);
    } catch (error) {
      safeNotify(ctx, `Memory index refresh failed after compaction: ${describeError(error)}`, "warning");
      return;
    }

    const memoryContext = getReadyContext(state.initialMemoryContext);
    if (!memoryContext) return;

    state.hasDeliveredInitialContext = true;
    pi.sendMessage(
      {
        customType: "pi-memory-md-compact-refresh",
        content: memoryContext.content,
        display: false,
      },
      { triggerTurn: false },
    );
    safeNotify(ctx, `Memory index re-injected after compaction (${memoryContext.fileCount} files)`, "info");
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

// User-facing slash commands for memory and tape operations.
function buildMemoryThreadMessage(prompt: string): string {
  return [
    "The user explicitly requested TapeThread management via /memory-thread.",
    "",
    "Interpret the user's prompt naturally and use the tape_thread tool when the action is clear.",
    "Available actions include create, root, branch, node, checkout, status, search, update, resume, and archive.",
    "Thread and branch creation do not create anchors; root and node actions create anchor-backed nodes.",
    "If checkout target is described by name rather than node id, search first and then checkout the matching node.",
    "If the prompt is only an intent/topic without a clear management action, ask whether to create a related thread and do not call tools yet.",
    "",
    `User prompt: ${prompt}`,
  ].join("\n");
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

      const memoryContext = getReadyContext(state.initialMemoryContext);
      if (!memoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      const mode = settings.delivery ?? settings.injection ?? "message-append";

      const { content, fileCount } = memoryContext;

      if (mode === "message-append") {
        // The message is delivered right here, so the "already delivered" flag must
        // stay true; leaving it false made the next before_agent_start inject a
        // second copy of the index.
        state.hasDeliveredInitialContext = true;
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

      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const requestedTreeLines = tokens
        .map((token) => Number.parseInt(token, 10))
        .find((value) => Number.isFinite(value));
      const maxTreeLines = requestedTreeLines && requestedTreeLines > 0 ? requestedTreeLines : 25;
      const scope = tokens.some((token) => token === "-g" || token === "--global" || token === "global")
        ? "global"
        : "project";
      const memoryScope = scope === "global" ? info.global : info.project;

      if (!memoryScope.dir || !memoryScope.exists) {
        ctx.ui.notify(`Memory ${scope} directory is not configured or does not exist.`, "warning");
        return;
      }

      ctx.ui.notify(renderMemoryTree(memoryScope.dir, maxTreeLines), "info");
    },
  });

  if (settings.tape?.enabled) {
    pi.registerCommand("memory-review", {
      description: "Open Memory Review overlay for anchor timeline, relations, and stats",
      handler: async (args, ctx) => {
        ensureTapeRuntime(settings, state, ctx, { recordSessionStart: false });
        const tapeService = state.activeTapeRuntime?.service;
        if (!tapeService) {
          ctx.ui.notify("Tape runtime is unavailable.", "error");
          return;
        }

        const requestedLimit = Number.parseInt(args.trim(), 10);
        const limit = normalizeMemoryReviewLimit(
          Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_MEMORY_REVIEW_LIMIT,
        );
        await openMemoryReview(tapeService, ctx, { limit });
      },
    });

    if (settings.tape.thread !== false) {
      pi.registerCommand("memory-thread", {
        description: "Manage TapeThread intent lines with natural language",
        handler: async (args, ctx) => {
          const prompt = args.trim();
          if (!prompt) {
            ctx.ui.notify("Usage: /memory-thread <prompt>", "warning");
            return;
          }

          ensureTapeRuntime(settings, state, ctx, { recordSessionStart: false });
          const tapeService = state.activeTapeRuntime?.service;
          if (!tapeService) {
            ctx.ui.notify("Tape runtime is unavailable.", "error");
            return;
          }

          state.pendingThreadTrigger = "manual";

          pi.sendMessage(
            {
              customType: "pi-memory-md-thread",
              content: buildMemoryThreadMessage(prompt),
              display: false,
            },
            { triggerTurn: true },
          );
        },
      });
    }

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

// Registers memory tools, lifecycle handlers, and commands.
export default function memoryMdExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const state = createExtensionState();

  registerLifecycleHandlers(pi, settings, state);
  registerAllMemoryTools(pi, settings);
  registerMemoryCommands(pi, settings, state);
}
