import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildKeywordHandoffMessage,
  detectKeywordHandoff,
  normalizeTapeKeywords,
  resolveTapeGate,
} from "../tape/tape-gate.js";
import { createTempDir, initGitRepo } from "./test-helpers.js";

test("resolveTapeGate returns disabled when tape is off", () => {
  const cwd = createTempDir("pi-memory-md-activation-disabled");
  const result = resolveTapeGate(cwd, { enabled: false });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "disabled");
  assert.equal(result.project, null);
});

test("resolveTapeGate returns excluded-dir when cwd matches excludedDirs", () => {
  const rootDir = createTempDir("pi-memory-md-activation-excluded");
  const cwd = path.join(rootDir, "project", "nested");
  fs.mkdirSync(cwd, { recursive: true });

  const result = resolveTapeGate(cwd, {
    enabled: true,
    excludeDirs: [rootDir],
  });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "excluded-dir");
  assert.equal(result.matchedExcludeDir, rootDir);
});

test("resolveTapeGate returns missing-git when onlyGit is true outside git repos", () => {
  const cwd = createTempDir("pi-memory-md-activation-no-git");
  const result = resolveTapeGate(cwd, { enabled: true, onlyGit: true });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "missing-git");
});

test("resolveTapeGate resolves the nearest git root when onlyGit is true", () => {
  const tempDir = createTempDir("pi-memory-md-activation-git-root");
  const repoDir = path.join(tempDir, "repo");
  const cwd = path.join(repoDir, "packages", "feature");

  initGitRepo(repoDir);
  fs.mkdirSync(cwd, { recursive: true });

  const result = resolveTapeGate(cwd, { enabled: true, onlyGit: true });

  assert.equal(result.enabled, true);
  assert.equal(result.reason, "enabled");
  assert.equal(result.project?.root, repoDir);
  assert.equal(result.project?.name, "repo");
});

test("resolveTapeGate uses cwd when onlyGit is false outside git repos", () => {
  const cwd = createTempDir("pi-memory-md-activation-cwd-root");
  const result = resolveTapeGate(cwd, { enabled: true, onlyGit: false });

  assert.equal(result.enabled, true);
  assert.equal(result.reason, "enabled");
  assert.equal(result.project?.root, cwd);
  assert.equal(result.project?.name, path.basename(cwd));
});

test("resolveTapeGate still uses git root when onlyGit is false inside a repo", () => {
  const tempDir = createTempDir("pi-memory-md-activation-git-root-optional");
  const repoDir = path.join(tempDir, "repo");
  const cwd = path.join(repoDir, "docs");

  initGitRepo(repoDir);
  fs.mkdirSync(cwd, { recursive: true });

  const result = resolveTapeGate(cwd, { enabled: true, onlyGit: false });

  assert.equal(result.enabled, true);
  assert.equal(result.reason, "enabled");
  assert.equal(result.project?.root, repoDir);
  assert.equal(result.project?.name, "repo");
});

test("normalizeTapeKeywords trims, lowercases, and de-duplicates keywords", () => {
  assert.deepEqual(normalizeTapeKeywords({ global: [" Foo ", "foo", ""], project: [" Bar ", "BAR"] }), {
    global: ["foo"],
    project: ["bar"],
  });
  assert.deepEqual(normalizeTapeKeywords(), { global: [], project: [] });
});

test("detectKeywordHandoff ignores too-short and too-long prompts", () => {
  assert.equal(detectKeywordHandoff("short", { global: ["bug"] }), null);
  assert.equal(detectKeywordHandoff("x".repeat(301), { global: ["bug"] }), null);
});

test("detectKeywordHandoff matches merged keywords case-insensitively with word boundaries", () => {
  const result = detectKeywordHandoff("Please help fix a BUG and review auth flow", {
    global: ["bug"],
    project: ["Auth Flow", "auth"],
  });

  assert.ok(result);
  assert.equal(result?.primary, "auth flow");
  assert.deepEqual(result?.matched, ["auth flow", "auth", "bug"]);
  assert.match(result?.anchorName ?? "", /^handoff\/keyword-auth-flow-\d{6}$/);
  assert.match(result?.message ?? "", /Keyword detected: auth flow\./);
  assert.equal(detectKeywordHandoff("debugging takes time", { global: ["bug"] }), null);
});

test("buildKeywordHandoffMessage returns the generated instruction text", () => {
  const message = buildKeywordHandoffMessage("Please fix this bug today", { global: ["bug"] });

  assert.match(message ?? "", /Before continuing, call tape_handoff/);
  assert.doesNotMatch(message ?? "", /- trigger: "keyword"/);
  assert.doesNotMatch(message ?? "", /- keywords:/);
});
