import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildKeywordHandoffMessage,
  detectKeywordHandoff,
  normalizeTapeKeywords,
  resolveTapeActivation,
} from "../tape/tape-gate.js";
import { createTempDir } from "./test-helpers.js";

test("resolveTapeActivation returns disabled when tape is off", () => {
  const cwd = createTempDir("pi-memory-md-activation-disabled");
  const result = resolveTapeActivation(cwd, { enabled: false });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "disabled");
  assert.equal(result.projectRoot, null);
  assert.equal(result.projectName, null);
});

test("resolveTapeActivation returns excluded-dir when cwd matches excludedDirs", () => {
  const rootDir = createTempDir("pi-memory-md-activation-excluded");
  const cwd = path.join(rootDir, "project", "nested");
  fs.mkdirSync(cwd, { recursive: true });

  const result = resolveTapeActivation(cwd, {
    enabled: true,
    excludeDirs: [rootDir],
  });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "excluded-dir");
  assert.equal(result.matchedExcludeDir, rootDir);
});

test("resolveTapeActivation returns missing-git when onlyGit is true outside git repos", () => {
  const cwd = createTempDir("pi-memory-md-activation-no-git");
  const result = resolveTapeActivation(cwd, { enabled: true, onlyGit: true });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "missing-git");
});

test("resolveTapeActivation resolves the nearest git root when onlyGit is true", () => {
  const tempDir = createTempDir("pi-memory-md-activation-git-root");
  const repoDir = path.join(tempDir, "repo");
  const cwd = path.join(repoDir, "packages", "feature");

  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const result = resolveTapeActivation(cwd, { enabled: true, onlyGit: true });

  assert.equal(result.enabled, true);
  assert.equal(result.reason, "enabled");
  assert.equal(result.projectRoot, repoDir);
  assert.equal(result.projectName, "repo");
});

test("resolveTapeActivation uses cwd when onlyGit is false", () => {
  const cwd = createTempDir("pi-memory-md-activation-cwd-root");
  const result = resolveTapeActivation(cwd, { enabled: true, onlyGit: false });

  assert.equal(result.enabled, true);
  assert.equal(result.reason, "enabled");
  assert.equal(result.projectRoot, cwd);
  assert.equal(result.projectName, path.basename(cwd));
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
