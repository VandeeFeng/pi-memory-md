import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { getProjectMeta } from "../utils.js";
import { createTempDir } from "./test-helpers.js";

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

describe("getProjectMeta", () => {
  it("returns metadata for a regular repository", () => {
    const repoPath = createTempDir("utils-test-regular-repo");
    createGitRepo(repoPath);

    const meta = getProjectMeta(`${repoPath}/`);

    assert.equal(meta.isWorktree, false);
    assert.equal(meta.mainRoot, undefined);
    assert.equal(meta.root, repoPath);
    assert.ok(meta.name.length > 0);
  });

  it("returns metadata for a linked worktree", () => {
    const mainRepoPath = createTempDir("utils-test-main-repo");
    const worktreePath = createTempDir("utils-test-linked-worktree");
    createGitRepo(mainRepoPath);
    createWorktree(mainRepoPath, worktreePath);

    const meta = getProjectMeta(worktreePath);

    assert.equal(meta.isWorktree, true);
    assert.equal(meta.mainRoot, mainRepoPath);
    assert.equal(meta.root, worktreePath);
    assert.ok(meta.name.length > 0);
  });

  it("handles nested path as cwd", () => {
    const repoPath = createTempDir("utils-test-nested");
    const nestedPath = path.join(repoPath, "sub", "nested");
    createGitRepo(repoPath);
    fs.mkdirSync(nestedPath, { recursive: true });

    const meta = getProjectMeta(nestedPath);

    assert.equal(meta.isWorktree, false);
    assert.equal(meta.root, repoPath);
    assert.ok(meta.cwd.endsWith("sub/nested"));
  });
});
