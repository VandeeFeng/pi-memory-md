// Covers memory tool read, write, list, and search behavior plus invalid-path handling.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readMemoryFileAsync, writeMemoryFile } from "../memory-core.js";
import {
  registerMemoryDelete,
  registerMemoryList,
  registerMemoryMove,
  registerMemoryRead,
  registerMemorySearch,
  registerMemoryWrite,
} from "../tools.js";
import { createTempDir } from "./test-helpers.js";

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

type MockPi = {
  tools: Map<string, RegisteredTool>;
  registerTool: (tool: RegisteredTool) => void;
  exec: (command: string, args: string[], options?: { signal?: AbortSignal }) => Promise<{ stdout?: string }>;
};

function createMockPi(
  execHandler?: (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal },
  ) => Promise<{ stdout?: string }> | { stdout?: string },
): MockPi {
  const tools = new Map<string, RegisteredTool>();

  return {
    tools,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec(command, args, options) {
      if (!execHandler) {
        return { stdout: "" };
      }

      return execHandler(command, args, options);
    },
  };
}

function createToolContext(cwd: string) {
  return { cwd };
}

async function executeTool(pi: MockPi, name: string, params: Record<string, unknown>, cwd: string) {
  const tool = pi.tools.get(name);
  assert.ok(tool, `Tool not registered: ${name}`);
  return tool.execute("tool-call-1", params, undefined, undefined, createToolContext(cwd));
}

test("memory_read reads a file with offset and limit", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "line1\nline2\nline3\nline4", {
    description: "Identity",
    tags: ["user"],
  });

  const pi = createMockPi();
  registerMemoryRead(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_read",
    { path: "core/user/identity.md", offset: 2, limit: 2 },
    projectDir,
  )) as {
    content: Array<{ text?: string }>;
    details?: { frontmatter?: { description?: string } };
  };

  assert.match(result.content[0]?.text ?? "", /# Identity/);
  assert.match(result.content[0]?.text ?? "", /line2\nline3/);
  assert.doesNotMatch(result.content[0]?.text ?? "", /line1/);
  assert.doesNotMatch(result.content[0]?.text ?? "", /line4/);
  assert.equal(result.details?.frontmatter?.description, "Identity");
});

test("memory_read rejects invalid traversal paths", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read-invalid");
  const projectDir = path.join(tempDir, "project");
  const pi = createMockPi();

  registerMemoryRead(pi as never, { localPath: path.join(tempDir, "memory-root") });

  const result = (await executeTool(pi, "memory_read", { path: "../escape.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.match(result.content[0]?.text ?? "", /Invalid memory path/);
  assert.equal(result.details?.error, true);
});

test("memory_read rejects symlink paths", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read-symlink");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const outsideFile = path.join(tempDir, "outside.md");
  const linkPath = path.join(memoryDir, "core", "user", "linked.md");

  writeMemoryFile(outsideFile, "outside", { description: "Outside" });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(outsideFile, linkPath);

  const pi = createMockPi();
  registerMemoryRead(pi as never, settings);

  const result = (await executeTool(pi, "memory_read", { path: "core/user/linked.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.match(result.content[0]?.text ?? "", /Invalid memory path/);
  assert.equal(result.details?.error, true);
});

test("memory_write creates a file and preserves created while updating description and tags", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const filePath = path.join(memoryDir, "core", "user", "note.md");

  writeMemoryFile(filePath, "old", {
    description: "Old description",
    tags: ["old"],
    created: "2026-01-01",
  });

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_write",
    {
      path: "core/user/note.md",
      content: "# Updated\n\nHello",
      description: "New description",
      tags: ["new", "tag"],
    },
    projectDir,
  )) as {
    content: Array<{ text?: string }>;
    details?: { frontmatter?: { description?: string; tags?: string[]; created?: string; updated?: string } };
  };
  const written = await readMemoryFileAsync(filePath);

  assert.match(result.content[0]?.text ?? "", /Memory file written: core\/user\/note\.md/);
  assert.equal(result.details?.frontmatter?.created, "2026-01-01");
  assert.equal(result.details?.frontmatter?.updated, result.details?.frontmatter?.updated);
  assert.ok(result.details?.frontmatter?.updated);
  assert.equal(written?.frontmatter.description, "New description");
  assert.deepEqual(written?.frontmatter.tags, ["new", "tag"]);
  assert.equal(written?.frontmatter.created, "2026-01-01");
  assert.equal(written?.content.trim(), "# Updated\n\nHello");
});

test("memory_write rejects invalid traversal paths", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write-invalid");
  const projectDir = path.join(tempDir, "project");
  const pi = createMockPi();

  registerMemoryWrite(pi as never, { localPath: path.join(tempDir, "memory-root") });

  const result = (await executeTool(
    pi,
    "memory_write",
    { path: "../../escape.md", content: "x", description: "bad" },
    projectDir,
  )) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.match(result.content[0]?.text ?? "", /Invalid memory path/);
  assert.equal(result.details?.error, true);
});

test("memory_write rejects symlink paths", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write-symlink");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const outsideFile = path.join(tempDir, "outside.md");
  const linkPath = path.join(memoryDir, "core", "user", "linked.md");

  writeMemoryFile(outsideFile, "outside", { description: "Outside" });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(outsideFile, linkPath);

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_write",
    { path: "core/user/linked.md", content: "x", description: "bad" },
    projectDir,
  )) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.match(result.content[0]?.text ?? "", /Invalid memory path/);
  assert.equal(result.details?.error, true);
});

test("memory_list returns relative paths and supports directory filtering", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", { description: "Identity" });
  writeMemoryFile(path.join(memoryDir, "core", "project", "roadmap.md"), "# Roadmap", { description: "Roadmap" });

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  const allFiles = (await executeTool(pi, "memory_list", {}, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { files?: string[]; count?: number };
  };
  const userFiles = (await executeTool(pi, "memory_list", { directory: "core/user" }, projectDir)) as {
    details?: { files?: string[]; count?: number };
  };

  assert.equal(allFiles.details?.count, 2);
  assert.deepEqual(allFiles.details?.files, ["core/project/roadmap.md", "core/user/identity.md"]);
  assert.equal(userFiles.details?.count, 1);
  assert.deepEqual(userFiles.details?.files, ["core/user/identity.md"]);
  assert.match(allFiles.content[0]?.text ?? "", /Memory files \(2,/);
});

test("memory_list rejects symlink directories", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list-symlink");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const outsideDir = path.join(tempDir, "outside-dir");
  const linkDir = path.join(memoryDir, "core", "linked");

  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  fs.symlinkSync(outsideDir, linkDir);

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  const result = (await executeTool(pi, "memory_list", { directory: "core/linked" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.match(result.content[0]?.text ?? "", /Invalid memory directory/);
  assert.equal(result.details?.error, true);
});

test("memory_search rejects overly long custom patterns", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-search-long");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", { description: "Identity" });

  const pi = createMockPi();
  registerMemorySearch(pi as never, settings);

  const result = (await executeTool(pi, "memory_search", { grep: "x".repeat(201) }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean; count?: number };
  };

  assert.match(result.content[0]?.text ?? "", /Search pattern too long/);
  assert.equal(result.details?.error, true);
  assert.equal(result.details?.count, 0);
});

test("memory_search handles query, grep, rg, and empty results", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-search");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const coreDir = path.join(memoryDir, "core");
  const identityPath = path.join(coreDir, "user", "identity.md");
  const roadmapPath = path.join(coreDir, "project", "roadmap.md");

  writeMemoryFile(identityPath, "# Identity", { description: "User identity", tags: ["profile"] });
  writeMemoryFile(roadmapPath, "# Roadmap", { description: "Release roadmap", tags: ["release"] });

  const pi = createMockPi((command, args) => {
    if (command === "grep") {
      const pattern = args[5];
      if (pattern === "^\\s*-\\s*release") {
        return { stdout: `${roadmapPath}:3:- release\n` };
      }
      if (pattern === "^description:\\s*.*release") {
        return { stdout: `${roadmapPath}:2:description: Release roadmap\n` };
      }
      if (pattern === "road") {
        return { stdout: `${roadmapPath}:5:# Roadmap\n` };
      }
    }

    if (command === "rg" && args[4] === "identity") {
      return { stdout: `${identityPath}:4:# Identity\n` };
    }

    return { stdout: "" };
  });

  registerMemorySearch(pi as never, settings);

  const queryResult = (await executeTool(pi, "memory_search", { query: "release" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { files?: string[]; count?: number };
  };
  const grepResult = (await executeTool(pi, "memory_search", { grep: "road" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { count?: number };
  };
  const rgResult = (await executeTool(pi, "memory_search", { rg: "identity" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { files?: string[]; count?: number };
  };
  const emptyResult = (await executeTool(pi, "memory_search", { query: "missing" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { count?: number };
  };

  assert.equal(queryResult.details?.count, 1);
  assert.deepEqual(queryResult.details?.files, ["core/project/roadmap.md"]);
  assert.match(queryResult.content[0]?.text ?? "", /## Tags matching: release/);
  assert.match(queryResult.content[0]?.text ?? "", /## Description matching: release/);

  assert.equal(grepResult.details?.count, 1);
  assert.match(grepResult.content[0]?.text ?? "", /## Custom grep: road/);

  assert.equal(rgResult.details?.count, 1);
  assert.deepEqual(rgResult.details?.files, ["core/user/identity.md"]);
  assert.match(rgResult.content[0]?.text ?? "", /## Custom ripgrep: identity/);

  assert.equal(emptyResult.details?.count, 0);
  assert.match(emptyResult.content[0]?.text ?? "", /No results found for "missing"/);
});

test("memory_search passes timeout and max-result limits to grep and rg", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-search-timeout");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const calls: Array<{ command: string; args: string[]; hasSignal: boolean }> = [];

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", { description: "Identity" });

  const pi = createMockPi((command, args, options) => {
    calls.push({ command, args, hasSignal: Boolean(options?.signal) });
    return { stdout: "" };
  });

  registerMemorySearch(pi as never, settings);

  await executeTool(pi, "memory_search", { grep: "identity" }, projectDir);
  await executeTool(pi, "memory_search", { rg: "identity" }, projectDir);

  assert.equal(calls[0]?.command, "grep");
  assert.deepEqual(calls[0]?.args.slice(0, 6), ["-rn", "--include=*.md", "-m", "50", "-E", "identity"]);
  assert.equal(calls[0]?.hasSignal, true);
  assert.equal(calls[1]?.command, "rg");
  assert.deepEqual(calls[1]?.args.slice(0, 5), ["-t", "md", "-m", "50", "identity"]);
  assert.equal(calls[1]?.hasSignal, true);
});

// ============================================================================
// _shared / cross-project sharing tests
// ============================================================================

test("memory_read reads a _shared file via _shared/... path", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read-shared");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };

  writeMemoryFile(path.join(settings.localPath, "_shared", "core", "user", "prefer.md"), "shared-body", {
    description: "Shared prefer",
    tags: ["user"],
  });

  const pi = createMockPi();
  registerMemoryRead(pi as never, settings);

  const result = (await executeTool(pi, "memory_read", { path: "_shared/core/user/prefer.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.equal(result.details?.error, undefined);
  assert.match(result.content[0]?.text ?? "", /Shared prefer/);
  assert.match(result.content[0]?.text ?? "", /shared-body/);
});

test("memory_read reads an included-project file via <project>/... path", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read-included");
  const projectDir = path.join(tempDir, "project");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
    includeProjects: ["other-proj"],
  };

  writeMemoryFile(path.join(settings.localPath, "other-proj", "core", "user", "note.md"), "included-body", {
    description: "Other note",
  });

  const pi = createMockPi();
  registerMemoryRead(pi as never, settings);

  const result = (await executeTool(pi, "memory_read", { path: "other-proj/core/user/note.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.equal(result.details?.error, undefined);
  assert.match(result.content[0]?.text ?? "", /included-body/);
});

test("memory_read rejects traversal in _shared fallback", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read-shared-escape");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };

  fs.mkdirSync(path.join(tempDir, "outside"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "outside.md"), "---\ndescription: out\n---\nboom");

  const pi = createMockPi();
  registerMemoryRead(pi as never, settings);

  const result = (await executeTool(pi, "memory_read", { path: "../../outside.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.equal(result.details?.error, true);
  assert.doesNotMatch(result.content[0]?.text ?? "", /boom/);
});

test("memory_read rejects symlink inside _shared", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-read-shared-symlink");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const sharedBase = path.join(settings.localPath, "_shared");
  const outsideFile = path.join(tempDir, "secret.md");
  const linkPath = path.join(sharedBase, "core", "user", "linked.md");

  writeMemoryFile(outsideFile, "secret", { description: "Secret" });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(outsideFile, linkPath);

  const pi = createMockPi();
  registerMemoryRead(pi as never, settings);

  const result = (await executeTool(pi, "memory_read", { path: "_shared/core/user/linked.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.equal(result.details?.error, true);
  assert.match(result.content[0]?.text ?? "", /Invalid memory path/);
});

test("memory_write shared=true writes into _shared/", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write-shared");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_write",
    {
      path: "core/user/prefer.md",
      content: "# Shared Prefer",
      description: "Shared prefer",
      shared: true,
    },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { shared?: boolean } };

  const sharedPath = path.join(settings.localPath, "_shared", "core", "user", "prefer.md");
  assert.equal(result.details?.shared, true);
  assert.match(result.content[0]?.text ?? "", /_shared\/core\/user\/prefer\.md/);
  assert.ok(fs.existsSync(sharedPath));
  const written = await readMemoryFileAsync(sharedPath);
  assert.equal(written?.frontmatter.description, "Shared prefer");
});

test("memory_write shared=true rejects traversal", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write-shared-escape");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_write",
    { path: "../escape.md", content: "x", description: "bad", shared: true },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { error?: boolean } };

  assert.equal(result.details?.error, true);
  assert.match(result.content[0]?.text ?? "", /Invalid memory path/);
});

test("memory_list merges project + _shared + included paths with stable keys", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list-shared");
  const projectDir = path.join(tempDir, "project");
  const settings = {
    localPath: path.join(tempDir, "memory-root"),
    includeProjects: ["other-proj"],
  };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity",
  });
  writeMemoryFile(path.join(settings.localPath, "_shared", "core", "user", "prefer.md"), "# Shared", {
    description: "Shared",
  });
  writeMemoryFile(path.join(settings.localPath, "other-proj", "core", "user", "note.md"), "# Other", {
    description: "Other",
  });

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  const result = (await executeTool(pi, "memory_list", {}, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { files?: string[]; count?: number };
  };

  assert.equal(result.details?.count, 3);
  assert.deepEqual([...(result.details?.files ?? [])].sort(), [
    "_shared/core/user/prefer.md",
    "core/user/identity.md",
    "other-proj/core/user/note.md",
  ]);
  assert.match(result.content[0]?.text ?? "", /Project:/);
  assert.match(result.content[0]?.text ?? "", /Shared:/);
});

test("memory_list rejects traversal in shared scope via directory param", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list-shared-escape");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  // Project dir must exist so the tool returns an explicit error rather than
  // silently returning zero project matches.
  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity",
  });
  fs.mkdirSync(path.join(settings.localPath, "_shared", "core"), { recursive: true });

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  const result = (await executeTool(pi, "memory_list", { directory: "../../etc" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { error?: boolean };
  };

  assert.equal(result.details?.error, true);
  assert.match(result.content[0]?.text ?? "", /Invalid memory directory/);
});

test("memory_delete removes project file and prunes empty parents", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-delete-project");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const filePath = path.join(memoryDir, "core", "user", "note.md");

  writeMemoryFile(filePath, "# Note", { description: "Note" });

  const pi = createMockPi();
  registerMemoryDelete(pi as never, settings);

  const result = (await executeTool(pi, "memory_delete", { path: "core/user/note.md" }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { deleted?: boolean };
  };

  assert.equal(result.details?.deleted, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(path.dirname(filePath)), false);
  // Should stop at memoryDir (never remove memoryDir itself).
  assert.equal(fs.existsSync(memoryDir), true);
});

test("memory_delete shared=true removes from _shared", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-delete-shared");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const sharedFile = path.join(settings.localPath, "_shared", "core", "user", "prefer.md");

  writeMemoryFile(sharedFile, "# Prefer", { description: "Prefer" });

  const pi = createMockPi();
  registerMemoryDelete(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_delete",
    { path: "core/user/prefer.md", shared: true },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { deleted?: boolean; shared?: boolean } };

  assert.equal(result.details?.shared, true);
  assert.equal(fs.existsSync(sharedFile), false);
});

test("memory_delete rejects traversal and symlinks", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-delete-escape");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const outsideFile = path.join(tempDir, "secret.md");
  const linkPath = path.join(memoryDir, "core", "user", "linked.md");

  writeMemoryFile(outsideFile, "secret", { description: "Secret" });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(outsideFile, linkPath);

  const pi = createMockPi();
  registerMemoryDelete(pi as never, settings);

  const traversal = (await executeTool(pi, "memory_delete", { path: "../../outside.md" }, projectDir)) as {
    details?: { error?: boolean };
  };
  assert.equal(traversal.details?.error, true);

  const symlinkAttempt = (await executeTool(pi, "memory_delete", { path: "core/user/linked.md" }, projectDir)) as {
    details?: { error?: boolean };
  };
  assert.equal(symlinkAttempt.details?.error, true);
  // Target of symlink must still exist after the refused delete.
  assert.equal(fs.existsSync(outsideFile), true);
});

test("memory_move moves a file and prunes empty source parents", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-move-basic");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const srcPath = path.join(memoryDir, "core", "user", "note.md");
  const dstPath = path.join(memoryDir, "core", "project", "moved.md");

  writeMemoryFile(srcPath, "# Note", { description: "Note" });

  const pi = createMockPi();
  registerMemoryMove(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_move",
    { from: "core/user/note.md", to: "core/project/moved.md" },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { from?: string; to?: string } };

  assert.equal(result.details?.from, "core/user/note.md");
  assert.equal(result.details?.to, "core/project/moved.md");
  assert.equal(fs.existsSync(srcPath), false);
  assert.equal(fs.existsSync(path.dirname(srcPath)), false);
  assert.equal(fs.existsSync(dstPath), true);
});

test("memory_move project -> _shared with toShared", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-move-to-shared");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const srcPath = path.join(memoryDir, "core", "user", "prefer.md");
  const dstPath = path.join(settings.localPath, "_shared", "core", "user", "prefer.md");

  writeMemoryFile(srcPath, "# Prefer", { description: "Prefer" });

  const pi = createMockPi();
  registerMemoryMove(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_move",
    { from: "core/user/prefer.md", to: "core/user/prefer.md", toShared: true },
    projectDir,
  )) as { details?: { from?: string; to?: string } };

  assert.equal(result.details?.from, "core/user/prefer.md");
  assert.equal(result.details?.to, "_shared/core/user/prefer.md");
  assert.equal(fs.existsSync(srcPath), false);
  assert.equal(fs.existsSync(dstPath), true);
});

test("memory_move refuses to overwrite existing destination", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-move-exists");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));
  const srcPath = path.join(memoryDir, "core", "user", "a.md");
  const dstPath = path.join(memoryDir, "core", "user", "b.md");

  writeMemoryFile(srcPath, "# A", { description: "A" });
  writeMemoryFile(dstPath, "# B", { description: "B" });

  const pi = createMockPi();
  registerMemoryMove(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_move",
    { from: "core/user/a.md", to: "core/user/b.md" },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { error?: boolean } };

  assert.equal(result.details?.error, true);
  assert.match(result.content[0]?.text ?? "", /Destination exists/);
  // Both files should remain untouched.
  assert.equal(fs.existsSync(srcPath), true);
  assert.equal(fs.existsSync(dstPath), true);
});

test("memory_move rejects traversal source and destination", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-move-escape");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "a.md"), "# A", {
    description: "A",
  });

  const pi = createMockPi();
  registerMemoryMove(pi as never, settings);

  const badSrc = (await executeTool(
    pi,
    "memory_move",
    { from: "../../escape.md", to: "core/user/b.md" },
    projectDir,
  )) as { details?: { error?: boolean } };
  assert.equal(badSrc.details?.error, true);

  const badDst = (await executeTool(
    pi,
    "memory_move",
    { from: "core/user/a.md", to: "../../escape.md" },
    projectDir,
  )) as { details?: { error?: boolean } };
  assert.equal(badDst.details?.error, true);
});

// ============================================================================
// Scope-prefix guards (prevent _shared/_shared/ nesting)
// ============================================================================

test("memory_write shared=true rejects path prefixed with _shared/", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write-shared-nested");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_write",
    {
      path: "_shared/core/user/prefer.md",
      content: "x",
      description: "nested",
      shared: true,
    },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { error?: boolean } };

  assert.equal(result.details?.error, true);
  assert.match(result.content[0]?.text ?? "", /Do not prefix path with "_shared\/"/);

  // Confirm nothing was written to disk.
  const nested = path.join(settings.localPath, "_shared", "_shared", "core", "user", "prefer.md");
  assert.equal(fs.existsSync(nested), false);
});

test("memory_write shared=true also rejects leading slash + _shared/ and backslash variants", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-write-shared-variants");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  for (const bad of ["/_shared/core/x.md", "_shared\\core\\x.md"]) {
    const result = (await executeTool(
      pi,
      "memory_write",
      { path: bad, content: "x", description: "nested", shared: true },
      projectDir,
    )) as { details?: { error?: boolean } };
    assert.equal(result.details?.error, true, `should reject ${bad}`);
  }
});

test("memory_write without shared=true still allows a literal _shared/ subdirectory in the current project", async () => {
  // Edge case: a project may have an unrelated directory literally named
  // `_shared`. That's fine as long as shared=true is NOT set.
  const tempDir = createTempDir("pi-memory-md-tools-write-shared-false");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  const pi = createMockPi();
  registerMemoryWrite(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_write",
    {
      path: "_shared/notes.md",
      content: "# ok",
      description: "project-local _shared",
    },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { error?: boolean } };

  assert.equal(result.details?.error, undefined);
  assert.ok(fs.existsSync(path.join(memoryDir, "_shared", "notes.md")));
});

test("memory_move toShared=true rejects destination prefixed with _shared/", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-move-nested");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "prefer.md"), "# P", {
    description: "Prefer",
  });

  const pi = createMockPi();
  registerMemoryMove(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_move",
    {
      from: "core/user/prefer.md",
      to: "_shared/core/user/prefer.md",
      toShared: true,
    },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { error?: boolean } };

  assert.equal(result.details?.error, true);
  assert.match(result.content[0]?.text ?? "", /Do not prefix destination with "_shared\/"/);

  // Source untouched.
  assert.equal(fs.existsSync(path.join(memoryDir, "core", "user", "prefer.md")), true);
});

test("memory_move fromShared=true tolerates source inside legacy _shared/_shared/ (for cleanup)", async () => {
  // The guard deliberately does not block fromShared sources so stray legacy\n  // files under <shared>/_shared/... remain movable into canonical locations.
  const tempDir = createTempDir("pi-memory-md-tools-move-legacy-cleanup");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const legacySrc = path.join(settings.localPath, "_shared", "_shared", "core", "user", "stray.md");
  const canonicalDst = path.join(settings.localPath, "_shared", "core", "user", "stray.md");

  writeMemoryFile(legacySrc, "# Stray", { description: "Stray" });

  const pi = createMockPi();
  registerMemoryMove(pi as never, settings);

  const result = (await executeTool(
    pi,
    "memory_move",
    {
      from: "_shared/core/user/stray.md",
      to: "core/user/stray.md",
      fromShared: true,
      toShared: true,
    },
    projectDir,
  )) as { content: Array<{ text?: string }>; details?: { error?: boolean; from?: string; to?: string } };

  assert.equal(result.details?.error, undefined);
  assert.equal(fs.existsSync(legacySrc), false);
  assert.equal(fs.existsSync(canonicalDst), true);
});

// ============================================================================
// Hot vs cold tier listing (includeCold)
// ============================================================================

test("memory_list defaults to core/ (hot tier) and ignores warehouse files", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list-tier-default");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity",
  });
  writeMemoryFile(path.join(memoryDir, "notes", "random.md"), "# Random", {
    description: "Random",
  });
  writeMemoryFile(path.join(memoryDir, "archive", "old.md"), "# Old", {
    description: "Old",
  });
  writeMemoryFile(path.join(settings.localPath, "_shared", "core", "user", "prefer.md"), "# Prefer", {
    description: "Prefer",
  });
  writeMemoryFile(path.join(settings.localPath, "_shared", "techniques", "cold-tech.md"), "# Tech", {
    description: "Tech",
  });

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  const result = (await executeTool(pi, "memory_list", {}, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { files?: string[]; count?: number; tier?: string };
  };

  assert.equal(result.details?.tier, "core");
  assert.equal(result.details?.count, 2);
  assert.deepEqual([...(result.details?.files ?? [])].sort(), ["_shared/core/user/prefer.md", "core/user/identity.md"]);
  assert.doesNotMatch(result.content[0]?.text ?? "", /notes\/random\.md/);
  assert.doesNotMatch(result.content[0]?.text ?? "", /archive\/old\.md/);
  assert.doesNotMatch(result.content[0]?.text ?? "", /techniques\/cold-tech\.md/);
  assert.match(result.content[0]?.text ?? "", /Pass includeCold=true/);
});

test("memory_list includeCold=true also lists warehouse files outside core/", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list-tier-cold");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity",
  });
  writeMemoryFile(path.join(memoryDir, "notes", "random.md"), "# Random", {
    description: "Random",
  });
  writeMemoryFile(path.join(settings.localPath, "_shared", "techniques", "cold-tech.md"), "# Tech", {
    description: "Tech",
  });

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  const result = (await executeTool(pi, "memory_list", { includeCold: true }, projectDir)) as {
    content: Array<{ text?: string }>;
    details?: { files?: string[]; count?: number; tier?: string };
  };

  assert.equal(result.details?.tier, "all");
  assert.equal(result.details?.count, 3);
  assert.deepEqual([...(result.details?.files ?? [])].sort(), [
    "_shared/techniques/cold-tech.md",
    "core/user/identity.md",
    "notes/random.md",
  ]);
  assert.doesNotMatch(result.content[0]?.text ?? "", /Pass includeCold=true/);
});

test("memory_list directory filter bypasses tier gating", async () => {
  const tempDir = createTempDir("pi-memory-md-tools-list-tier-directory");
  const projectDir = path.join(tempDir, "project");
  const settings = { localPath: path.join(tempDir, "memory-root") };
  const memoryDir = path.join(settings.localPath, path.basename(projectDir));

  writeMemoryFile(path.join(memoryDir, "notes", "a.md"), "# A", { description: "A" });
  writeMemoryFile(path.join(memoryDir, "notes", "b.md"), "# B", { description: "B" });
  writeMemoryFile(path.join(memoryDir, "core", "user", "identity.md"), "# Identity", {
    description: "Identity",
  });

  const pi = createMockPi();
  registerMemoryList(pi as never, settings);

  // Explicit directory=notes should list the warehouse files even without includeCold.
  const result = (await executeTool(pi, "memory_list", { directory: "notes" }, projectDir)) as {
    details?: { files?: string[]; count?: number };
  };

  assert.equal(result.details?.count, 2);
  assert.deepEqual([...(result.details?.files ?? [])].sort(), ["notes/a.md", "notes/b.md"]);
});
