// Covers git command execution plus sync and push success, failure, and timeout paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gitExec, pushRepository, syncRepository } from "../memory-git.js";
import { createTempDir, initGitRepo } from "./test-helpers.js";

type ExecCall = {
  command: string;
  args: string[];
  options?: { cwd?: string; signal?: AbortSignal };
};

type MockPi = {
  calls: ExecCall[];
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ) => Promise<{ stdout?: string }>;
};

function createMockPi(handler: (call: ExecCall) => Promise<{ stdout?: string }> | { stdout?: string }): MockPi {
  const calls: ExecCall[] = [];

  return {
    calls,
    async exec(command, args, options) {
      const call = { command, args, options };
      calls.push(call);
      return handler(call);
    },
  };
}

test("gitExec returns stdout on success", async () => {
  const pi = createMockPi(() => ({ stdout: "ok\n" }));

  const result = await gitExec(pi as never, "/tmp/project", ["status"]);

  assert.deepEqual(result, { stdout: "ok\n", success: true });
  assert.equal(pi.calls.length, 1);
  assert.deepEqual(pi.calls[0]?.args, ["status"]);
});

test("gitExec returns failure for normal exec errors", async () => {
  const pi = createMockPi(() => {
    throw new Error("boom");
  });

  const result = await gitExec(pi as never, "/tmp/project", ["status"]);

  assert.equal(result.success, false);
  assert.equal(result.timeout, undefined);
  assert.match(result.stdout, /boom/);
});

test("gitExec marks abort errors as timeout", async () => {
  const pi = createMockPi(() => {
    const error = new Error("aborted") as Error & { name: string };
    error.name = "AbortError";
    throw error;
  });

  const result = await gitExec(pi as never, "/tmp/project", ["status"]);

  assert.deepEqual(result, { stdout: "", success: false, timeout: true });
});

test("syncRepository fails when repoUrl is missing", async () => {
  const pi = createMockPi(() => ({ stdout: "unused" }));

  const result = await syncRepository(pi as never, { localPath: "/tmp/memory" });

  assert.deepEqual(result, {
    success: false,
    message: "Git repository URL or local path not configured",
  });
  assert.equal(pi.calls.length, 0);
});

test("syncRepository fails when local directory exists but is not a git repo", async () => {
  const localPath = createTempDir("pi-memory-md-sync-no-git");
  const pi = createMockPi(() => ({ stdout: "unused" }));

  const result = await syncRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: false,
    message: `Directory exists but is not a git repo: ${localPath}`,
  });
  assert.equal(pi.calls.length, 0);
});

test("syncRepository returns already latest when there are no upstream commits to pull", async () => {
  const localPath = createTempDir("pi-memory-md-sync-latest");
  initGitRepo(localPath);
  const pi = createMockPi((call) => {
    const command = call.args.join(" ");
    if (command === "fetch") return { stdout: "" };
    if (command === "rev-parse --abbrev-ref @{u}") return { stdout: "origin/main\n" };
    if (command === "rev-list --count HEAD..@{u}") return { stdout: "0\n" };
    throw new Error(`Unexpected command: ${command}`);
  });

  const result = await syncRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: true,
    message: "[memory] is already latest",
    updated: false,
  });
});

test("syncRepository pulls only when upstream has commits", async () => {
  const localPath = createTempDir("pi-memory-md-sync-behind");
  initGitRepo(localPath);
  let behindChecks = 0;
  const pi = createMockPi((call) => {
    const command = call.args.join(" ");
    if (command === "fetch") return { stdout: "" };
    if (command === "rev-parse --abbrev-ref @{u}") return { stdout: "origin/main\n" };
    if (command === "rev-list --count HEAD..@{u}") {
      behindChecks += 1;
      return { stdout: behindChecks === 1 ? "2\n" : "0\n" };
    }
    if (command === "pull --rebase --autostash") return { stdout: "Updating abc123..def456\n" };
    throw new Error(`Unexpected command: ${command}`);
  });

  const result = await syncRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: true,
    message: "Pulled latest changes from [memory]",
    updated: true,
  });
});

test("syncRepository fails when pull leaves repository behind", async () => {
  const localPath = createTempDir("pi-memory-md-sync-still-behind");
  initGitRepo(localPath);
  const pi = createMockPi((call) => {
    const command = call.args.join(" ");
    if (command === "fetch") return { stdout: "" };
    if (command === "rev-parse --abbrev-ref @{u}") return { stdout: "origin/main\n" };
    if (command === "rev-list --count HEAD..@{u}") return { stdout: "1\n" };
    if (command === "pull --rebase --autostash") return { stdout: "Already up to date.\n" };
    throw new Error(`Unexpected command: ${command}`);
  });

  const result = await syncRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: false,
    message: "Pull did not update [memory], still behind by 1 commit(s)",
    level: "warning",
  });
});

test("syncRepository clones repository when local path does not exist", async () => {
  const rootDir = createTempDir("pi-memory-md-sync-clone");
  const localPath = path.join(rootDir, "memory-repo");
  const pi = createMockPi((call) => {
    if (call.args[0] === "clone") return { stdout: "cloned" };
    throw new Error(`Unexpected command: ${call.args.join(" ")}`);
  });

  const result = await syncRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: true,
    message: "Cloned [memory] successfully",
    updated: true,
  });
  assert.equal(fs.existsSync(localPath), true);
  assert.deepEqual(pi.calls[0]?.args, ["clone", "https://github.com/acme/memory.git", "memory-repo"]);
});

test("pushRepository fails when git repository is not initialized", async () => {
  const localPath = createTempDir("pi-memory-md-push-no-git");
  const pi = createMockPi(() => ({ stdout: "unused" }));

  const result = await pushRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: false,
    message: `Git repository not initialized: ${localPath}`,
  });
  assert.equal(pi.calls.length, 0);
});

test("pushRepository returns already up to date when there are no changes and nothing to push", async () => {
  const localPath = createTempDir("pi-memory-md-push-clean");
  initGitRepo(localPath);
  const pi = createMockPi((call) => {
    const command = call.args.join(" ");
    if (command === "status --porcelain") return { stdout: "" };
    if (command === "rev-parse --abbrev-ref @{u}") return { stdout: "origin/main\n" };
    if (command === "rev-list --count @{u}..HEAD") return { stdout: "0\n" };
    throw new Error(`Unexpected command: ${command}`);
  });

  const result = await pushRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: true,
    message: "[memory] already up to date",
    updated: false,
  });
});

test("pushRepository adds, commits, and pushes when there are local changes", async () => {
  const localPath = createTempDir("pi-memory-md-push-dirty");
  initGitRepo(localPath);
  const pi = createMockPi((call) => {
    const command = call.args.join(" ");
    if (command === "status --porcelain") return { stdout: " M core/user/identity.md\n" };
    if (command === "add .") return { stdout: "" };
    if (call.args[0] === "commit" && call.args[1] === "-m") return { stdout: "[main abc123] Update memory\n" };
    if (command === "push") return { stdout: "done" };
    throw new Error(`Unexpected command: ${command}`);
  });

  const result = await pushRepository(pi as never, {
    localPath,
    repoUrl: "https://github.com/acme/memory.git",
  });

  assert.deepEqual(result, {
    success: true,
    message: "Committed and pushed changes to [memory]",
    updated: true,
  });
  assert.deepEqual(
    pi.calls.map((call) => call.args[0]),
    ["status", "add", "commit", "push"],
  );
  assert.equal(pi.calls[2]?.args[1], "-m");
  assert.match(pi.calls[2]?.args[2] ?? "", /^Update memory - \d{4}-\d{2}-\d{2}-\d{4}$/);
});
