// Covers keyword handoff detection, conversation trimming, and memory file selection/context output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { writeMemoryFile } from "../memory-core.js";
import { ConversationSelector, MemoryFileSelector, matchesDefaultIgnoredPath } from "../tape/tape-selector.js";
import { hoursAgoIso, toTimestamp } from "../utils.js";
import { createTempDir } from "./test-helpers.js";

type MockAnchor = {
  type: string;
  timestamp: string;
  meta?: { trigger?: string };
};

type MockTapeService = {
  query: (options: Record<string, unknown>) => SessionEntry[];
  getAnchorStore: () => { search: (options: Record<string, unknown>) => MockAnchor[] };
};

function createMessageEntry(timestamp: string, role: "user" | "assistant", content: unknown): SessionEntry {
  return {
    type: "message",
    timestamp,
    id: crypto.randomUUID(),
    parentId: null,
    message: { role, content },
  } as SessionEntry;
}

function createToolResultEntry(
  timestamp: string,
  toolCallId: string,
  toolName: string,
  details?: Record<string, unknown>,
): SessionEntry {
  return {
    type: "message",
    timestamp,
    id: crypto.randomUUID(),
    parentId: null,
    message: { role: "toolResult", toolCallId, toolName, details, content: [] },
  } as unknown as SessionEntry;
}

function createMockTapeService(entries: SessionEntry[], anchors: MockAnchor[] = []): MockTapeService {
  return {
    query(options) {
      if (options.scope === "session") {
        return entries;
      }

      if (typeof options.since === "string") {
        const sinceTime = toTimestamp(options.since);
        return entries.filter((entry) => toTimestamp(entry.timestamp) >= sinceTime);
      }

      return entries;
    },
    getAnchorStore() {
      return {
        search(options) {
          const sinceTime = typeof options.since === "string" ? toTimestamp(options.since) : -Infinity;
          return anchors.filter((anchor) => toTimestamp(anchor.timestamp) >= sinceTime);
        },
      };
    },
  };
}

test("ConversationSelector respects maxEntries and token budget", () => {
  const entries = [
    createMessageEntry("2026-04-23T10:00:00.000Z", "user", "first"),
    createMessageEntry("2026-04-23T10:01:00.000Z", "assistant", "second"),
    createMessageEntry("2026-04-23T10:02:00.000Z", "user", "x".repeat(220)),
    createMessageEntry("2026-04-23T10:03:00.000Z", "assistant", "tail"),
  ];
  const selector = new ConversationSelector(createMockTapeService(entries) as never, 40, 3);

  const selected = selector.selectFromAnchor("anchor-1");

  assert.deepEqual(
    selected.map((entry) => (entry as { message: { content: string } }).message.content),
    ["tail"],
  );
});

test("ConversationSelector builds formatted context from visible entry lines", () => {
  const entries = [
    createMessageEntry("2026-04-23T10:00:00.000Z", "user", "hello"),
    {
      type: "compaction",
      timestamp: "2026-04-23T10:01:00.000Z",
      id: crypto.randomUUID(),
      summary: "summarized work",
    } as SessionEntry,
  ];
  const selector = new ConversationSelector(createMockTapeService(entries) as never);

  const context = selector.buildFormattedContext(entries);

  assert.match(context, /User: hello/);
  assert.match(context, /\[Compaction\] summarized work/);
  assert.match(context, /---/);
});

test("MemoryFileSelector recent-only returns newest core markdown files", async () => {
  const tempDir = createTempDir("pi-memory-md-selector-recent");
  const memoryDir = path.join(tempDir, "memory");
  const projectRoot = path.join(tempDir, "project");
  const tapeService = createMockTapeService([]);
  const selector = new MemoryFileSelector(tapeService as never, memoryDir, projectRoot);

  const olderFile = path.join(memoryDir, "core", "user", "identity.md");
  const newerFile = path.join(memoryDir, "core", "project", "roadmap.md");
  const hiddenFile = path.join(memoryDir, "core", ".hidden.md");
  const referenceFile = path.join(memoryDir, "reference", "ignore.md");

  writeMemoryFile(olderFile, "# Identity", { description: "Identity", tags: ["user"] });
  writeMemoryFile(newerFile, "# Roadmap", { description: "Roadmap", tags: ["project"] });
  writeMemoryFile(hiddenFile, "# Hidden", { description: "Hidden" });
  writeMemoryFile(referenceFile, "# Ignore", { description: "Ignore" });

  const oldTime = new Date("2026-04-23T10:00:00.000Z");
  const newTime = new Date("2026-04-23T12:00:00.000Z");
  fs.utimesSync(olderFile, oldTime, oldTime);
  fs.utimesSync(newerFile, newTime, newTime);

  const files = await selector.selectFilesForContext("recent-only", 2);

  assert.deepEqual(files, ["core/project/roadmap.md", "core/user/identity.md"]);
});

test("matchesDefaultIgnoredPath ignores common noise files and directories", () => {
  assert.equal(matchesDefaultIgnoredPath("/tmp/project/node_modules/pkg/index.js", "/tmp/project"), true);
  assert.equal(matchesDefaultIgnoredPath("/tmp/project/.git/config", "/tmp/project"), true);
  assert.equal(matchesDefaultIgnoredPath("/tmp/project/package-lock.json", "/tmp/project"), true);
  assert.equal(matchesDefaultIgnoredPath("/tmp/project/src/index.ts", "/tmp/project"), false);
});

test("MemoryFileSelector smart mode prioritizes frequently accessed memory files", async () => {
  const tempDir = createTempDir("pi-memory-md-selector-smart");
  const memoryDir = path.join(tempDir, "memory");
  const projectRoot = path.join(tempDir, "project");
  const hotFile = "core/user/hot.md";
  const coldFile = "core/user/cold.md";

  writeMemoryFile(path.join(memoryDir, hotFile), "# Hot", { description: "Hot", tags: ["hot"] });
  writeMemoryFile(path.join(memoryDir, coldFile), "# Cold", { description: "Cold", tags: ["cold"] });

  const entries = [
    // createMessageEntry(hoursAgoIso(5.5), "assistant", [
    //   { type: "toolCall", name: "memory_read", arguments: { path: hotFile } },
    // ]),
    createMessageEntry(hoursAgoIso(5), "assistant", [
      { type: "toolCall", name: "memory_write", arguments: { path: hotFile } },
    ]),
    // createMessageEntry(hoursAgoIso(4.5), "assistant", [
    //   { type: "toolCall", name: "memory_read", arguments: { path: hotFile } },
    // ]),
    // createMessageEntry(hoursAgoIso(4), "assistant", [
    //   { type: "toolCall", name: "memory_read", arguments: { path: hotFile } },
    // ]),
    // createMessageEntry(hoursAgoIso(3.5), "assistant", [
    //   { type: "toolCall", name: "memory_read", arguments: { path: coldFile } },
    // ]),
    createMessageEntry(hoursAgoIso(3), "assistant", [
      { type: "toolCall", name: "memory_write", arguments: { path: hotFile } },
    ]),
    createMessageEntry(hoursAgoIso(2), "assistant", [
      { type: "toolCall", name: "memory_write", arguments: { path: coldFile } },
    ]),
  ];
  const selector = new MemoryFileSelector(createMockTapeService(entries) as never, memoryDir, projectRoot);

  const files = await selector.selectFilesForContext("smart", 2, { memoryScan: [6, 6] });

  assert.deepEqual(files, [hotFile, coldFile]);
});

test("MemoryFileSelector smart mode filters common ignored project files", async () => {
  const tempDir = createTempDir("pi-memory-md-selector-ignore");
  const memoryDir = path.join(tempDir, "memory");
  const projectRoot = path.join(tempDir, "project");
  const srcFile = path.join(projectRoot, "src", "index.ts");
  const ignoredFile = path.join(projectRoot, "node_modules", "pkg", "index.js");

  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(srcFile, "export const ok = true;\n");
  fs.writeFileSync(ignoredFile, "module.exports = true;\n");
  spawnSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });

  const entries = [
    createMessageEntry(hoursAgoIso(5), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
    ]),
    createMessageEntry(hoursAgoIso(4.5), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "node_modules/pkg/index.js" } },
    ]),
    createMessageEntry(hoursAgoIso(4), "assistant", [
      { type: "toolCall", name: "edit", arguments: { path: "src/index.ts" } },
    ]),
    createMessageEntry(hoursAgoIso(3.5), "assistant", [
      { type: "toolCall", name: "edit", arguments: { path: "node_modules/pkg/index.js" } },
    ]),
    createMessageEntry(hoursAgoIso(3), "assistant", [
      { type: "toolCall", name: "write", arguments: { path: "src/index.ts" } },
    ]),
  ];

  const selector = new MemoryFileSelector(createMockTapeService(entries) as never, memoryDir, projectRoot);
  const files = await selector.selectFilesForContext("smart", 5, { memoryScan: [6, 6] });

  assert.deepEqual(files, [srcFile]);
});

test("MemoryFileSelector finalizeContextFiles applies whitelist and blacklist", async () => {
  const tempDir = createTempDir("pi-memory-md-selector-lists");
  const memoryDir = path.join(tempDir, "memory");
  const projectRoot = path.join(tempDir, "project");
  const memoryFile = path.join(memoryDir, "core", "user", "identity.md");
  const whitelistedFile = path.join(projectRoot, "docs", "guide.md");
  const blacklistedFile = path.join(projectRoot, "dist", "bundle.js");

  writeMemoryFile(memoryFile, "# Identity", { description: "Identity", tags: ["user"] });
  fs.mkdirSync(path.dirname(whitelistedFile), { recursive: true });
  fs.mkdirSync(path.dirname(blacklistedFile), { recursive: true });
  fs.writeFileSync(whitelistedFile, "# Guide\n");
  fs.writeFileSync(blacklistedFile, "console.log('bundle');\n");

  const selector = new MemoryFileSelector(createMockTapeService([]) as never, memoryDir, projectRoot, {
    whitelist: ["docs"],
    blacklist: ["dist"],
  });
  const files = await selector.finalizeContextFiles([memoryFile, blacklistedFile]);

  assert.deepEqual(files, [whitelistedFile, memoryFile]);
});

test("MemoryFileSelector buildContextFromFilesAsync renders highlights and line ranges", async () => {
  const tempDir = createTempDir("pi-memory-md-selector-context");
  const memoryDir = path.join(tempDir, "memory");
  const projectRoot = path.join(tempDir, "project");
  const projectFile = path.join(projectRoot, "src", "index.ts");
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, "export const ok = true;\n");

  const memoryPath = path.join(memoryDir, "core", "user", "identity.md");
  writeMemoryFile(memoryPath, "# Identity", { description: "Identity", tags: ["user", "profile"] });

  const editToolCallId = crypto.randomUUID();
  const entries = [
    // createMessageEntry(hoursAgoIso(5), "assistant", [
    //   { type: "toolCall", name: "memory_read", arguments: { path: "core/user/identity.md", offset: 3, limit: 4 } },
    // ]),
    createMessageEntry(hoursAgoIso(4), "assistant", [
      { type: "toolCall", id: editToolCallId, name: "edit", arguments: { path: "src/index.ts" } },
    ]),
    createToolResultEntry(hoursAgoIso(3.5), editToolCallId, "edit", {
      firstChangedLine: 12,
      diff: "      ...\n  12 \tconst before = true;\n+ 13 \tconst after = true;\n  14 \treturn after;\n      ...",
    }),
    createMessageEntry(hoursAgoIso(3), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 20, limit: 3 } },
    ]),
  ];

  const selector = new MemoryFileSelector(createMockTapeService(entries) as never, memoryDir, projectRoot);
  const context = await selector.buildContextFromFilesAsync([memoryPath, projectFile], {
    highlightedFiles: [memoryPath, projectFile],
    lineRangeHours: 6,
  });

  assert.match(context, /<memory_context mode="tape">/);
  assert.match(context, new RegExp(`- path: ${memoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // assert.match(context, / {2}recent focus: read 3-6/);  // memory_read removed
  assert.match(context, /description: Identity/);
  assert.match(context, /tags: user, profile/);
  assert.match(context, /<active_project_files>/);
  assert.match(context, new RegExp(projectFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(context, / {2}recent focus: read 20-22, edit 12-14/);
  assert.match(context, /priority: high/);
});

test("MemoryFileSelector line ranges follow the effective smart scan window", async () => {
  const tempDir = createTempDir("pi-memory-md-selector-scan-window");
  const memoryDir = path.join(tempDir, "memory");
  const projectRoot = path.join(tempDir, "project");
  const projectFile = path.join(projectRoot, "src", "index.ts");

  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, "export const ok = true;\n");

  const entries = [
    createMessageEntry(hoursAgoIso(20), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 10, limit: 2 } },
    ]),
    createMessageEntry(hoursAgoIso(19), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 20, limit: 2 } },
    ]),
    createMessageEntry(hoursAgoIso(18), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 30, limit: 2 } },
    ]),
    createMessageEntry(hoursAgoIso(17), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 40, limit: 2 } },
    ]),
    createMessageEntry(hoursAgoIso(16), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 50, limit: 2 } },
    ]),
    createMessageEntry(hoursAgoIso(100), "assistant", [
      { type: "toolCall", name: "read", arguments: { path: "src/index.ts", offset: 90, limit: 2 } },
    ]),
  ];

  const selector = new MemoryFileSelector(createMockTapeService(entries) as never, memoryDir, projectRoot);
  const files = await selector.selectFilesForContext("smart", 1, { memoryScan: [24, 120] });
  const context = await selector.buildContextFromFilesAsync(files, {
    highlightedFiles: files,
  });

  assert.deepEqual(files, [projectFile]);
  assert.match(context, /recent focus: read 50-51, read 40-41, read 30-31, read 20-21, read 10-11/);
  assert.doesNotMatch(context, /90-91/);
});
