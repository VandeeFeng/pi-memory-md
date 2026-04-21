import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GitResult, MemoryMdSettings, SyncResult } from "./types.js";

const DEFAULT_LOCAL_PATH = path.join(os.homedir(), ".pi", "memory-md");
const TIMEOUT_MS = 10000;
const TIMEOUT_MESSAGE =
  "Unable to connect to GitHub repository, connection timeout (10s). Please check your network connection or try again later.";

function getRepoName(settings: MemoryMdSettings): string {
  if (!settings.repoUrl) return "memory-md";
  const match = settings.repoUrl.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : "memory-md";
}

export async function gitExec(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<GitResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await pi.exec("git", args, { cwd, signal: controller.signal });
    return { stdout: result.stdout || "", success: true };
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string };
    const isTimeout = err?.name === "AbortError" || err?.code === "ABORT_ERR";

    if (isTimeout) {
      return { stdout: "", success: false, timeout: true };
    }

    return { stdout: err?.message || String(error), success: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function syncRepository(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): Promise<SyncResult> {
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const { repoUrl } = settings;

  if (!repoUrl) {
    return { success: false, message: "GitHub repo URL or local path not configured" };
  }

  const repoName = getRepoName(settings);

  if (fs.existsSync(localPath)) {
    const gitDir = path.join(localPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return { success: false, message: `Directory exists but is not a git repo: ${localPath}` };
    }

    const pullResult = await gitExec(pi, localPath, ["pull", "--rebase", "--autostash"]);
    if (pullResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
    if (!pullResult.success) return { success: false, message: pullResult.stdout || "Pull failed" };

    isRepoInitialized.value = true;
    const updated = pullResult.stdout.includes("Updating") || pullResult.stdout.includes("Fast-forward");

    return {
      success: true,
      message: updated ? `Pulled latest changes from [${repoName}]` : `[${repoName}] is already latest`,
      updated,
    };
  }

  fs.mkdirSync(localPath, { recursive: true });

  const memoryDirName = path.basename(localPath);
  const parentDir = path.dirname(localPath);
  const cloneResult = await gitExec(pi, parentDir, ["clone", repoUrl, memoryDirName]);

  if (cloneResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
  if (cloneResult.success) {
    isRepoInitialized.value = true;
    return { success: true, message: `Cloned [${repoName}] successfully`, updated: true };
  }

  return { success: false, message: cloneResult.stdout || "Clone failed" };
}

export async function pushRepository(pi: ExtensionAPI, settings: MemoryMdSettings): Promise<SyncResult> {
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const { repoUrl } = settings;

  if (!repoUrl) {
    return { success: false, message: "GitHub repo URL or local path not configured" };
  }

  if (!fs.existsSync(path.join(localPath, ".git"))) {
    return { success: false, message: `Git repository not initialized: ${localPath}` };
  }

  const repoName = getRepoName(settings);
  const statusResult = await gitExec(pi, localPath, ["status", "--porcelain"]);
  if (!statusResult.success) {
    return { success: false, message: statusResult.stdout || "Git status failed" };
  }

  const hasChanges = statusResult.stdout.trim().length > 0;

  if (hasChanges) {
    const addResult = await gitExec(pi, localPath, ["add", "."]);
    if (!addResult.success) {
      return { success: false, message: addResult.stdout || "Git add failed" };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const commitResult = await gitExec(pi, localPath, ["commit", "-m", `Update memory - ${timestamp}`]);
    if (!commitResult.success) {
      return { success: false, message: commitResult.stdout || "Commit failed" };
    }
  }

  const pushResult = await gitExec(pi, localPath, ["push"]);
  if (pushResult.timeout) {
    return { success: false, message: TIMEOUT_MESSAGE };
  }
  if (!pushResult.success) {
    return { success: false, message: pushResult.stdout || "Push failed" };
  }

  return {
    success: true,
    message: hasChanges ? `Committed and pushed changes to [${repoName}]` : `[${repoName}] already up to date`,
    updated: hasChanges,
  };
}
