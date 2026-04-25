import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GitResult, MemoryMdSettings, SyncResult } from "./types.js";
import { DEFAULT_LOCAL_PATH, formatCommitTimestamp, getProjectMeta } from "./utils.js";

const TIMEOUT_MS = 10000;
const TIMEOUT_MESSAGE =
  "Unable to connect to git repository, connection timeout (10s). Please check your network connection or try again later.";

function getRepoName(settings: MemoryMdSettings): string {
  if (!settings.repoUrl) return "memory-md";
  const match = settings.repoUrl.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : "memory-md";
}

async function hasUpstreamBranch(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const upstreamResult = await gitExec(pi, cwd, ["rev-parse", "--abbrev-ref", "@{u}"]);
  return upstreamResult.success;
}

async function isAlreadyAtUpstream(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  if (!(await hasUpstreamBranch(pi, cwd))) return false;

  const [headResult, trackedResult] = await Promise.all([
    gitExec(pi, cwd, ["rev-parse", "HEAD"]),
    gitExec(pi, cwd, ["rev-parse", "@{u}"]),
  ]);

  return headResult.success && trackedResult.success && headResult.stdout.trim() === trackedResult.stdout.trim();
}

async function hasCommitsToPush(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  if (!(await hasUpstreamBranch(pi, cwd))) return true;

  const aheadResult = await gitExec(pi, cwd, ["rev-list", "--count", "@{u}..HEAD"]);
  if (!aheadResult.success) return true;

  return Number(aheadResult.stdout.trim() || "0") > 0;
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

export async function syncRepository(pi: ExtensionAPI, settings: MemoryMdSettings): Promise<SyncResult> {
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const { repoUrl } = settings;

  if (!repoUrl) {
    return { success: false, message: "Git repository URL or local path not configured" };
  }

  const repoName = getRepoName(settings);

  if (fs.existsSync(localPath)) {
    const project = getProjectMeta(localPath);
    if (project.gitRoot !== project.cwd) {
      return { success: false, message: `Directory exists but is not a git repo: ${localPath}` };
    }

    if (await isAlreadyAtUpstream(pi, localPath)) {
      return { success: true, message: `[${repoName}] is already latest`, updated: false };
    }

    const pullResult = await gitExec(pi, localPath, ["pull", "--rebase", "--autostash"]);
    if (pullResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
    if (!pullResult.success) return { success: false, message: pullResult.stdout || "Pull failed" };

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
    return { success: true, message: `Cloned [${repoName}] successfully`, updated: true };
  }

  return { success: false, message: cloneResult.stdout || "Clone failed" };
}

export async function pushRepository(pi: ExtensionAPI, settings: MemoryMdSettings): Promise<SyncResult> {
  const localPath = settings.localPath ?? DEFAULT_LOCAL_PATH;
  const { repoUrl } = settings;

  if (!repoUrl) {
    return { success: false, message: "Git repository URL or local path not configured" };
  }

  const project = getProjectMeta(localPath);
  if (project.gitRoot !== project.cwd) {
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

    const timestamp = formatCommitTimestamp();
    const commitResult = await gitExec(pi, localPath, ["commit", "-m", `Update memory - ${timestamp}`]);
    if (!commitResult.success) {
      return { success: false, message: commitResult.stdout || "Commit failed" };
    }
  }

  if (!hasChanges && !(await hasCommitsToPush(pi, localPath))) {
    return { success: true, message: `[${repoName}] already up to date`, updated: false };
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
