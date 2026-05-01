import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { expandHomePath, resolveFrom, toTimestamp } from "../utils.js";

const DEFAULT_CACHE_SIZE = 100;

interface FileStatCache<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

class LRUCache<K, V> {
  private cache = new Map<K, V>();
  constructor(private maxSize: number = DEFAULT_CACHE_SIZE) {
    if (maxSize < 1) {
      throw new Error("maxSize must be at least 1");
    }
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

const sessionFilePathsCache = new LRUCache<string, { mtimeMs: number; filePaths: string[] }>();
const sessionFilePathCache = new LRUCache<string, { sessionDirMtimeMs: number; filePath: string | null }>();
const sessionHeaderCache = new LRUCache<string, FileStatCache<SessionHeader | null>>();
const sessionParseCache = new LRUCache<
  string,
  FileStatCache<{ header: SessionHeader; entries: SessionEntry[] } | null>
>();

function getSessionParentDir(cwd: string): string {
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (!sessionDir) {
    return path.join(getAgentDir(), "sessions");
  }

  return resolveFrom(cwd, expandHomePath(sessionDir));
}

function encodeSessionPath(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getSessionDir(cwd: string): string {
  return path.join(getSessionParentDir(cwd), encodeSessionPath(cwd));
}

function getDirectoryMtimeMs(dirPath: string): number | null {
  try {
    return fs.statSync(dirPath).mtimeMs;
  } catch {
    return null;
  }
}

function readSessionHeader(filePath: string): SessionHeader | null {
  try {
    const stat = fs.statSync(filePath);
    const cached = sessionHeaderCache.get(filePath);

    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const firstLine = content.split("\n", 1)[0];
    if (!firstLine) {
      sessionHeaderCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: null });
      return null;
    }

    const header = JSON.parse(firstLine) as SessionHeader;
    const value = header.type === "session" ? header : null;
    sessionHeaderCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    sessionHeaderCache.delete(filePath);
    return null;
  }
}

export function getSessionFilePaths(cwd: string): string[] {
  const sessionDir = getSessionDir(cwd);
  const sessionDirMtimeMs = getDirectoryMtimeMs(sessionDir);
  if (sessionDirMtimeMs === null) {
    sessionFilePathsCache.delete(sessionDir);
    return [];
  }

  const cached = sessionFilePathsCache.get(sessionDir);
  if (cached && cached.mtimeMs === sessionDirMtimeMs) {
    return cached.filePaths;
  }

  const filePaths = fs
    .readdirSync(sessionDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => path.join(sessionDir, file));

  sessionFilePathsCache.set(sessionDir, { mtimeMs: sessionDirMtimeMs, filePaths });
  return filePaths;
}

export function getSessionFilePath(cwd: string, sessionId: string): string | null {
  const sessionDir = getSessionDir(cwd);
  const sessionDirMtimeMs = getDirectoryMtimeMs(sessionDir);
  if (sessionDirMtimeMs === null) {
    sessionFilePathCache.delete(`${sessionDir}::${sessionId}`);
    return null;
  }

  const cacheKey = `${sessionDir}::${sessionId}`;
  const cached = sessionFilePathCache.get(cacheKey);

  if (cached && cached.sessionDirMtimeMs === sessionDirMtimeMs && cached.filePath) {
    if (fs.existsSync(cached.filePath)) {
      const stat = fs.statSync(cached.filePath);
      const headerCached = sessionHeaderCache.get(cached.filePath);
      if (headerCached && headerCached.mtimeMs === stat.mtimeMs && headerCached.size === stat.size) {
        if (headerCached.value?.id === sessionId) {
          return cached.filePath;
        }
      }
    }
  }

  const filePaths = getSessionFilePaths(cwd);

  for (const fullPath of filePaths) {
    const header = readSessionHeader(fullPath);
    if (header?.id === sessionId) {
      sessionFilePathCache.set(cacheKey, { sessionDirMtimeMs, filePath: fullPath });
      return fullPath;
    }
  }

  sessionFilePathCache.set(cacheKey, { sessionDirMtimeMs, filePath: null });
  return null;
}

export function parseSessionFile(filePath: string): { header: SessionHeader; entries: SessionEntry[] } | null {
  try {
    const stat = fs.statSync(filePath);
    const cached = sessionParseCache.get(filePath);

    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) {
      sessionParseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: null });
      return null;
    }

    const header: SessionHeader = JSON.parse(lines[0]);
    if (header.type !== "session") {
      sessionParseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: null });
      return null;
    }

    const entries: SessionEntry[] = [];

    for (let index = 1; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;

      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        // Skip malformed lines
      }
    }

    const parsed = { header, entries };
    sessionParseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: parsed });
    return parsed;
  } catch {
    sessionHeaderCache.delete(filePath);
    sessionParseCache.delete(filePath);
    return null;
  }
}

export function getEntriesAfterTimestamp(entries: SessionEntry[], timestamp: string): SessionEntry[] {
  const targetTime = toTimestamp(timestamp);
  return entries.filter((entry) => toTimestamp(entry.timestamp) > targetTime);
}

export function getEntriesByIds(entries: SessionEntry[], ids: string[]): SessionEntry[] {
  const idSet = new Set(ids);
  return entries.filter((entry) => idSet.has(entry.id));
}

export interface SessionContextEntry {
  id: string;
  type: string;
  timestamp: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
  summary?: string;
  customType?: string;
  data?: unknown;
}

export function formatEntryAsContext(entry: SessionEntry): SessionContextEntry | null {
  const commonFields = { id: entry.id, type: entry.type, timestamp: entry.timestamp };

  switch (entry.type) {
    case "message": {
      const messageEntry = entry as { message: { role: string; content?: unknown } };
      return {
        ...commonFields,
        message: {
          role: messageEntry.message.role,
          content: messageEntry.message.content as string | Array<{ type: string; text?: string }>,
        },
      };
    }
    case "thinking_level_change":
      return { ...commonFields, thinkingLevel: entry.thinkingLevel };
    case "model_change":
      return { ...commonFields, provider: entry.provider, modelId: entry.modelId };
    case "compaction":
      return { ...commonFields, summary: entry.summary };
    case "custom": {
      const customEntry = entry as { customType: string; data?: unknown };
      return { ...commonFields, customType: customEntry.customType, data: customEntry.data };
    }
    default:
      return null;
  }
}
