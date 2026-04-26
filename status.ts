import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MemoryMdSettings } from "./types.js";
import { gitExec } from "./memory-git.js";
import { getMemoryDir, isMemoryInitialized } from "./memory-core.js";

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  diverged: boolean;
  modified: number;
  staged: number;
  untracked: number;
  conflicted: number;
}

async function getMemoryGitStatus(pi: ExtensionAPI, memoryDir: string): Promise<GitStatus | null> {
  const branchResult = await gitExec(pi, memoryDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchResult.success) return null;

  const branch = branchResult.stdout.trim();

  // Check if there's an upstream branch
  const upstreamResult = await gitExec(pi, memoryDir, ["rev-parse", "--abbrev-ref", "@{u}"]);
  const hasUpstream = upstreamResult.success;

  const statusResult = await gitExec(pi, memoryDir, ["status", "--porcelain"]);

  let ahead = 0, behind = 0;
  if (hasUpstream) {
    const [aheadResult, behindResult] = await Promise.all([
      gitExec(pi, memoryDir, ["rev-list", "--count", "@{u}..HEAD"]),
      gitExec(pi, memoryDir, ["rev-list", "--count", "HEAD..@{u}"]),
    ]);
    ahead = Number(aheadResult.stdout.trim() || "0");
    behind = Number(behindResult.stdout.trim() || "0");
  }

  let modified = 0, staged = 0, untracked = 0, conflicted = 0;

  if (statusResult.success && statusResult.stdout.trim()) {
    for (const line of statusResult.stdout.trim().split("\n")) {
      const [index, worktree] = line.slice(0, 2);
      if (index === "U" || worktree === "U") conflicted++;
      else if (index !== " " && index !== "?") staged++;
      else if (worktree !== " " && worktree !== "?") modified++;
      if (index === "?" && worktree === "?") untracked++;
    }
  }

  const diverged = ahead > 0 && behind > 0;

  return { branch, ahead, behind, diverged, modified, staged, untracked, conflicted };
}

function formatGitStatus(status: GitStatus): string {
  const parts: string[] = [];

  if (status.conflicted > 0) parts.push("=");
  if (status.staged > 0) parts.push("+");
  if (status.modified > 0) parts.push("!");
  if (status.untracked > 0) parts.push("?");

  if (status.diverged) {
    parts.push("⇕");
  } else if (status.ahead > 0) {
    parts.push(`⇡${status.ahead > 1 ? status.ahead : ""}`);
  } else if (status.behind > 0) {
    parts.push(`⇣${status.behind > 1 ? status.behind : ""}`);
  }

  return parts.length > 0 ? ` [${parts.join("")}]` : "";
}

export function registerMemoryStatus(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
): void {
  const statusConfig = settings.status;
  if (statusConfig?.enabled === false) return;

  const memoryDir = getMemoryDir(settings, ctx.cwd);
  const initialized = isMemoryInitialized(memoryDir);

  let baseStatus = "Memory ";
  if (!initialized) {
    ctx.ui.setStatus("memory-md", ctx.ui.theme.fg("dim", baseStatus));
    return;
  }

  getMemoryGitStatus(pi, memoryDir).then((gitStatus) => {
    if (!gitStatus) {
      ctx.ui.setStatus("memory-md", ctx.ui.theme.fg("dim", baseStatus));
      return;
    }

    const gitInfo = formatGitStatus(gitStatus);
    ctx.ui.setStatus("memory-md", ctx.ui.theme.fg("dim", `${baseStatus}${gitInfo}`));
  });
}
