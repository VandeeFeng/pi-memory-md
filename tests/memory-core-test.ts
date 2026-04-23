// Covers settings loading, memory file I/O, initialization, context building, and path safety.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
  buildMemoryContext,
  DEFAULT_SETTINGS,
  getMemoryCoreDir,
  getMemoryDir,
  getMemoryUserDir,
  initializeMemoryDirectory,
  isMemoryInitialized,
  loadSettings,
  readMemoryFile,
  writeMemoryFile,
} from "../memory-core.js";
import { resolvePathWithin } from "../utils.js";
import { createTempDir, writeJson, writeText } from "./test-helpers.js";

test("loadSettings merges defaults, global/project settings, and normalizes values", () => {
  const tempHome = createTempDir("pi-memory-md-home");
  const projectDir = createTempDir("pi-memory-md-project");

  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      repoUrl: "https://github.com/acme/global-memory.git",
      injection: "system-prompt",
      tape: {
        enabled: true,
        context: {
          memoryScan: [3.8, 1.2],
        },
        anchor: {
          mode: "manual",
          keywords: {
            global: [" Foo ", "foo"],
          },
        },
      },
    },
  });

  writeJson(path.join(projectDir, ".pi", "settings.json"), {
    "pi-memory-md": {
      localPath: "~/custom-memory",
      hooks: {
        sessionStart: ["push", "", "pull"],
        sessionEnd: ["push"],
      },
      tape: {
        context: {
          fileLimit: 3,
          memoryScan: [10.9, 5.1],
        },
        anchor: {
          mode: "invalid",
          keywords: {
            project: [" Bar ", "bar"],
          },
        },
      },
    },
  });

  const homedirMock = mock.method(os, "homedir", () => tempHome);

  try {
    const settings = loadSettings(projectDir);

    assert.equal(settings.enabled, DEFAULT_SETTINGS.enabled);
    assert.equal(settings.repoUrl, "https://github.com/acme/global-memory.git");
    assert.equal(settings.injection, "system-prompt");
    assert.equal(settings.localPath, path.join(tempHome, "custom-memory"));
    assert.deepEqual(settings.hooks, {
      sessionStart: ["push", "pull"],
      sessionEnd: ["push"],
    });
    assert.equal(settings.tape?.enabled, true);
    assert.equal(settings.tape?.context?.fileLimit, 3);
    assert.deepEqual(settings.tape?.context?.memoryScan, [10, 10]);
    assert.equal(settings.tape?.anchor?.mode, "auto");
    assert.deepEqual(settings.tape?.anchor?.keywords, {
      global: ["foo"],
      project: ["bar"],
    });
  } finally {
    homedirMock.mock.restore();
  }
});

test("readMemoryFile returns fallback frontmatter for missing frontmatter", () => {
  const tempDir = createTempDir("pi-memory-md-read-no-frontmatter");
  const filePath = path.join(tempDir, "note.md");

  writeText(filePath, "# Plain note\n\nNo frontmatter here.");

  const memory = readMemoryFile(filePath);

  assert.ok(memory);
  assert.equal(memory?.frontmatter.description, "No description");
  assert.equal(memory?.content, "# Plain note\n\nNo frontmatter here.");
});

test("readMemoryFile returns fallback frontmatter for invalid frontmatter", () => {
  const tempDir = createTempDir("pi-memory-md-read-invalid-frontmatter");
  const filePath = path.join(tempDir, "note.md");

  writeText(filePath, "---\ndescription: 123\ntags: nope\n---\n\n# Broken\n");

  const memory = readMemoryFile(filePath);

  assert.ok(memory);
  assert.equal(memory?.frontmatter.description, "No description");
  assert.match(memory?.content ?? "", /description: 123/);
});

test("writeMemoryFile writes YAML frontmatter and body that can be read back", () => {
  const tempDir = createTempDir("pi-memory-md-write");
  const filePath = path.join(tempDir, "core", "user", "identity.md");

  writeMemoryFile(filePath, "# Identity\n\nHello", {
    description: "User identity",
    tags: ["user", "identity"],
    created: "2026-04-23",
  });

  const raw = fs.readFileSync(filePath, "utf-8");
  const memory = readMemoryFile(filePath);

  assert.match(raw, /^---/);
  assert.match(raw, /description: User identity/);
  assert.ok(memory);
  assert.equal(memory?.frontmatter.description, "User identity");
  assert.deepEqual(memory?.frontmatter.tags, ["user", "identity"]);
  assert.equal(memory?.content.trim(), "# Identity\n\nHello");
});

test("initializeMemoryDirectory creates required directories and default files", () => {
  const tempDir = createTempDir("pi-memory-md-init");
  const memoryDir = path.join(tempDir, "memory");

  initializeMemoryDirectory(memoryDir);

  assert.equal(isMemoryInitialized(memoryDir), true);
  assert.equal(fs.existsSync(getMemoryCoreDir(memoryDir)), true);
  assert.equal(fs.existsSync(getMemoryUserDir(memoryDir)), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "reference")), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "core", "project")), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "core", "user", "identity.md")), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "core", "user", "prefer.md")), true);
});

test("buildMemoryContext lists only core markdown files with relative paths", () => {
  const tempDir = createTempDir("pi-memory-md-context");
  const projectDir = path.join(tempDir, "project-a");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
  };
  const memoryDir = getMemoryDir(settings, projectDir);

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity file",
    tags: ["user"],
  });
  writeMemoryFile(path.join(memoryDir, "core", "project", "roadmap.md"), "# Roadmap", {
    description: "Roadmap file",
    tags: ["project"],
  });
  writeMemoryFile(path.join(memoryDir, "reference", "ignore.md"), "# Ignore", {
    description: "Should not be listed",
    tags: ["reference"],
  });

  const context = buildMemoryContext(settings, projectDir);

  assert.match(context, /# Project Memory/);
  assert.match(context, new RegExp(`Memory directory: ${memoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(context, /- core\/user\/identity\.md/);
  assert.match(context, /- core\/project\/roadmap\.md/);
  assert.doesNotMatch(context, /reference\/ignore\.md/);
});

test("buildMemoryContext returns empty string when core directory is missing", () => {
  const tempDir = createTempDir("pi-memory-md-empty-context");
  const projectDir = path.join(tempDir, "project-b");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
  };

  assert.equal(buildMemoryContext(settings, projectDir), "");
});

test("resolvePathWithin blocks path traversal outside memory directory", () => {
  const tempDir = createTempDir("pi-memory-md-paths");
  const baseDir = path.join(tempDir, "memory");

  assert.equal(resolvePathWithin(baseDir, "core/user/identity.md"), path.join(baseDir, "core", "user", "identity.md"));
  assert.equal(resolvePathWithin(baseDir, "../escape.md"), null);
});
