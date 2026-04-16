import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

function getSessionsDir(): string {
  return path.join(getAgentDir(), "sessions");
}

function encodeSessionPath(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getSessionDir(cwd: string): string {
  return path.join(getSessionsDir(), encodeSessionPath(cwd));
}

export function getSessionFilePath(cwd: string, sessionId: string): string | null {
  const sessionDir = getSessionDir(cwd);

  if (!fs.existsSync(sessionDir)) return null;

  const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const fullPath = path.join(sessionDir, file);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const firstLine = content.split("\n")[0];
      if (!firstLine) continue;

      const header: SessionHeader = JSON.parse(firstLine);
      if (header.type === "session" && header.id === sessionId) {
        return fullPath;
      }
    } catch {}
  }

  return null;
}

export function parseSessionFile(filePath: string): { header: SessionHeader; entries: SessionEntry[] } | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    if (lines.length === 0) return null;

    const header: SessionHeader = JSON.parse(lines[0]);
    if (header.type !== "session") return null;

    const entries: SessionEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        entries.push(JSON.parse(lines[i]) as SessionEntry);
      } catch {
        // Skip malformed
      }
    }

    return { header, entries };
  } catch {
    return null;
  }
}

export function getEntriesAfterTimestamp(entries: SessionEntry[], timestamp: string): SessionEntry[] {
  const targetTime = new Date(timestamp).getTime();
  return entries.filter((e) => new Date(e.timestamp).getTime() > targetTime);
}

export function getEntriesInRange(entries: SessionEntry[], start: string, end: string): SessionEntry[] {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  return entries.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return t >= startTime && t <= endTime;
  });
}

export function getEntriesByIds(entries: SessionEntry[], ids: string[]): SessionEntry[] {
  const idSet = new Set(ids);
  return entries.filter((e) => idSet.has(e.id));
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
      const msg = entry as { message: { role: string; content?: unknown } };
      return {
        ...commonFields,
        message: {
          role: msg.message.role,
          content: msg.message.content as string | Array<{ type: string; text?: string }>,
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
      const c = entry as { customType: string; data?: unknown };
      return { ...commonFields, customType: c.customType, data: c.data };
    }
    case "custom_message": {
      const c = entry as { customType: string; content?: unknown; details?: unknown };
      return { ...commonFields, customType: c.customType, data: { content: c.content, details: c.details } };
    }
    default:
      return null;
  }
}
