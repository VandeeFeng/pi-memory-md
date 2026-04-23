// Covers injection-mode switching, tape/non-tape exclusivity, keyword handoff queuing, and reload behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import memoryMdExtension from "../index.js";
import { writeMemoryFile } from "../memory-core.js";
import { createTempDir, writeJson } from "./test-helpers.js";

type HandlerMap = Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>;

type ExtensionHarness = {
  handlers: HandlerMap;
  sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
  registeredCommands: string[];
};

function createSessionManager(entries: SessionEntry[] = []): any {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getSessionId: () => "session-1",
    getEntry: (id: string) => byId.get(id),
    getEntries: () => entries,
    getLabel: () => undefined,
    labelsById: new Map<string, string>(),
    labelTimestampsById: new Map<string, string>(),
  };
}

function createUi() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
  };
}

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
      injection: "message-append",
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
  assert.match((result as any).message.content, /# Project Memory/);
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
      injection: "system-prompt",
    },
  });

  const extension = bootExtension(homeDir, projectDir);
  const beforeAgentStart = extension.handlers.get("before_agent_start");
  const result = await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager() },
  );

  assert.match((result as any).systemPrompt, /SYSTEM/);
  assert.match((result as any).systemPrompt, /# Project Memory/);
  assert.equal((result as any).message, undefined);
});

test("before_agent_start uses tape context in message-append mode and queues keyword handoff once", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-3");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-3");
  const localPath = path.join(homeDir, "memory-root");
  const memoryDir = createProjectMemory(projectDir, localPath);
  fs.mkdirSync(path.join(memoryDir, "reference"), { recursive: true });

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      injection: "message-append",
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

test("before_agent_start uses tape context in system-prompt mode and keeps injecting on later calls", async () => {
  const homeDir = createTempDir("pi-memory-md-index-mode-home-4");
  const projectDir = createTempDir("pi-memory-md-index-mode-project-4");
  const localPath = path.join(homeDir, "memory-root");
  createProjectMemory(projectDir, localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      injection: "system-prompt",
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

  const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
  writeJson(settingsPath, {
    "pi-memory-md": {
      localPath,
      tape: { enabled: false },
      injection: "message-append",
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
      injection: "system-prompt",
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
