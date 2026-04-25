import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { getProjectMeta } from "../utils.js";
import { createTempDir } from "./test-helpers.js";

const tempDirs: string[] = [];

function createGitRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "test");
  execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });
}

function createWorktree(mainRepoPath: string, worktreePath: string, branch = "worktree-branch"): void {
  execFileSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: mainRepoPath,
    stdio: "ignore",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("getProjectMeta", () => {
  it("returns isWorktree=false for a regular repository", () => {
    const repoPath = createTempDir("utils-test-regular-repo");
    tempDirs.push(repoPath);
    createGitRepo(repoPath);

    const meta = getProjectMeta(repoPath);

    assert.equal(meta.isWorktree, false);
    assert.equal(meta.mainRoot, undefined);
  });

  it("returns isWorktree=true and mainRoot for a linked worktree", () => {
    const mainRepoPath = createTempDir("utils-test-main-repo");
    const worktreePath = createTempDir("utils-test-linked-worktree");
    tempDirs.push(mainRepoPath, worktreePath);
    createGitRepo(mainRepoPath);
    createWorktree(mainRepoPath, worktreePath);

    const meta = getProjectMeta(worktreePath);

    assert.equal(meta.isWorktree, true);
    assert.equal(meta.mainRoot, mainRepoPath);
  });

  it("returns correct name for main repository", () => {
    const repoPath = createTempDir("utils-test-repo-name");
    tempDirs.push(repoPath);
    createGitRepo(repoPath);

    const meta = getProjectMeta(repoPath);

    assert.ok(meta.name.length > 0);
    assert.equal(meta.root, repoPath);
  });

  it("returns correct name for linked worktree", () => {
    const mainRepoPath = createTempDir("utils-test-main-repo-name");
    const worktreePath = createTempDir("utils-test-worktree-name");
    tempDirs.push(mainRepoPath, worktreePath);
    createGitRepo(mainRepoPath);
    createWorktree(mainRepoPath, worktreePath);

    const meta = getProjectMeta(worktreePath);

    assert.ok(meta.name.length > 0);
    assert.equal(meta.root, worktreePath);
  });

  it("handles path with trailing slash", () => {
    const repoPath = createTempDir("utils-test-trailing-slash");
    tempDirs.push(repoPath);
    createGitRepo(repoPath);

    const meta = getProjectMeta(`${repoPath}/`);

    assert.equal(meta.isWorktree, false);
    assert.equal(meta.root, repoPath);
  });

  it("handles nested path as cwd", () => {
    const repoPath = createTempDir("utils-test-nested");
    const nestedPath = path.join(repoPath, "sub", "nested");
    tempDirs.push(repoPath);
    createGitRepo(repoPath);
    fs.mkdirSync(nestedPath, { recursive: true });

    const meta = getProjectMeta(nestedPath);

    assert.equal(meta.isWorktree, false);
    assert.equal(meta.root, repoPath);
    assert.ok(meta.cwd.endsWith("sub/nested"));
  });
});
