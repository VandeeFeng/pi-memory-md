import os from "node:os";
import path from "node:path";

export const DEFAULT_LOCAL_PATH = path.join(os.homedir(), ".pi", "memory-md");
export const DEFAULT_TAPE_DIRNAME = "TAPE";

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function getCurrentDate(): string {
  return nowIso().slice(0, 10);
}

export function toTimestamp(value: string): number {
  return new Date(value).getTime();
}

export function hoursAgoIso(hours: number): string {
  return nowIso(new Date(Date.now() - hours * 60 * 60 * 1000));
}

export function formatCommitTimestamp(date = new Date()): string {
  return nowIso(date).replace(/[:.]/g, "-").slice(0, 19);
}

export function formatTimeSuffix(date = new Date()): string {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${hour}${minute}${second}`;
}

export function expandHomePath(filePath: string): string {
  if (!filePath.startsWith("~")) {
    return filePath;
  }

  return path.join(os.homedir(), filePath.slice(1));
}

export function resolveFrom(root: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
}

export function resolvePathWithin(baseDir: string, relPath: string): string | null {
  const normalizedBaseDir = path.resolve(baseDir);
  const resolvedPath = path.resolve(normalizedBaseDir, relPath);

  if (resolvedPath === normalizedBaseDir || resolvedPath.startsWith(`${normalizedBaseDir}${path.sep}`)) {
    return resolvedPath;
  }

  return null;
}

export function toRelativeIfInside(parentDir: string, targetPath: string): string {
  const normalizedParent = path.resolve(parentDir);
  const normalizedTarget = path.resolve(targetPath);

  return normalizedTarget.startsWith(`${normalizedParent}${path.sep}`)
    ? path.relative(normalizedParent, normalizedTarget)
    : normalizedTarget;
}

export function getProjectName(cwd: string): string {
  return path.basename(cwd);
}

export function getTapeBasePath(localPath: string, tapePath?: string): string {
  return tapePath ? expandHomePath(tapePath) : path.join(localPath, DEFAULT_TAPE_DIRNAME);
}

export function getGitDir(localPath: string): string {
  return path.join(localPath, ".git");
}

export function toLocaleTime(value: string): string {
  return new Date(value).toLocaleTimeString();
}

export function toLocaleDateTime(value: string): string {
  return new Date(value).toLocaleString();
}
