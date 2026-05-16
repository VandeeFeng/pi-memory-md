// Covers session lifecycle hooks, command/tool registration timing, and config reload across extension restarts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import memoryMdExtension from "../index.js";
import { createSessionManager, createTempDir, createUi, initGitRepo, writeJson } from "./test-helpers.js";

type HandlerMap = Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>;

type Harness = {
  handlers: HandlerMap;
  registeredCommands: string[];
  registeredTools: string[];
  execCalls: Array<{ command: string; args: string[]; cwd?: string }>;
};

function bootExtension(
  homeDir: string,
  projectDir: string,
  execHandler?: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout?: string }>,
): Harness {
  const handlers: HandlerMap = new Map();
  const registeredCommands: string[] = [];
  const registeredTools: string[] = [];
  const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const homedirMock = mock.method(os, "homedir", () => homeDir);
  const previousCwd = process.cwd();

  try {
    process.chdir(projectDir);
    memoryMdExtension({
      on(name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
        handlers.set(name, handler);
      },
      registerTool(tool: { name: string }) {
        registeredTools.push(tool.name);
      },
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      sendMessage() {},
      async exec(command: string, args: string[], options?: { cwd?: string }) {
        execCalls.push({ command, args, cwd: options?.cwd });
        if (execHandler) {
          return execHandler(command, args, options);
        }
        return { stdout: "" };
      },
    } as never);
  } finally {
    process.chdir(previousCwd);
    homedirMock.mock.restore();
  }

  return { handlers, registeredCommands, registeredTools, execCalls };
}

function setupMemoryProject(homeDir: string, projectDir: string): { localPath: string; memoryDir: string } {
  const localPath = path.join(homeDir, "memory-root");
  const memoryDir = path.join(localPath, path.basename(projectDir));
  fs.mkdirSync(path.join(memoryDir, "core", "user"), { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "core", "user", "identity.md"),
    "---\ndescription: Identity\n---\n\n# Identity\n",
  );
  return { localPath, memoryDir };
}

test("memory-anchor command is only registered when tape is enabled", () => {
  const disabledHomeDir = createTempDir("pi-memory-md-index-home-disabled");
  const disabledProjectDir = createTempDir("pi-memory-md-index-project-disabled");
  const enabledHomeDir = createTempDir("pi-memory-md-index-home-enabled");
  const enabledProjectDir = createTempDir("pi-memory-md-index-project-enabled");

  writeJson(path.join(disabledHomeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": { tape: { enabled: false } },
  });
  writeJson(path.join(enabledHomeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": { tape: {} },
  });

  const disabled = bootExtension(disabledHomeDir, disabledProjectDir);
  const enabled = bootExtension(enabledHomeDir, enabledProjectDir);

  assert.deepEqual(disabled.registeredCommands, ["memory-refresh", "memory-check"]);
  assert.equal(disabled.registeredCommands.includes("memory-anchor"), false);
  assert.equal(enabled.registeredCommands.includes("memory-anchor"), true);
});

test("session_start registers tape tools only once and skips start hooks for replaced sessions", async () => {
  const homeDir = createTempDir("pi-memory-md-lifecycle-home-1");
  const projectDir = createTempDir("pi-memory-md-lifecycle-project-1");
  const { localPath } = setupMemoryProject(homeDir, projectDir);
  initGitRepo(localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      repoUrl: "https://github.com/acme/memory.git",
      hooks: { sessionStart: ["pull"] },
      tape: { enabled: true },
    },
  });

  const harness = bootExtension(homeDir, projectDir, async () => {
    throw new Error("sessionStart hook should not run for new/resume/fork");
  });
  const sessionStart = harness.handlers.get("session_start");
  assert.ok(sessionStart);

  await sessionStart?.(
    { reason: "new", previousSessionFile: "/tmp/old-session.jsonl" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager([], "entry-1") },
  );
  await sessionStart?.(
    { reason: "fork", previousSessionFile: "/tmp/old-session.jsonl" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager([], "entry-1") },
  );
  await sessionStart?.(
    { reason: "resume", previousSessionFile: "/tmp/old-session.jsonl" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager([], "entry-1") },
  );

  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.registeredTools.filter((name) => name === "tape_handoff").length, 1);
});

test("session_start runs start hooks for startup sessions", async () => {
  const homeDir = createTempDir("pi-memory-md-lifecycle-home-startup");
  const projectDir = createTempDir("pi-memory-md-lifecycle-project-startup");
  const { localPath } = setupMemoryProject(homeDir, projectDir);
  initGitRepo(localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      repoUrl: "https://github.com/acme/memory.git",
      hooks: { sessionStart: ["pull"] },
    },
  });

  const harness = bootExtension(homeDir, projectDir, async (_command, args) => {
    const gitCommand = args.join(" ");
    if (gitCommand === "rev-parse --git-path FETCH_HEAD") return { stdout: ".git/FETCH_HEAD\n" };
    if (gitCommand === "fetch") return { stdout: "" };
    if (gitCommand === "rev-parse --abbrev-ref @{u}") return { stdout: "origin/main\n" };
    if (gitCommand === "rev-list --count HEAD..@{u}") return { stdout: "0\n" };
    throw new Error(`Unexpected git call: ${gitCommand}`);
  });

  const sessionStart = harness.handlers.get("session_start");
  const beforeAgentStart = harness.handlers.get("before_agent_start");

  await sessionStart?.(
    { reason: "startup" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager([], "entry-1") },
  );
  await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui: createUi(), sessionManager: createSessionManager([], "entry-1") },
  );

  assert.deepEqual(
    harness.execCalls.map((call) => call.args.join(" ")),
    ["rev-parse --git-path FETCH_HEAD", "fetch", "rev-parse --abbrev-ref @{u}", "rev-list --count HEAD..@{u}"],
  );
});

test("session_start runs start hooks for startup sessions and before_agent_start waits for them", async () => {
  const homeDir = createTempDir("pi-memory-md-lifecycle-home-2");
  const projectDir = createTempDir("pi-memory-md-lifecycle-project-2");
  const { localPath } = setupMemoryProject(homeDir, projectDir);
  initGitRepo(localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      repoUrl: "https://github.com/acme/memory.git",
      hooks: { sessionStart: ["pull"] },
      tape: { enabled: false },
    },
  });

  let behindChecks = 0;
  const harness = bootExtension(homeDir, projectDir, async (_command, args) => {
    const gitCommand = args.join(" ");
    if (gitCommand === "rev-parse --git-path FETCH_HEAD") return { stdout: ".git/FETCH_HEAD\n" };
    if (gitCommand === "fetch") return { stdout: "" };
    if (gitCommand === "rev-parse --abbrev-ref @{u}") return { stdout: "origin/main\n" };
    if (gitCommand === "rev-list --count HEAD..@{u}") {
      behindChecks += 1;
      return { stdout: behindChecks === 1 ? "1\n" : "0\n" };
    }
    if (gitCommand === "rebase --autostash @{u}") return { stdout: "Successfully rebased\n" };
    throw new Error(`Unexpected git call: ${gitCommand}`);
  });
  const sessionStart = harness.handlers.get("session_start");
  const beforeAgentStart = harness.handlers.get("before_agent_start");
  const ui = createUi();

  await sessionStart?.(
    { reason: "startup" },
    { cwd: projectDir, ui, sessionManager: createSessionManager([], "entry-1") },
  );
  const result = await beforeAgentStart?.(
    { prompt: "hello", systemPrompt: "SYSTEM" },
    { cwd: projectDir, ui, sessionManager: createSessionManager([], "entry-1") },
  );

  assert.deepEqual(
    harness.execCalls.map((call) => call.args.join(" ")),
    [
      "rev-parse --git-path FETCH_HEAD",
      "fetch",
      "rev-parse --abbrev-ref @{u}",
      "rev-list --count HEAD..@{u}",
      "rebase --autostash @{u}",
      "rev-parse --abbrev-ref @{u}",
      "rev-list --count HEAD..@{u}",
    ],
  );
  assert.equal((result as any).message.customType, "pi-memory-md");
  assert.equal(
    ui.notifications.some((item) => item.message.includes("Pulled latest changes from [memory] (start/pull)")),
    true,
  );
});

test("session_shutdown runs end hooks only when memory is initialized", async () => {
  const homeDir = createTempDir("pi-memory-md-lifecycle-home-3");
  const projectDir = createTempDir("pi-memory-md-lifecycle-project-3");
  const { localPath, memoryDir } = setupMemoryProject(homeDir, projectDir);
  initGitRepo(localPath);

  writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath,
      repoUrl: "https://github.com/acme/memory.git",
      hooks: { sessionEnd: ["push"] },
    },
  });

  const harness = bootExtension(homeDir, projectDir, async (_command, args) => {
    const gitCommand = args.join(" ");
    if (gitCommand === "status --porcelain") return { stdout: " M core/user/identity.md\n" };
    if (gitCommand === "add .") return { stdout: "" };
    if (args[0] === "commit") return { stdout: "[main abc123] Update memory\n" };
    if (gitCommand === "push") return { stdout: "done\n" };
    throw new Error(`Unexpected git call: ${gitCommand}`);
  });
  const sessionShutdown = harness.handlers.get("session_shutdown");
  const ui = createUi();

  await sessionShutdown?.({}, { cwd: projectDir, ui, sessionManager: createSessionManager([], "entry-1") });
  assert.equal(
    harness.execCalls.some((call) => call.args[0] === "push"),
    true,
  );
  assert.equal(
    ui.notifications.some((item) => item.message.includes("[memory] pushed memory changes (end/push)")),
    true,
  );

  fs.rmSync(memoryDir, { recursive: true, force: true });
  harness.execCalls.length = 0;
  ui.notifications.length = 0;

  await sessionShutdown?.({}, { cwd: projectDir, ui, sessionManager: createSessionManager([], "entry-1") });
  assert.equal(harness.execCalls.length, 0);
  assert.equal(ui.notifications.length, 0);
});

test("restarting extension reloads command and tool registration from updated tape settings", () => {
  const homeDir = createTempDir("pi-memory-md-lifecycle-home-4");
  const projectDir = createTempDir("pi-memory-md-lifecycle-project-4");
  const { localPath } = setupMemoryProject(homeDir, projectDir);
  const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");

  writeJson(settingsPath, {
    "pi-memory-md": {
      localPath,
      tape: { enabled: false },
    },
  });

  const first = bootExtension(homeDir, projectDir);

  writeJson(settingsPath, {
    "pi-memory-md": {
      localPath,
      tape: { enabled: true },
    },
  });

  const second = bootExtension(homeDir, projectDir);

  assert.equal(first.registeredTools.includes("tape_handoff"), false);
  assert.equal(second.registeredTools.includes("tape_handoff"), false);
  assert.equal(second.handlers.has("session_start"), true);
  assert.equal(second.handlers.has("before_agent_start"), true);
});
