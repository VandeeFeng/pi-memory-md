import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { getProjectMeta, isPathInside, listProjectFiles, normalizePathForComparison } from "../utils.js";
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

describe("isPathInside", () => {
  it("returns true when target equals parent", () => {
    const parent = createTempDir("isPathInside-equal");
    assert.ok(isPathInside(parent, parent));
  });

  it("returns true when target is nested under parent", () => {
    const parent = createTempDir("isPathInside-nested");
    const target = path.join(parent, "sub", "nested");
    fs.mkdirSync(target, { recursive: true });
    assert.ok(isPathInside(parent, target));
  });

  it("returns false when target is outside parent", () => {
    const parent = createTempDir("isPathInside-outside");
    const sibling = createTempDir("isPathInside-sibling");
    fs.mkdirSync(sibling, { recursive: true });
    assert.ok(!isPathInside(parent, sibling));
  });

  it("handles paths with or without trailing slash consistently", () => {
    const parent = createTempDir("isPathInside-slash");
    const target = path.join(parent, "file.txt");
    fs.writeFileSync(target, "test");

    const withSlash = parent.endsWith("/") ? parent : `${parent}/`;
    assert.ok(isPathInside(withSlash, target));
    assert.ok(isPathInside(parent, target));
  });
});

describe("normalizePathForComparison", () => {
  it("normalizes path separators and returns lowercase", () => {
    const input = path.join("Users", "test", "project");
    const normalized = normalizePathForComparison(input);
    assert.equal(normalized, normalized.toLowerCase());
    assert.ok(normalized.includes("users"));
    assert.ok(normalized.includes("test"));
    assert.ok(normalized.includes("project"));
  });

  it("produces consistent results for the same directory", () => {
    const repoPath = createTempDir("utils-test-norm-repo");
    createGitRepo(repoPath);

    const normalized1 = normalizePathForComparison(repoPath);
    const normalized2 = normalizePathForComparison(repoPath);
    assert.equal(normalized1, normalized2);
  });

  it("produces same result for resolved and unresolved same path", () => {
    const repoPath = createTempDir("utils-test-norm-resolve");
    createGitRepo(repoPath);

    const withSlash = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
    const normalized = normalizePathForComparison(withSlash);
    assert.equal(normalized, normalizePathForComparison(repoPath));
  });
});

describe("listProjectFiles", () => {
  it("respects ignore rules outside Git and preserves whitespace in filenames", async () => {
    const root = createTempDir("utils-visible-project");
    const names = ["plain.ts", " leading name.ts", "two\nlines.ts"];
    for (const name of names) fs.writeFileSync(path.join(root, name), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n");
    fs.writeFileSync(path.join(root, "ignored.ts"), "ignored fixture");
    const files = await listProjectFiles(root);
    assert.deepEqual(files, new Set(names.map((name) => path.join(root, name))));
  });
});

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
