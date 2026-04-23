// Covers memory tool read, write, list, and search behavior plus invalid-path handling.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { readMemoryFile, writeMemoryFile } from "../memory-core.js";
import { registerMemoryList, registerMemoryRead, registerMemorySearch, registerMemoryWrite } from "../tools.js";
import { createTempDir } from "./test-helpers.js";

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

type MockPi = {
  tools: Map<string, RegisteredTool>;
  registerTool: (tool: RegisteredTool) => void;
  exec: (command: string, args: string[]) => Promise<{ stdout?: string }>;
};

function createMockPi(
  execHandler?: (command: string, args: string[]) => Promise<{ stdout?: string }> | { stdout?: string },
): MockPi {
  const tools = new Map<string, RegisteredTool>();

  return {
    tools,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec(command, args) {
      if (!execHandler) {
        return { stdout: "" };
      }

      return execHandler(command, args);
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
  const written = readMemoryFile(filePath);

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
  assert.match(allFiles.content[0]?.text ?? "", /Memory files \(2\):/);
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
      const pattern = args[3];
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

    if (command === "rg" && args[2] === "identity") {
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
