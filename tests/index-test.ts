// Covers slash-command registration differences between tape-disabled and tape-enabled startup.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import memoryMdExtension from "../index.js";
import { createTempDir, writeJson } from "./test-helpers.js";

test("memoryMdExtension does not register memory-anchor when tape is disabled", () => {
  const tempHome = createTempDir("pi-memory-md-index-home");
  const projectDir = createTempDir("pi-memory-md-index-project");

  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      tape: {
        enabled: false,
      },
    },
  });

  const registeredCommands: string[] = [];
  const homedirMock = mock.method(os, "homedir", () => tempHome);
  const previousCwd = process.cwd();

  try {
    process.chdir(projectDir);
    memoryMdExtension({
      on() {},
      registerTool() {},
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      sendMessage() {},
    } as never);
  } finally {
    process.chdir(previousCwd);
    homedirMock.mock.restore();
  }

  assert.deepEqual(registeredCommands, ["memory-status", "memory-init", "memory-refresh", "memory-check"]);
  assert.equal(registeredCommands.includes("memory-anchor"), false);
});

test("memoryMdExtension registers memory-anchor when tape is enabled", () => {
  const tempHome = createTempDir("pi-memory-md-index-home-enabled");
  const projectDir = createTempDir("pi-memory-md-index-project-enabled");

  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      tape: {
        enabled: true,
      },
    },
  });

  const registeredCommands: string[] = [];
  const homedirMock = mock.method(os, "homedir", () => tempHome);
  const previousCwd = process.cwd();

  try {
    process.chdir(projectDir);
    memoryMdExtension({
      on() {},
      registerTool() {},
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      sendMessage() {},
    } as never);
  } finally {
    process.chdir(previousCwd);
    homedirMock.mock.restore();
  }

  assert.equal(registeredCommands.includes("memory-anchor"), true);
});
