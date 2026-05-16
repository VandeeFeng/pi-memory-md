// Covers delivery-mode switching, tape/non-tape exclusivity, keyword handoff queuing, and reload behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import memoryMdExtension from "../index.js";
import { writeMemoryFile } from "../memory-core.js";
import { createSessionManager, createTempDir, createUi, initGitRepo, writeJson } from "./test-helpers.js";

type HandlerMap = Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>;

type ExtensionHarness = {
  handlers: HandlerMap;
  sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
  registeredCommands: string[];
};

function bootExtension(homeDir: string, projectDir: string): ExtensionHarness {
  const handlers: HandlerMap = new Map();
  const sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const registeredCommands: string[] = [];
  const homedirMock = mock.method(os, "homedir", () => homeDir);
  const previousCwd = process.cwd();

  try {
    process.chdir(projectDir);
    memoryMdExtension({
      on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
        sentMessages.push({ message, options });
      },
    } as never);
  } finally {
    process.chdir(previousCwd);
    homedirMock.mock.restore();
  }

  return { handlers, sentMessages, registeredCommands };
}

function createProjectMemory(projectDir: string, localPath: string): string {
  const memoryDir = path.join(localPath, path.basename(projectDir));
  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity",
    tags: ["user"],
  });
  return memoryDir;
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
