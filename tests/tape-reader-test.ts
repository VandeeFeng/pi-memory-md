import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { getSessionFilePath, getSessionFilePaths, parseSessionFile } from "../tape/tape-reader.js";
import { createTempDir, writeText } from "./test-helpers.js";

function createMessageEntry(id: string, timestamp: string, content: string): SessionEntry {
  return {
    id,
    type: "message",
    timestamp,
    parentId: null,
    message: { role: "user", content },
  } as SessionEntry;
}

function writeSessionFile(filePath: string, sessionId: string, entries: SessionEntry[]): void {
  const lines = [JSON.stringify({ type: "session", id: sessionId }), ...entries.map((entry) => JSON.stringify(entry))];
  writeText(filePath, `${lines.join("\n")}\n`);
}

test("getSessionFilePaths reuses the cached file list until the directory changes", () => {
  const cwd = createTempDir("pi-memory-md-tape-reader-paths-cwd");
  const agentDir = createTempDir("pi-memory-md-tape-reader-paths-agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const encodedPath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = path.join(agentDir, "sessions", encodedPath);
    fs.mkdirSync(sessionDir, { recursive: true });

    writeSessionFile(path.join(sessionDir, "session-1.jsonl"), "session-1", []);

    const firstPaths = getSessionFilePaths(cwd);
    const secondPaths = getSessionFilePaths(cwd);

    assert.strictEqual(secondPaths, firstPaths);
    assert.equal(firstPaths.length, 1);

    writeSessionFile(path.join(sessionDir, "session-2.jsonl"), "session-2", []);

    const thirdPaths = getSessionFilePaths(cwd);

    assert.notStrictEqual(thirdPaths, firstPaths);
    assert.equal(thirdPaths.length, 2);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("getSessionFilePath reuses cached header lookups and invalidates on header change", () => {
  const cwd = createTempDir("pi-memory-md-tape-reader-header-cwd");
  const agentDir = createTempDir("pi-memory-md-tape-reader-header-agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const encodedPath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = path.join(agentDir, "sessions", encodedPath);
    const filePath = path.join(sessionDir, "session.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });

    writeSessionFile(filePath, "session-1", []);

    const firstMatch = getSessionFilePath(cwd, "session-1");
    const secondMatch = getSessionFilePath(cwd, "session-1");

    assert.equal(firstMatch, filePath);
    assert.equal(secondMatch, filePath);
    assert.equal(getSessionFilePath(cwd, "missing"), null);

    writeSessionFile(filePath, "session-2", []);

    assert.equal(getSessionFilePath(cwd, "session-1"), null);
    assert.equal(getSessionFilePath(cwd, "session-2"), filePath);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("parseSessionFile reuses cached results until the file changes", () => {
  const tempDir = createTempDir("pi-memory-md-tape-reader-cache");
  const filePath = path.join(tempDir, "session.jsonl");
  const firstEntry = createMessageEntry("e1", "2026-04-23T10:00:00.000Z", "first");

  writeSessionFile(filePath, "session-1", [firstEntry]);

  const firstParse = parseSessionFile(filePath);
  const secondParse = parseSessionFile(filePath);

  assert.ok(firstParse);
  assert.strictEqual(secondParse, firstParse);
  assert.equal(firstParse.entries.length, 1);

  const secondEntry = createMessageEntry("e2", "2026-04-23T10:01:00.000Z", "second");
  writeSessionFile(filePath, "session-1", [firstEntry, secondEntry]);

  const thirdParse = parseSessionFile(filePath);

  assert.ok(thirdParse);
  assert.notStrictEqual(thirdParse, firstParse);
  assert.equal(thirdParse.entries.length, 2);
});
