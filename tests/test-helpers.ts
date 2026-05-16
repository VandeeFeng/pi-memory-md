import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const tempDirs: string[] = [];

export function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function initGitRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoPath, stdio: "ignore" });
}

export function createSessionManager(entries: SessionEntry[] = [], leafId?: string | null): any {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId ?? entries[entries.length - 1]?.id ?? null,
    getSessionId: () => "session-1",
    getEntry: (id: string) => byId.get(id),
    getEntries: () => entries,
    getLabel: () => undefined,
    labelsById: new Map<string, string>(),
    labelTimestampsById: new Map<string, string>(),
  };
}

export function createUi() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    notify(message: string, level: string) {
      notifications.push({ message, level });
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
