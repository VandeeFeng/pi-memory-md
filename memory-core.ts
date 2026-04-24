import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { DEFAULT_HOOKS, normalizeHooks } from "./hooks.js";
import { normalizeTapeKeywords } from "./tape/tape-gate.js";
import type { MemoryFile, MemoryFrontmatter, MemoryMdSettings, ParsedFrontmatter } from "./types.js";
import { DEFAULT_LOCAL_PATH, DEFAULT_TAPE_EXCLUDE_DIRS, expandHomePath, getCurrentDate } from "./utils.js";

export * from "./types.js";
export { DEFAULT_LOCAL_PATH, getCurrentDate } from "./utils.js";

export const DEFAULT_SETTINGS: MemoryMdSettings = {
  enabled: true,
  repoUrl: "",
  localPath: DEFAULT_LOCAL_PATH,
  hooks: DEFAULT_HOOKS,
  injection: "message-append",
  tape: {
    enabled: false,
    onlyGit: true,
    excludeDirs: DEFAULT_TAPE_EXCLUDE_DIRS,
    context: {
      strategy: "smart",
      fileLimit: 10,
      memoryScan: [72, 168],
      whitelist: [],
      blacklist: [],
    },
    anchor: {
      labelPrefix: "⚓ ",
      mode: "auto",
      keywords: {
        global: [],
        project: [],
      },
    },
  },
};

export function expandPath(filePath: string): string {
  return expandHomePath(filePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeSettings<T>(base: T, overrides: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;

  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) {
      continue;
    }

    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMergeSettings(baseValue, overrideValue);
      continue;
    }

    result[key] = overrideValue;
  }

  return result as T;
}

function readSettingsFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    console.warn(`Failed to load settings from ${filePath}:`, error);
    return {};
  }
}

function normalizePathList(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean))];
}

function normalizeAbsolutePathList(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((entry) => expandPath(entry.trim())).filter((entry) => path.isAbsolute(entry)))];
}

function mergePathLists(...lists: Array<string[] | undefined>): string[] {
  return normalizePathList(lists.flatMap((list) => list ?? []));
}

function sanitizeProjectSettings(
  rawSettings: Partial<MemoryMdSettings> & {
    autoSync?: { onSessionStart?: boolean };
  },
): Partial<MemoryMdSettings> & { autoSync?: { onSessionStart?: boolean } } {
  const sanitized: Partial<MemoryMdSettings> & { autoSync?: { onSessionStart?: boolean } } = {
    ...rawSettings,
    repoUrl: undefined,
    localPath: undefined,
    hooks: undefined,
    autoSync: undefined,
  };

  if (sanitized.tape) {
    sanitized.tape = {
      ...sanitized.tape,
      tapePath: undefined,
    };
  }

  return sanitized;
}

function normalizeSettings(
  rawSettings: MemoryMdSettings & {
    hooks?: MemoryMdSettings["hooks"];
    autoSync?: { onSessionStart?: boolean };
  },
): MemoryMdSettings {
  const loadedSettings = deepMergeSettings(DEFAULT_SETTINGS, rawSettings);
  loadedSettings.hooks = normalizeHooks(rawSettings.hooks ?? rawSettings.autoSync ?? loadedSettings.hooks);

  if (rawSettings.tape) {
    loadedSettings.tape ??= {};
    loadedSettings.tape.enabled = rawSettings.tape.enabled !== false;
  }

  if (loadedSettings.localPath) {
    loadedSettings.localPath = expandPath(loadedSettings.localPath);
  }

  const memoryScan = loadedSettings.tape?.context?.memoryScan;
  if (memoryScan) {
    const [startHours, maxHours] = memoryScan;
    const normalizedStart = Number.isFinite(startHours) && startHours > 0 ? Math.floor(startHours) : 72;
    const normalizedMax = Number.isFinite(maxHours) && maxHours > 0 ? Math.floor(maxHours) : 168;
    loadedSettings.tape ??= {};
    loadedSettings.tape.context ??= {};
    loadedSettings.tape.context.memoryScan = [normalizedStart, Math.max(normalizedStart, normalizedMax)];
  }

  if (loadedSettings.tape) {
    loadedSettings.tape.onlyGit = loadedSettings.tape.onlyGit !== false;
    loadedSettings.tape.excludeDirs = normalizeAbsolutePathList([
      ...(DEFAULT_TAPE_EXCLUDE_DIRS ?? []),
      ...(loadedSettings.tape.excludeDirs ?? []),
    ]);
  }

  if (loadedSettings.tape?.context) {
    loadedSettings.tape.context.whitelist = mergePathLists(
      loadedSettings.tape.context.alwaysInclude,
      loadedSettings.tape.context.whitelist,
    );
    loadedSettings.tape.context.blacklist = normalizePathList(loadedSettings.tape.context.blacklist);
  }

  if (loadedSettings.tape?.anchor) {
    loadedSettings.tape.anchor.mode = loadedSettings.tape.anchor.mode === "manual" ? "manual" : "auto";
    loadedSettings.tape.anchor.keywords = normalizeTapeKeywords(loadedSettings.tape.anchor.keywords);
  }

  return loadedSettings;
}

export function loadSettings(cwd = process.cwd()): MemoryMdSettings {
  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  const globalSettings = readSettingsFile(globalSettingsPath);
  const projectSettings = readSettingsFile(projectSettingsPath);
  const globalMemorySettings = (globalSettings["pi-memory-md"] ?? {}) as MemoryMdSettings;
  const projectMemorySettings = sanitizeProjectSettings(
    (projectSettings["pi-memory-md"] ?? {}) as Partial<MemoryMdSettings> & {
      autoSync?: { onSessionStart?: boolean };
    },
  );
  const rawSettings = deepMergeSettings(globalMemorySettings, projectMemorySettings) as MemoryMdSettings & {
    hooks?: MemoryMdSettings["hooks"];
    autoSync?: { onSessionStart?: boolean };
  };

  return normalizeSettings(rawSettings);
}

export function getMemoryDir(settings: MemoryMdSettings, cwd: string): string {
  const localPath = settings.localPath || DEFAULT_LOCAL_PATH;
  return path.join(localPath, path.basename(cwd));
}

export function getMemoryCoreDir(memoryDir: string): string {
  return path.join(memoryDir, "core");
}

export function getMemoryUserDir(memoryDir: string): string {
  return path.join(getMemoryCoreDir(memoryDir), "user");
}

export function isMemoryInitialized(memoryDir: string): boolean {
  return fs.existsSync(getMemoryUserDir(memoryDir));
}

function validateFrontmatter(data: ParsedFrontmatter): { valid: boolean; error?: string } {
  if (!data) {
    return { valid: false, error: "No frontmatter found (requires --- delimiters)" };
  }

  const frontmatter = data as MemoryFrontmatter;

  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    return { valid: false, error: "'description' must be a string if provided" };
  }

  if (frontmatter.limit !== undefined && (typeof frontmatter.limit !== "number" || frontmatter.limit <= 0)) {
    return { valid: false, error: "'limit' must be a positive number" };
  }

  if (frontmatter.tags !== undefined && !Array.isArray(frontmatter.tags)) {
    return { valid: false, error: "'tags' must be an array of strings" };
  }

  return { valid: true };
}

export function readMemoryFile(filePath: string): MemoryFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(content);

    if (!parsed.data || Object.keys(parsed.data).length === 0 || !validateFrontmatter(parsed.data).valid) {
      return {
        path: filePath,
        frontmatter: { description: "No description" },
        content,
      };
    }

    return {
      path: filePath,
      frontmatter: parsed.data as MemoryFrontmatter,
      content: parsed.content,
    };
  } catch (error) {
    console.error(`Failed to read memory file ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function listMemoryFiles(memoryDir: string): string[] {
  const files: string[] = [];

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walkDir(memoryDir);
  return files;
}

export function writeMemoryFile(filePath: string, content: string, frontmatter: MemoryFrontmatter): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, matter.stringify(content, frontmatter));
}

export function ensureDirectoryStructure(memoryDir: string): void {
  const dirs = [
    getMemoryUserDir(memoryDir),
    path.join(getMemoryCoreDir(memoryDir), "project"),
    path.join(memoryDir, "reference"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createDefaultFiles(memoryDir: string): void {
  const identityFile = path.join(getMemoryUserDir(memoryDir), "identity.md");
  if (!fs.existsSync(identityFile)) {
    writeMemoryFile(identityFile, "# User Identity\n\nCustomize this file with your information.", {
      description: "User identity and background",
      tags: ["user", "identity"],
      created: getCurrentDate(),
    });
  }

  const preferFile = path.join(getMemoryUserDir(memoryDir), "prefer.md");
  if (!fs.existsSync(preferFile)) {
    writeMemoryFile(
      preferFile,
      "# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming preferred",
      {
        description: "User habits and code style preferences",
        tags: ["user", "preferences"],
        created: getCurrentDate(),
      },
    );
  }
}

export function initializeMemoryDirectory(memoryDir: string): void {
  ensureDirectoryStructure(memoryDir);
  createDefaultFiles(memoryDir);
}

export function formatMemoryContext(context: string): string {
  return context.trimStart().startsWith("# Project Memory") ? context : `# Project Memory\n\n${context}`;
}

export function countMemoryContextFiles(context: string): number {
  return context.split("\n").filter((line) => line.startsWith("-")).length;
}

export function buildMemoryContext(settings: MemoryMdSettings, cwd: string): string {
  const memoryDir = getMemoryDir(settings, cwd);
  const coreDir = getMemoryCoreDir(memoryDir);

  if (!fs.existsSync(coreDir)) {
    return "";
  }

  const files = listMemoryFiles(coreDir);
  if (files.length === 0) {
    return "";
  }

  const lines: string[] = [
    "# Project Memory",
    "",
    `Memory directory: ${memoryDir}`,
    "Paths below are relative to that directory.",
    "",
    "Available memory files (use memory_read to view full content):",
    "",
  ];

  for (const filePath of files) {
    const memory = readMemoryFile(filePath);
    if (!memory) {
      continue;
    }

    const relPath = path.relative(memoryDir, filePath);
    const { description, tags } = memory.frontmatter;
    lines.push(`- ${relPath}`);
    lines.push(`  Description: ${description}`);
    lines.push(`  Tags: ${tags?.join(", ") || "none"}`);
    lines.push("");
  }

  return lines.join("\n");
}
