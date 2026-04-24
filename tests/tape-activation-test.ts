import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveTapeActivation } from "../tape/tape-activation.js";
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
