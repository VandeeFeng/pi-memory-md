import path from "node:path";
import { findGitTopLevel, isPathInside } from "../utils.js";
import type { TapeConfig } from "./tape-types.js";

export type TapeActivationReason = "disabled" | "excluded-dir" | "missing-git" | "enabled";

export interface TapeActivationResult {
  enabled: boolean;
  reason: TapeActivationReason;
  cwd: string;
  projectRoot: string | null;
  projectName: string | null;
  matchedExcludeDir?: string;
}

export function findMatchedExcludeDir(cwd: string, excludeDirs: string[]): string | null {
  const currentDir = path.resolve(cwd);

  for (const excludedDir of excludeDirs) {
    if (isPathInside(excludedDir, currentDir)) {
      return path.resolve(excludedDir);
    }
  }

  return null;
}

export function resolveTapeActivation(cwd: string, tape?: TapeConfig): TapeActivationResult {
  const normalizedCwd = path.resolve(cwd);

  if (!tape?.enabled) {
    return {
      enabled: false,
      reason: "disabled",
      cwd: normalizedCwd,
      projectRoot: null,
      projectName: null,
    };
  }

  const matchedExcludeDir = findMatchedExcludeDir(normalizedCwd, tape.excludeDirs ?? []);
  if (matchedExcludeDir) {
    return {
      enabled: false,
      reason: "excluded-dir",
      cwd: normalizedCwd,
      projectRoot: null,
      projectName: null,
      matchedExcludeDir,
    };
  }

  if (tape.onlyGit !== false) {
    const projectRoot = findGitTopLevel(normalizedCwd);
    if (!projectRoot) {
      return {
        enabled: false,
        reason: "missing-git",
        cwd: normalizedCwd,
        projectRoot: null,
        projectName: null,
      };
    }

    return {
      enabled: true,
      reason: "enabled",
      cwd: normalizedCwd,
      projectRoot,
      projectName: path.basename(projectRoot),
    };
  }

  return {
    enabled: true,
    reason: "enabled",
    cwd: normalizedCwd,
    projectRoot: normalizedCwd,
    projectName: path.basename(normalizedCwd),
  };
}
