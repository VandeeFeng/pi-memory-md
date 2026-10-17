// Covers delivery-mode switching, tape/non-tape exclusivity, keyword handoff queuing, and reload behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import memoryMdExtension from "../index.js";
import { writeMemoryFile } from "../memory-core.js";
import { MemoryFileSelector } from "../tape/tape-context.js";
import { createSessionManager, createTempDir, createUi, initGitRepo, writeJson } from "./test-helpers.js";

type HandlerMap = Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>;

type ExtensionHarness = {
  handlers: HandlerMap;
  sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
  registeredCommands: string[];
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  userMessages: string[];
  messageRenderers: Map<string, any>;
};

function bootExtension(homeDir: string, projectDir: string): ExtensionHarness {
  const handlers: HandlerMap = new Map();
  const sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const registeredCommands: string[] = [];
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const userMessages: string[] = [];
  const messageRenderers = new Map<string, any>();
  const homedirMock = mock.method(os, "homedir", () => homeDir);
  const previousCwd = process.cwd();

  try {
    process.chdir(projectDir);
    memoryMdExtension({
      on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        registeredCommands.push(name);
        commands.set(name, command.handler);
      },
      registerMessageRenderer(name: string, renderer: any) {
        messageRenderers.set(name, renderer);
      },
      sendUserMessage(prompt: string) {
        userMessages.push(prompt);
      },
      sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
        sentMessages.push({ message, options });
      },
    } as never);
  } finally {
    process.chdir(previousCwd);
    homedirMock.mock.restore();
  }

  return { handlers, sentMessages, registeredCommands, commands, userMessages, messageRenderers };
}

function createProjectMemory(projectDir: string, localPath: string): string {
  const memoryDir = path.join(localPath, path.basename(projectDir));
  writeMemoryFile(
    path.join(memoryDir, "core", "user", "identity.md"),
    "# Identity\nSynthetic identity fixture for recall tests.",
    {
      description: "Identity",
      tags: ["user"],
    },
  );
  return memoryDir;
}

function setupManualInject(settings: Record<string, unknown> = {}, entries: SessionEntry[] = []) {
  const homeDir = createTempDir("pi-memory-inject-home");
  const projectDir = createTempDir("pi-memory-inject-project");
  initGitRepo(projectDir);
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);
  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": { localPath, enabled: false, tape: { enabled: false }, ...settings },
  });
  const extension = bootExtension(homeDir, projectDir);
  const context = {
    cwd: projectDir,
    ui: createUi(),
    sessionManager: { ...createSessionManager(entries), getBranch: () => entries },
    async waitForIdle() {},
  };
  const inject = extension.commands.get("memory-inject");
  assert.ok(inject);
  return { extension, context, inject, localPath };
}

for (const delivery of ["message-append", "system-prompt"] as const) {
  test(`memory-inject separates expandable context from the task without duplicate ${delivery} delivery`, async () => {
    const { extension, context, inject } = setupManualInject({ enabled: true, delivery });
    await inject("remember identity", context);
    assert.equal(extension.userMessages.length, 1);
    const prompt = extension.userMessages[0];
    assert.equal(prompt, "remember identity");
    assert.equal(extension.sentMessages.length, 1);
    const injected = extension.sentMessages[0];
    assert.equal(injected.message.customType, "pi-memory-md-inject");
    assert.equal(injected.message.display, true);
    assert.deepEqual(injected.options, { deliverAs: "nextTurn", triggerTurn: false });
    assert.match(injected.message.content as string, /identity.md/);
    const result = await extension.handlers.get("before_agent_start")?.({ prompt, systemPrompt: "SYSTEM" }, context);
    assert.equal(result, undefined);
    const next = await extension.handlers.get("before_agent_start")?.(
      { prompt: "next task", systemPrompt: "SYSTEM" },
      context,
    );
    if (delivery === "message-append") assert.equal(next, undefined);
    else assert.match((next as any).systemPrompt, /identity.md/);
  });
}

test("manual recall bypasses smart warmup and includes workspace evidence in expandable context", async (contextTest) => {
  const { extension, context, inject } = setupManualInject({ enabled: true, tape: { enabled: true } });
  fs.writeFileSync(path.join(context.cwd, "identity.ts"), "export const identity = 'workspace identity';\n");
  const smartSelection = contextTest.mock.method(MemoryFileSelector.prototype, "selectFilesForContext", async () => {
    assert.fail("manual recall must not start smart warmup");
  });
  await inject("identity", context);
  assert.equal(extension.userMessages.length, 1);
  assert.equal(extension.userMessages[0], "identity");
  assert.equal(extension.sentMessages.length, 1);
  assert.match(extension.sentMessages[0].message.content as string, /workspace identity/);
  assert.match(extension.sentMessages[0].message.content as string, /identity.md/);
  await extension.handlers.get("before_agent_start")?.(
    { prompt: extension.userMessages[0], systemPrompt: "SYSTEM" },
    context,
  );
  assert.equal(smartSelection.mock.callCount(), 0);
  smartSelection.mock.restore();
  const next = await extension.handlers.get("before_agent_start")?.(
    { prompt: "next task", systemPrompt: "SYSTEM" },
    context,
  );
  assert.equal(next, undefined, "lazy cache initialization must not reset manual delivery state");
});

for (const boundary of ["memory-refresh", "session_shutdown"] as const) {
  test(`${boundary} clears the manual recall corpus cache`, async (testContext) => {
    const { extension, context, inject } = setupManualInject();
    let reads = 0;
    const open = fs.promises.open.bind(fs.promises);
    testContext.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
      reads++;
      return open(...args);
    });
    await inject("identity", context);
    await inject("identity", context);
    assert.equal(reads, 1);
    if (boundary === "memory-refresh") await extension.commands.get(boundary)?.("", context);
    else await extension.handlers.get(boundary)?.({}, context);
    await inject("identity", context);
    assert.equal(reads, 2);
    assert.equal(extension.userMessages.length, 3);
  });
}

test("memory-inject without args uses branch intent with automatic injection disabled", async () => {
  const entry = {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "remember identity" }] },
  } as SessionEntry;
  const commandEntry = { ...entry, id: "user-2", message: { role: "user", content: "/memory-check" } } as SessionEntry;
  const { extension, context, inject } = setupManualInject(
    {
      tape: { enabled: true, context: { jev: { enabled: true } } },
    },
    [entry, commandEntry],
  );
  let intent = "";
  await inject("", {
    ...context,
    modelRegistry: {
      getModelOfType() {
        return {};
      },
      async classify(_model: unknown, request: any) {
        intent = request.state.intent;
        return { stopReason: "stop", answers: { file_0: { type: "score", score: 3, confidence: 1 } } };
      },
    },
  });
  assert.equal(intent, "remember identity");
  assert.equal(extension.sentMessages.length, 1);
  assert.deepEqual(extension.userMessages, []);
  const injected = extension.sentMessages[0];
  assert.equal(injected.message.display, true);
  assert.deepEqual(injected.options, { triggerTurn: false });
  const renderer = extension.messageRenderers.get("pi-memory-md-inject");
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const collapsed = renderer(injected.message, { expanded: false }, theme).render(80).join("\n");
  const expanded = renderer(injected.message, { expanded: true }, theme).render(80).join("\n");
  assert.match(collapsed, /\[memory\].*1 memory \+ 0 workspace excerpts/);
  assert.doesNotMatch(collapsed, /identity.md/);
  assert.match(expanded, /identity.md/);
});

test("repeated no-arg recall uses the user task rather than previously injected excerpts", async () => {
  const entries: SessionEntry[] = [];
  const { extension, context, inject } = setupManualInject(
    {
      tape: { enabled: false, context: { jev: { enabled: true } } },
    },
    entries,
  );
  const intents: string[] = [];
  const commandContext = {
    ...context,
    modelRegistry: {
      getModelOfType: () => ({}),
      async classify(_model: unknown, request: any) {
        intents.push(request.state.intent);
        return { stopReason: "stop", answers: { file_0: { type: "score", score: 3, confidence: 1 } } };
      },
    },
  };
  await inject("identity", commandContext);
  entries.push({ type: "message", message: { role: "user", content: extension.userMessages[0] } } as SessionEntry);
  await inject("", commandContext);
  assert.deepEqual(intents, ["identity", "identity"]);
  assert.equal(extension.userMessages.length, 1);
  assert.equal(extension.sentMessages.length, 2);
});

test("memory-inject missing intent, empty memory and tape gates do not start tasks", async () => {
  const missing = setupManualInject();
  await missing.inject("", missing.context);
  assert.equal(missing.extension.sentMessages.length, 0);
  assert.match(missing.context.ui.notifications.at(-1)?.message ?? "", /Usage:/);
  fs.rmSync(missing.localPath, { recursive: true });
  await missing.inject("task", missing.context);
  assert.equal(missing.extension.sentMessages.length, 0);
  assert.deepEqual(missing.extension.userMessages, []);
  const blocked = setupManualInject({ tape: { enabled: true, onlyGit: true, excludeDirs: ["/tmp"] } });
  await blocked.inject("task", blocked.context);
  assert.equal(blocked.extension.sentMessages.length, 0);
  assert.deepEqual(blocked.extension.userMessages, []);
  const cancelled = setupManualInject();
  await cancelled.inject("task", { ...cancelled.context, signal: AbortSignal.abort() });
  assert.equal(cancelled.extension.sentMessages.length, 0);
  assert.deepEqual(cancelled.extension.userMessages, []);
});

test("memory-inject prevents overlapping commands and discards stale branch results", async () => {
  const { extension, context, inject } = setupManualInject();
  let resume: () => void = () => {};
  context.waitForIdle = () =>
    new Promise<void>((resolve) => {
      resume = resolve;
    });
  const first = inject("identity first", context);
  await inject("second", context);
  assert.match(context.ui.notifications.at(-1)?.message ?? "", /already running/);
  resume();
  await first;
  assert.equal(extension.userMessages.length, 1);
  assert.equal(extension.userMessages[0], "identity first");
  const firstPrompt = extension.userMessages[0];
  context.waitForIdle = async () => {};
  let reads = 0;
  context.sessionManager.getLeafId = () => (++reads === 1 ? "original" : "changed");
  await inject("identity stale", context);
  assert.deepEqual(extension.userMessages, [firstPrompt]);
  assert.equal(extension.sentMessages.length, 1);
  assert.match(context.ui.notifications.at(-1)?.message ?? "", /Session or branch changed/);
});

for (const display of ["actual", "estimated", "tokens"] as const) {
  test(`memory-inject prefers actual billing, then pi estimates, then tokens: ${display}`, async (testContext) => {
    testContext.mock.method(globalThis, "fetch", async () =>
      Response.json({ usage: display === "actual" ? { cost: 0.001 } : {} }),
    );
    const { context, inject } = setupManualInject({
      tape: { enabled: true, context: { jev: { enabled: true, provider: "typesafe" } } },
    });
    await inject("identity", {
      ...context,
      modelRegistry: {
        getModelOfType() {
          return {};
        },
        async classify(_model: unknown, _request: unknown, options: { fetch: typeof globalThis.fetch }) {
          await options.fetch("https://api.typesafe.ai/v1/systemone");
          return {
            stopReason: "stop",
            answers: { file_0: { type: "score", score: 3, confidence: 1 } },
            usage: { input: 1234, output: 56, cost: { total: display === "tokens" ? 0 : 0.002 } },
          };
        },
      },
    });
    const notification = context.ui.notifications.find((item) => item.message.startsWith("Jev:"));
    if (display === "tokens") {
      assert.match(notification?.message ?? "", /1234 input \/ 56 output tokens/);
      assert.doesNotMatch(notification?.message ?? "", /actual cost unavailable|USD/);
    } else {
      const expected = display === "actual" ? "$0.00100000 USD (actual)" : "$0.00200000 USD (estimated)";
      assert.ok(notification?.message.includes(expected));
    }
  });
}

for (const tapeEnabled of [true, false]) {
  test(`memory-inject recalls old non-core excerpts before limiting files with tape=${tapeEnabled}`, async () => {
    const { extension, context, inject, localPath } = setupManualInject({
      tape: { enabled: tapeEnabled, context: { fileLimit: 1, jev: { enabled: true } } },
    });
    const memoryDir = path.join(localPath, path.basename(context.cwd));
    const relevantPath = path.join(memoryDir, "reference", "storage.md");
    writeMemoryFile(
      relevantPath,
      "# Storage\n\n## Encryption\nUse envelope encryption for backups.\n\n## Retention\nDelete expired backups after thirty days.",
      {
        description: "Storage decisions",
      },
    );
    fs.utimesSync(relevantPath, new Date(0), new Date(0));
    writeMemoryFile(path.join(memoryDir, "core", "backup-ui.md"), "# Backup UI\nThe backup page uses a blue button.", {
      description: "Backup UI",
    });
    const seen: string[] = [];
    const commandContext = {
      ...context,
      modelRegistry: {
        getModelOfType: () => ({}),
        async classify(_model: unknown, request: any) {
          assert.equal(request.state.intent, "How should backups be encrypted?");
          const excerpts = request.state.candidates.map((candidate: any) => candidate.excerpt);
          seen.push(...excerpts);
          return {
            stopReason: "stop",
            answers: Object.fromEntries(
              excerpts.map((text: string, index: number) => [
                `file_${index}`,
                { type: "score", score: text.includes("envelope encryption") ? 3 : 0, confidence: 1 },
              ]),
            ),
          };
        },
      },
    };
    await inject("How should backups be encrypted?", commandContext);
    assert.ok(seen.length > 1, "fileLimit must apply after semantic ranking");
    assert.ok(seen.some((text) => text.includes("envelope encryption")));
    assert.equal(extension.userMessages.length, 1);
    assert.equal(extension.userMessages[0], "How should backups be encrypted?");
    assert.equal(extension.sentMessages.length, 1);
    const message = extension.sentMessages[0].message.content as string;
    assert.match(message, /envelope encryption/);
    assert.match(message, /storage.md/);
    assert.doesNotMatch(message, /blue button|thirty days|identity.md/);
  });
}

for (const outcome of ["error", "unavailable"] as const) {
  test(`manual Jev ${outcome} never injects an unranked startup list`, async () => {
    const { extension, context, inject } = setupManualInject({
      tape: { enabled: true, context: { jev: { enabled: true } } },
    });
    await inject("identity", {
      ...context,
      modelRegistry: {
        getModelOfType: () => (outcome === "unavailable" ? undefined : {}),
        classify: async () => ({ stopReason: "error", answers: {} }),
      },
    });
    assert.deepEqual(extension.userMessages, []);
    assert.deepEqual(extension.sentMessages, []);
    assert.ok(context.ui.notifications.some((item) => /Jev.*no memory was injected/i.test(item.message)));
    const diagnostics = context.ui.notifications.filter((item) => /^(Memory|Workspace) recall:/.test(item.message));
    assert.equal(diagnostics.length, 2);
    for (const item of diagnostics) {
      assert.match(item.message, /incomplete \(recall failed\)/);
      assert.match(item.message, /injected=0/);
      assert.doesNotMatch(item.message, /no hit/);
    }
  });
}

test("memory-inject distinguishes output-budget exclusion from relevance rejection", async () => {
  const { extension, context, inject } = setupManualInject({
    tape: { enabled: false, context: { fileLimit: 0, jev: { enabled: true } } },
  });
  await inject("identity", {
    ...context,
    modelRegistry: {
      getModelOfType: () => ({}),
      classify: async () => ({
        stopReason: "stop",
        answers: { file_0: { type: "score", score: 3, confidence: 1 } },
      }),
    },
  });
  assert.deepEqual(extension.userMessages, []);
  assert.deepEqual(extension.sentMessages, []);
  const memory = context.ui.notifications.find((item) => item.message.startsWith("Memory recall:"));
  assert.match(memory?.message ?? "", /no injection \(output budget\)/);
  assert.match(memory?.message ?? "", /relevant=1, injected=0/);
  assert.match(memory?.message ?? "", /budget-excluded=1/);
});

for (const memoryState of ["absent", "unmatched", "rejected"] as const) {
  test(`memory-inject reports ${memoryState} memory even when workspace evidence is injected`, async () => {
    const semantic = memoryState !== "unmatched";
    const { extension, context, inject, localPath } = setupManualInject({
      tape: { enabled: false, context: { jev: { enabled: semantic } } },
    });
    if (memoryState === "absent") fs.rmSync(path.join(localPath, path.basename(context.cwd)), { recursive: true });
    fs.writeFileSync(path.join(context.cwd, "provider.ts"), "export const provider = 'current implementation';\n");
    await inject("provider", {
      ...context,
      modelRegistry: {
        getModelOfType: () => ({}),
        async classify(_model: unknown, request: any) {
          return {
            stopReason: "stop",
            answers: Object.fromEntries(
              request.state.candidates.map((candidate: any, index: number) => [
                `file_${index}`,
                { type: "score", score: candidate.kind === "project" ? 3 : 0, confidence: 1 },
              ]),
            ),
          };
        },
      },
    });
    assert.equal(extension.userMessages.length, 1);
    assert.equal(extension.userMessages[0], "provider");
    assert.match(extension.sentMessages[0].message.content as string, /current implementation/);
    const diagnostic = context.ui.notifications.find((item) => item.message.startsWith("Memory recall:"));
    assert.ok(diagnostic);
    const reason = { absent: "no eligible excerpts", unmatched: "no candidates", rejected: "none passed relevance" };
    assert.ok(diagnostic.message.includes(`no hit (${reason[memoryState]})`));
    assert.match(diagnostic.message, /available=.*candidates=.*evaluated=.*relevant=.*injected=/);
    assert.ok(context.ui.notifications.some((item) => item.message.startsWith("Workspace recall:")));
  });
}

test("before_agent_start uses plain memory context in message-append mode when tape is disabled", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-1");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-1");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      tape: { enabled: false },
      delivery: "message-append",
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  assert.ok(beforeAgentStart);

  const ui = createUi();
  const result = await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager() },
  );
  const secondResult = await beforeAgentStart?.(
    { prompt: "hello again", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager() },
  );

  assert.equal((result as any).message.customType, "pi-memory-md");
  assert.match((result as any).message.content, /<memory_context mode="normal">/);
  assert.equal(secondResult, undefined);
  assert.equal(extension.sentMessages.length, 0);
});

test("before_agent_start uses plain memory context in system-prompt mode when tape is disabled", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-2");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-2");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      tape: { enabled: false },
      delivery: "system-prompt",
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  const result = await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  assert.match((result as any).systemPrompt, /SYSTEM/);
  assert.match((result as any).systemPrompt, /<memory_context mode="normal">/);
  assert.equal((result as any).message, undefined);
});

for (const tapeEnabled of [true, false]) {
  test(`custom agent starts do not consume user intent or session bridges with tape=${tapeEnabled}`, async () => {
    const { extension, context } = setupManualInject({
      enabled: true,
      delivery: "system-prompt",
      hooks: { sessionStart: [], beforeAgentStart: ["sessionBridge"] },
      tape: {
        enabled: tapeEnabled,
        context: { strategy: "recent-only" },
        anchor: { mode: "manual", keywords: { global: ["tape"] } },
      },
    });
    const previousSessionFile = path.join(createTempDir("pi-custom-start-bridge"), "previous.jsonl");
    fs.writeFileSync(
      previousSessionFile,
      [
        { type: "session", id: "previous-session" },
        {
          type: "message",
          id: "user-1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Storage encryption must use envelope encryption." },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    await extension.handlers.get("session_start")?.({ reason: "new", previousSessionFile }, context);
    const beforeStart = extension.handlers.get("before_agent_start");
    assert.ok(beforeStart);
    const custom = await beforeStart(
      {
        type: "before_agent_start",
        messageType: "custom",
        systemPrompt: "SYSTEM",
        message: {
          role: "custom",
          customType: "status",
          content: "tape storage encryption",
          display: false,
          timestamp: Date.now(),
        },
      },
      context,
    );
    assert.match((custom as any).systemPrompt, /<memory_context/);
    assert.equal(extension.sentMessages.length, 0);
    const userEvent = {
      type: "before_agent_start",
      messageType: "user",
      systemPrompt: "SYSTEM",
      prompt: "tape storage encryption must use envelope encryption",
    };
    await beforeStart(userEvent, context);
    const bridges = () =>
      extension.sentMessages.filter((item) => item.message.customType === "pi-memory-md-session-bridge");
    assert.equal(bridges().length, 1);
    assert.match(String(bridges()[0].message.content), /envelope encryption/);
    const keywords = extension.sentMessages.filter((item) => item.message.customType === "pi-memory-md-tape-keyword");
    assert.equal(keywords.length, tapeEnabled ? 1 : 0);
    await beforeStart(userEvent, context);
    assert.equal(bridges().length, 1);
  });
}

test("before_agent_start uses tape context in message-append mode and queues keyword handoff once", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-3");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-3");
  const localPath = path.join(homeDir, "memory-root");
  const memoryDir = createProjectMemory(projectDir, localPath);
  initGitRepo(projectDir);
  fs.mkdirSync(path.join(memoryDir, "reference"), { recursive: true });

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      delivery: "message-append",
      tape: {
        enabled: true,
        context: { strategy: "recent-only", fileLimit: 5 },
        anchor: { mode: "manual", keywords: { global: ["tape"] } },
      },
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  const ui = createUi();

  const result = await beforeAgentStart?.(
    { prompt: "please help with tape labels", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager() },
  );
  const secondResult = await beforeAgentStart?.(
    { prompt: "please help with tape labels", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager() },
  );

  assert.equal((result as any).message.customType, "pi-memory-md-tape");
  assert.match((result as any).message.content, /Tape is enabled/);
  assert.match((result as any).message.content, /Handoff mode: manual/);
  assert.equal(secondResult, undefined);
  assert.equal(extension.sentMessages.length, 2);
  assert.equal(extension.sentMessages[0]?.message.customType, "pi-memory-md-tape-keyword");
  assert.equal(extension.sentMessages[1]?.message.customType, "pi-memory-md-tape-keyword");
});

for (const delivery of ["message-append", "system-prompt"] as const) {
  test(`automatic injection skips Jev and respects ${delivery} delivery`, async () => {
    const homeDir = createTempDir("pi-memory-jev-mode-home");
    const projectDir = createTempDir("pi-memory-jev-mode-project");
    initGitRepo(projectDir);
    const localPath = path.join(homeDir, "memory-root");
    const memoryDir = createProjectMemory(projectDir, localPath);
    for (const name of ["startup", "storage", "excluded"]) {
      writeMemoryFile(path.join(memoryDir, "core", `${name}.md`), `# ${name}`, { description: name });
    }
    const olderTime = new Date("2020-01-01T00:00:00Z");
    for (const relativePath of ["core/excluded.md", "core/user/identity.md"]) {
      fs.utimesSync(path.join(memoryDir, relativePath), olderTime, olderTime);
    }
    writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
      "pi-memory-md": {
        localPath,
        delivery,
        tape: {
          enabled: true,
          context: {
            strategy: "smart",
            fileLimit: 2,
            whitelist: ["core/user/identity.md"],
            blacklist: ["core/excluded.md"],
            jev: { enabled: true },
          },
        },
      },
    });
    const extension = bootExtension(homeDir, projectDir);
    const modelLookup = mock.fn(() => ({}));
    const classify = mock.fn(async () => ({ stopReason: "error", answers: {} }));
    const context = {
      cwd: projectDir,
      ui: createUi(),
      sessionManager: createSessionManager(),
      modelRegistry: { getModelOfType: modelLookup, classify },
    };
    await extension.handlers.get("session_start")?.({ reason: "new" }, context);
    const first = (await extension.handlers.get("before_agent_start")?.(
      { prompt: "startup", systemPrompt: "SYSTEM" },
      context,
    )) as any;
    const firstContent = delivery === "system-prompt" ? first.systemPrompt : first.message.content;
    assert.match(firstContent, /startup.md/);
    assert.match(firstContent, /identity.md/);
    assert.match(firstContent, /storage.md/);
    assert.doesNotMatch(firstContent, /excluded.md/);
    const second = (await extension.handlers.get("before_agent_start")?.(
      { prompt: "storage", systemPrompt: "SYSTEM" },
      context,
    )) as any;
    if (delivery === "system-prompt") {
      assert.match(second.systemPrompt, /storage.md/);
      assert.match(second.systemPrompt, /startup.md/);
    } else {
      assert.equal(second, undefined);
    }
    assert.equal(modelLookup.mock.callCount(), 0);
    assert.equal(classify.mock.callCount(), 0);
    assert.equal(context.ui.notifications.filter((item) => item.message.startsWith("Jev:")).length, 0);
  });
}

test("tool_call blocks direct tape_handoff in manual mode before execution", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-tool-call");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-tool-call");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);
  initGitRepo(projectDir);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      tape: {
        enabled: true,
        anchor: { mode: "manual", keywords: { global: ["tape"] } },
      },
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const toolCall = extension.handlers.get("tool_call");
  const beforeAgentStart = extension.handlers.get("before_agent_start");

  const directResult = await toolCall?.(
    { toolName: "tape_handoff", toolCallId: "call-1", input: { name: "task/direct" } },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  await beforeAgentStart?.(
    { prompt: "please help with tape labels", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );
  const keywordResult = await toolCall?.(
    { toolName: "tape_handoff", toolCallId: "call-2", input: { name: "handoff/other" } },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  await beforeAgentStart?.(
    { prompt: "please help with tape labels", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );
  const keywordAnchorName = String(extension.sentMessages.at(-1)?.message.content).match(/- name: "([^"]+)"/)?.[1];
  const allowedResult = await toolCall?.(
    { toolName: "tape_handoff", toolCallId: "call-3", input: { name: keywordAnchorName } },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  assert.equal((directResult as any).block, true);
  assert.match((directResult as any).reason, /tape_handoff is disabled/);
  assert.equal((keywordResult as any).block, true);
  assert.equal(allowedResult, undefined);
});

test("before_agent_start skips tape delivery and anchor recording when onlyGit is true outside git repos", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-git-only");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-git-only");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      delivery: "message-append",
      tape: {
        enabled: true,
        onlyGit: true,
        context: { strategy: "recent-only", fileLimit: 5 },
        anchor: { keywords: { global: ["tape"] } },
      },
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const sessionStart = extension.handlers.get("session_start");
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  const ui = createUi();

  await sessionStart?.({ reason: "new" }, { cwd: projectDir, ui, sessionManager: createSessionManager() });
  const result = await beforeAgentStart?.(
    { prompt: "please help with tape labels", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager() },
  );

  assert.equal(result, undefined);
  assert.equal(extension.sentMessages.length, 0);
  assert.equal(
    ui.notifications.some((item) => item.message.includes("Tape mode:")),
    false,
  );
  assert.equal(
    ui.notifications.some((item) => item.message.includes("Memory delivered:")),
    false,
  );
  assert.equal(fs.existsSync(path.join(localPath, "TAPE")), false);
});

test("before_agent_start does not deliver tape context later after an empty initial selection", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-empty-tape-later");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-empty-tape-later");
  const localPath = path.join(homeDir, "memory-root");
  const memoryDir = path.join(localPath, path.basename(projectDir));
  const projectFile = path.join(projectDir, "src.ts");
  const entries: SessionEntry[] = [];

  fs.mkdirSync(path.join(memoryDir, "core"), { recursive: true });
  fs.writeFileSync(projectFile, "export const value = 1;\n");
  initGitRepo(projectDir);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      delivery: "message-append",
      tape: {
        enabled: true,
        context: { strategy: "smart", fileLimit: 5 },
      },
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  const ui = createUi();
  const sessionManager = createSessionManager(entries);

  const first = await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager },
  );

  entries.push({
    type: "message",
    timestamp: new Date().toISOString(),
    id: crypto.randomUUID(),
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "src.ts" } }],
    },
  } as unknown as SessionEntry);

  const second = await beforeAgentStart?.(
    { prompt: "continue", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager },
  );

  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(extension.sentMessages.length, 0);
});

test("before_agent_start skips empty tape delivery when selected file count is zero", async () => {
  for (const delivery of ["message-append", "system-prompt"] as const) {
    const homeDir = createTempDir(`pi-memory-md-index-mode-home-empty-tape-${delivery}`);
    const projectDir = createTempDir(`pi-memory-md-index-mode-project-empty-tape-${delivery}`);
    const localPath = path.join(homeDir, "memory-root");
    const memoryDir = path.join(localPath, path.basename(projectDir));
    fs.mkdirSync(path.join(memoryDir, "core"), { recursive: true });
    initGitRepo(projectDir);

    writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
      "pi-memory-md": {
        localPath,
        delivery,
        tape: {
          enabled: true,
          context: { strategy: "recent-only", fileLimit: 5 },
        },
      },
    });

    const extension = bootExtension(homeDir, projectDir);
    const beforeAgentStart = extension.handlers.get("before_agent_start");
    const ui = createUi();

    const result = await beforeAgentStart?.(
      { prompt: "hello", systemPrompt: "SYSTEM" },
      { cwd: projectDir, ui, sessionManager: createSessionManager() },
    );
    const secondResult = await beforeAgentStart?.(
      { prompt: "hello again", systemPrompt: "SYSTEM" },
      { cwd: projectDir, ui, sessionManager: createSessionManager() },
    );

    assert.equal(result, undefined);
    assert.equal(secondResult, undefined);
    assert.equal(extension.sentMessages.length, 0);
    assert.equal(
      ui.notifications.some((item) => item.message.includes("Tape mode:")),
      false,
    );
  }
});

test("before_agent_start skips tape delivery when cwd matches excluded dirs", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-excluded");
  const blockedRoot = createTempDir("pi-memory-md-index-mode-blocked-root");
  const projectDir = path.join(blockedRoot, "project");
  const localPath = path.join(homeDir, "memory-root");
  fs.mkdirSync(projectDir, { recursive: true });
  createProjectMemory(projectDir, localPath);
  initGitRepo(projectDir);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      delivery: "message-append",
      tape: {
        enabled: true,
        excludeDirs: [blockedRoot],
        context: { strategy: "recent-only", fileLimit: 5 },
        anchor: { keywords: { global: ["tape"] } },
      },
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const sessionStart = extension.handlers.get("session_start");
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  const ui = createUi();

  await sessionStart?.({ reason: "new" }, { cwd: projectDir, ui, sessionManager: createSessionManager() });
  const result = await beforeAgentStart?.(
    { prompt: "please help with tape labels", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager() },
  );

  assert.equal(result, undefined);
  assert.equal(extension.sentMessages.length, 0);
  assert.equal(
    ui.notifications.some((item) => item.message.includes("Tape mode:")),
    false,
  );
  assert.equal(fs.existsSync(path.join(localPath, "TAPE")), false);
});

test("before_agent_start uses tape context in system-prompt mode and keeps delivering on later calls", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-4");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-4");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);
  initGitRepo(projectDir);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      delivery: "system-prompt",
      tape: {
        enabled: true,
        context: { strategy: "recent-only", fileLimit: 5 },
      },
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const beforeAgentStart = extension.handlers.get("before_agent_start");

  const first = await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );
  const second = await beforeAgentStart?.(
    { prompt: "hello again", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  assert.match((first as any).systemPrompt, /Tape is enabled/);
  assert.match((second as any).systemPrompt, /Tape is enabled/);
  assert.equal(extension.sentMessages.length, 0);
});

test("reloading extension picks up updated settings and switches behavior", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-5");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-5");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);
  initGitRepo(projectDir);

  const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
  writeJson(settingsPath, {
    "pi-memory-md": {
      localPath,
      tape: { enabled: false },
      delivery: "message-append",
    },
  });

  const firstExtension = bootExtension(homeDir, projectDir);
  const firstResult = await firstExtension.handlers.get("before_agent_start")?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  writeJson(settingsPath, {
    "pi-memory-md": {
      localPath,
      tape: {
        enabled: true,
        context: { strategy: "recent-only", fileLimit: 5 },
      },
      delivery: "system-prompt",
    },
  });

  const reloadedExtension = bootExtension(homeDir, projectDir);
  const secondResult = await reloadedExtension.handlers.get("before_agent_start")?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  assert.equal((firstResult as any).message.customType, "pi-memory-md");
  assert.match((secondResult as any).systemPrompt, /Tape is enabled/);
  assert.equal(reloadedExtension.registeredCommands.includes("memory-anchor"), true);
});
