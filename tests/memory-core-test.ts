// Covers settings loading, memory file I/O, initialization, context building, and path safety.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { mock, test } from "node:test";
import path from "path";
import {
  buildMemoryContextAsync,
  DEFAULT_SETTINGS,
  getGlobalMemoryDir,
  getMemoryCoreDir,
  getMemoryDir,
  getMemoryUserDir,
  initializeMemoryDirectory,
  isMemoryInitialized,
  loadSettings,
  readMemoryFileAsync,
  writeMemoryFile,
} from "../memory-core.js";
import { DEFAULT_TAPE_EXCLUDE_DIRS, hasSymlinkInPath, resolvePathWithin } from "../utils.js";
import { createTempDir, initGitRepo, writeJson, writeText } from "./test-helpers.js";

test("loadSettings merges defaults, global/project settings, and normalizes values", () => {
  const tempHome = createTempDir("pi-memory-md-home");
  const projectDir = createTempDir("pi-memory-md-project");

  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      repoUrl: "https://github.com/acme/global-memory.git",
      localPath: "~/global-memory",
      hooks: {
        sessionStart: ["pull"],
        sessionEnd: [],
      },
      globalMemory: {
        enabled: true,
        directory: "global",
      },
      delivery: "system-prompt",
      tape: {
        enabled: true,
        context: {
          memoryScan: [3.8, 1.2],
          whitelist: [" core/user/identity.md ", "core/user/identity.md"],
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
      repoUrl: "https://github.com/acme/project-memory.git",
      localPath: "~/custom-memory",
      hooks: {
        sessionStart: ["push", "", "pull"],
        sessionEnd: ["push"],
      },
      globalMemory: {
        enabled: true,
        directory: "project-global",
      },
      tape: {
        tapePath: "~/project-tape",
        excludeDirs: ["~/blocked", "relative/path"],
        context: {
          fileLimit: 3,
          memoryScan: [10.9, 5.1],
          alwaysInclude: [" docs/tape-design.md "],
          blacklist: [" node_modules ", "node_modules"],
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
    assert.equal(settings.delivery, "system-prompt");
    assert.equal(settings.injection, "system-prompt");
    assert.equal(settings.localPath, path.join(tempHome, "global-memory"));
    assert.deepEqual(settings.hooks, {
      sessionStart: ["pull"],
      sessionEnd: [],
    });
    assert.deepEqual(settings.globalMemory, {
      enabled: true,
      directoryName: "global",
    });
    assert.equal(getGlobalMemoryDir(settings), path.join(tempHome, "global-memory", "global"));
    assert.equal(settings.tape?.enabled, true);
    assert.equal(settings.tape?.onlyGit, true);
    assert.equal(settings.tape?.context?.fileLimit, 3);
    assert.deepEqual(settings.tape?.context?.memoryScan, [10, 10]);
    assert.equal(settings.tape?.tapePath, undefined);
    assert.deepEqual(settings.tape?.excludeDirs, [...DEFAULT_TAPE_EXCLUDE_DIRS, path.join(tempHome, "blocked")]);
    assert.deepEqual(settings.tape?.context?.whitelist, ["docs/tape-design.md", "core/user/identity.md"]);
    assert.deepEqual(settings.tape?.context?.blacklist, ["node_modules"]);
    assert.equal(settings.tape?.anchor?.mode, "auto");
    assert.deepEqual(settings.tape?.anchor?.keywords, {
      global: ["foo"],
      project: ["bar"],
    });
  } finally {
    homedirMock.mock.restore();
  }
});

test("loadSettings falls back to legacy injection when delivery is unset", () => {
  const tempHome = createTempDir("pi-memory-md-home-legacy-delivery");
  const projectDir = createTempDir("pi-memory-md-project-legacy-delivery");

  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      injection: "system-prompt",
    },
  });

  const homedirMock = mock.method(os, "homedir", () => tempHome);

  try {
    const settings = loadSettings(projectDir);
    assert.equal(settings.delivery, "system-prompt");
    assert.equal(settings.injection, "system-prompt");
  } finally {
    homedirMock.mock.restore();
  }
});

test("loadSettings enables tape when tape config exists unless explicitly disabled", () => {
  const tempHome = createTempDir("pi-memory-md-home-tape-default");
  const projectDir = createTempDir("pi-memory-md-project-tape-default");

  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      tape: {
        context: {
          fileLimit: 3,
        },
      },
    },
  });

  const homedirMock = mock.method(os, "homedir", () => tempHome);

  try {
    const enabledSettings = loadSettings(projectDir);
    assert.equal(enabledSettings.tape?.enabled, true);

    writeJson(path.join(projectDir, ".pi", "settings.json"), {
      "pi-memory-md": {
        tape: {
          enabled: false,
          onlyGit: false,
        },
      },
    });

    const disabledSettings = loadSettings(projectDir);
    assert.equal(disabledSettings.tape?.enabled, false);
    assert.equal(disabledSettings.tape?.onlyGit, false);
  } finally {
    homedirMock.mock.restore();
  }
});

test("readMemoryFileAsync returns fallback frontmatter for missing frontmatter", async () => {
  const tempDir = createTempDir("pi-memory-md-read-no-frontmatter");
  const filePath = path.join(tempDir, "note.md");

  writeText(filePath, "# Plain note\n\nNo frontmatter here.");

  const memory = await readMemoryFileAsync(filePath);

  assert.ok(memory);
  assert.equal(memory?.frontmatter.description, "No description");
  assert.equal(memory?.content, "# Plain note\n\nNo frontmatter here.");
});

test("globalMemory defaults to enabled when config block exists", () => {
  const tempHome = createTempDir("pi-memory-md-home-global-default");
  const projectDir = createTempDir("pi-memory-md-project-global-default");

  // Test 1: Empty globalMemory block defaults to enabled
  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath: "~/memory",
      globalMemory: {},
    },
  });

  let homedirMock = mock.method(os, "homedir", () => tempHome);
  try {
    const settings = loadSettings(projectDir);
    assert.equal(settings.globalMemory?.enabled, true);
    assert.equal(settings.globalMemory?.directory, "global");
  } finally {
    homedirMock.mock.restore();
  }

  // Test 2: globalMemory with directory defaults to enabled
  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath: "~/memory",
      globalMemory: {
        directory: "shared",
      },
    },
  });

  homedirMock = mock.method(os, "homedir", () => tempHome);
  try {
    const settings = loadSettings(projectDir);
    assert.equal(settings.globalMemory?.enabled, true);
    assert.equal(settings.globalMemory?.directory, "shared");
  } finally {
    homedirMock.mock.restore();
  }

  // Test 3: No globalMemory config defaults to disabled
  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath: "~/memory",
    },
  });

  homedirMock = mock.method(os, "homedir", () => tempHome);
  try {
    const settings = loadSettings(projectDir);
    assert.equal(settings.globalMemory?.enabled, false);
  } finally {
    homedirMock.mock.restore();
  }

  // Test 4: Explicit enabled: false disables
  writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
    "pi-memory-md": {
      localPath: "~/memory",
      globalMemory: {
        enabled: false,
        directory: "should-not-use",
      },
    },
  });

  homedirMock = mock.method(os, "homedir", () => tempHome);
  try {
    const settings = loadSettings(projectDir);
    assert.equal(settings.globalMemory?.enabled, false);
  } finally {
    homedirMock.mock.restore();
  }
});

test("readMemoryFileAsync returns fallback frontmatter for invalid frontmatter", async () => {
  const tempDir = createTempDir("pi-memory-md-read-invalid-frontmatter");
  const filePath = path.join(tempDir, "note.md");

  writeText(filePath, "---\ndescription: 123\ntags: nope\n---\n\n# Broken\n");

  const memory = await readMemoryFileAsync(filePath);

  assert.ok(memory);
  assert.equal(memory?.frontmatter.description, "No description");
  assert.match(memory?.content ?? "", /description: 123/);
});

test("writeMemoryFile writes YAML frontmatter and body that can be read back", async () => {
  const tempDir = createTempDir("pi-memory-md-write");
  const filePath = path.join(tempDir, "core", "user", "identity.md");

  writeMemoryFile(filePath, "# Identity\n\nHello", {
    description: "User identity",
    tags: ["user", "identity"],
    created: "2026-04-23",
  });

  const raw = fs.readFileSync(filePath, "utf-8");
  const memory = await readMemoryFileAsync(filePath);

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

test("getMemoryDir uses git root name when cwd is inside a repository subdirectory", () => {
  const tempDir = createTempDir("pi-memory-md-memory-dir-git-root");
  const projectRoot = path.join(tempDir, "project-a");
  const nestedCwd = path.join(projectRoot, "docs");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
  };

  initGitRepo(projectRoot);
  fs.mkdirSync(nestedCwd, { recursive: true });

  assert.equal(getMemoryDir(settings, nestedCwd), path.join(settings.localPath, "project-a"));
});

test("buildMemoryContextAsync lists only core markdown files with relative paths", async () => {
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

  const context = await buildMemoryContextAsync(settings, projectDir);

  assert.match(context, /# Project Memory/);
  assert.match(context, new RegExp(`Memory directory: ${memoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(context, /- core\/user\/identity\.md/);
  assert.match(context, /- core\/project\/roadmap\.md/);
  assert.doesNotMatch(context, /reference\/ignore\.md/);
});

test("buildMemoryContextAsync includes shared global memory before project memory", async () => {
  const tempDir = createTempDir("pi-memory-md-global-context");
  const projectDir = path.join(tempDir, "project-a");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
    globalMemory: {
      enabled: true,
      directory: "global",
    },
  };
  const projectMemoryDir = getMemoryDir(settings, projectDir);
  const globalMemoryDir = getGlobalMemoryDir(settings);

  assert.ok(globalMemoryDir);
  writeMemoryFile(path.join(globalMemoryDir, "core", "user", "prefer.md"), "# Preferences", {
    description: "Global preferences",
    tags: ["global"],
  });
  writeMemoryFile(path.join(projectMemoryDir, "core", "project", "overview.md"), "# Overview", {
    description: "Project overview",
    tags: ["project"],
  });

  const context = await buildMemoryContextAsync(settings, projectDir);

  assert.match(
    context,
    new RegExp(`Shared global memory directory: ${globalMemoryDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(context, /## Shared Global Memory/);
  assert.match(context, /- global\/core\/user\/prefer\.md/);
  assert.match(context, /## Project Memory/);
  assert.match(context, /- project\/core\/project\/overview\.md/);
  assert.ok(context.indexOf("## Shared Global Memory") < context.indexOf("## Project Memory"));
});

test("buildMemoryContextAsync returns empty string when core directory is missing", async () => {
  const tempDir = createTempDir("pi-memory-md-empty-context");
  const projectDir = path.join(tempDir, "project-b");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
  };

  assert.equal(await buildMemoryContextAsync(settings, projectDir), "");
});

test("resolvePathWithin blocks path traversal outside memory directory", () => {
  const tempDir = createTempDir("pi-memory-md-paths");
  const baseDir = path.join(tempDir, "memory");

  assert.equal(resolvePathWithin(baseDir, "core/user/identity.md"), path.join(baseDir, "core", "user", "identity.md"));
  assert.equal(resolvePathWithin(baseDir, "../escape.md"), null);
});

test("hasSymlinkInPath detects symlink escapes inside memory directory", () => {
  const tempDir = createTempDir("pi-memory-md-paths-symlink");
  const baseDir = path.join(tempDir, "memory");
  const outsideFile = path.join(tempDir, "outside.md");
  const linkPath = path.join(baseDir, "core", "user", "linked.md");

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  writeText(outsideFile, "outside");
  fs.symlinkSync(outsideFile, linkPath);

  assert.equal(hasSymlinkInPath(baseDir, linkPath), true);
});

test("getMemoryDir uses mainRoot project name for worktrees", () => {
  const tempDir = createTempDir("pi-memory-md-worktree-memory");
  const mainRepo = path.join(tempDir, "main-project");
  const worktreePath = path.join(tempDir, "my-feature");
  const settings = { localPath: path.join(tempDir, "memory") };

  initGitRepo(mainRepo);
  execFileSync("git", ["worktree", "add", "-b", "feature", worktreePath], {
    cwd: mainRepo,
    stdio: "ignore",
  });

  const memoryDir = getMemoryDir(settings, worktreePath);
  assert.equal(memoryDir, path.join(settings.localPath, "main-project"));
});
