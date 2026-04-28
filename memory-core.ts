import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { DEFAULT_HOOKS, normalizeHooks } from "./hooks.js";
import { normalizeTapeKeywords } from "./tape/tape-gate.js";
import type { MemoryFile, MemoryFrontmatter, MemoryMdSettings, ParsedFrontmatter } from "./types.js";
import {
  DEFAULT_LOCAL_PATH,
  DEFAULT_TAPE_EXCLUDE_DIRS,
  expandHomePath,
  getCurrentDate,
  getProjectMeta,
} from "./utils.js";

export * from "./types.js";
export { DEFAULT_LOCAL_PATH, getCurrentDate } from "./utils.js";

export const DEFAULT_MEMORY_SCAN: [number, number] = [72, 168];
export const DEFAULT_GLOBAL_MEMORY_DIRNAME = "global";

export function normalizeMemoryScanRange(memoryScan?: [number, number]): [number, number] {
  const [startHours, maxHours] = memoryScan ?? DEFAULT_MEMORY_SCAN;
  const normalizedStart =
    Number.isFinite(startHours) && startHours > 0 ? Math.floor(startHours) : DEFAULT_MEMORY_SCAN[0];
  const normalizedMax = Number.isFinite(maxHours) && maxHours > 0 ? Math.floor(maxHours) : DEFAULT_MEMORY_SCAN[1];
  return [normalizedStart, Math.max(normalizedStart, normalizedMax)];
}

export const DEFAULT_SETTINGS: MemoryMdSettings = {
  enabled: true,
  repoUrl: "",
  localPath: DEFAULT_LOCAL_PATH,
  hooks: DEFAULT_HOOKS,
  globalMemory: {
    enabled: false,
    directory: DEFAULT_GLOBAL_MEMORY_DIRNAME,
  },
  delivery: "message-append",
  /** @deprecated Use `delivery` instead. */
  injection: "message-append",
  tape: {
    enabled: false,
    onlyGit: true,
    excludeDirs: DEFAULT_TAPE_EXCLUDE_DIRS,
    context: {
      strategy: "smart",
      fileLimit: 10,
      memoryScan: DEFAULT_MEMORY_SCAN,
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
  const entries = (value ?? []).map((entry) => expandPath(entry.trim()));
  return [...new Set(entries.filter((entry) => path.isAbsolute(entry)))];
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
    globalMemory: undefined,
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

function normalizeGlobalMemorySettings(rawSettings: MemoryMdSettings): MemoryMdSettings["globalMemory"] {
  const directoryName = rawSettings.globalMemory?.directory?.trim() || DEFAULT_GLOBAL_MEMORY_DIRNAME;
  const safeDirectoryName = path.basename(directoryName).replace(/^\.+$/, DEFAULT_GLOBAL_MEMORY_DIRNAME);

  // If globalMemory config block exists, default to enabled unless explicitly disabled
  const hasGlobalMemoryConfig = rawSettings.globalMemory !== undefined;
  const enabled = hasGlobalMemoryConfig && rawSettings.globalMemory?.enabled !== false;

  return {
    enabled,
    directory: safeDirectoryName || DEFAULT_GLOBAL_MEMORY_DIRNAME,
  };
}

function normalizeSettings(
  rawSettings: MemoryMdSettings & {
    hooks?: MemoryMdSettings["hooks"];
    autoSync?: { onSessionStart?: boolean };
  },
): MemoryMdSettings {
  const loadedSettings = deepMergeSettings(DEFAULT_SETTINGS, rawSettings);
  const delivery = rawSettings.delivery ?? rawSettings.injection ?? loadedSettings.delivery ?? loadedSettings.injection;
  loadedSettings.delivery = delivery;
  loadedSettings.injection = delivery;
  loadedSettings.hooks = normalizeHooks(rawSettings.hooks ?? rawSettings.autoSync ?? loadedSettings.hooks);
  loadedSettings.globalMemory = normalizeGlobalMemorySettings(rawSettings);

  if (rawSettings.tape) {
    loadedSettings.tape ??= {};
    loadedSettings.tape.enabled = rawSettings.tape.enabled !== false;
  }

  if (loadedSettings.localPath) {
    loadedSettings.localPath = expandPath(loadedSettings.localPath);
  }

  if (loadedSettings.tape?.context?.memoryScan) {
    loadedSettings.tape ??= {};
    loadedSettings.tape.context ??= {};
    loadedSettings.tape.context.memoryScan = normalizeMemoryScanRange(loadedSettings.tape.context.memoryScan);
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
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const globalSettingsPath = path.join(agentDir, "settings.json");
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
  const { mainRoot, name } = getProjectMeta(cwd);
  return path.join(localPath, mainRoot ? path.basename(mainRoot) : name);
}

export function getGlobalMemoryDir(settings: MemoryMdSettings): string | null {
  if (settings.globalMemory?.enabled !== true) return null;
  const localPath = settings.localPath || DEFAULT_LOCAL_PATH;
  return path.join(localPath, settings.globalMemory.directory || DEFAULT_GLOBAL_MEMORY_DIRNAME);
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

function parseMemoryFileContent(filePath: string, content: string): MemoryFile {
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
}

export async function readMemoryFileAsync(filePath: string): Promise<MemoryFile | null> {
  try {
    return parseMemoryFileContent(filePath, await fs.promises.readFile(filePath, "utf-8"));
  } catch (error) {
    console.error(`Failed to read memory file ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function listMemoryFilesAsync(memoryDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walkDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
          return;
        }

        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      }),
    );
  }

  await walkDir(memoryDir);
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

type MemoryContextScope = {
  label: string;
  prefix: string;
  memoryDir: string;
};

function getMemoryContextScopes(settings: MemoryMdSettings, cwd: string): MemoryContextScope[] {
  const projectMemoryDir = getMemoryDir(settings, cwd);
  const globalMemoryDir = getGlobalMemoryDir(settings);
  const scopes: MemoryContextScope[] = [];

  if (globalMemoryDir && globalMemoryDir !== projectMemoryDir) {
    scopes.push({ label: "Shared Global Memory", prefix: "global", memoryDir: globalMemoryDir });
  }

  scopes.push({ label: "Project Memory", prefix: "project", memoryDir: projectMemoryDir });
  return scopes;
}

async function readCoreMemoryFiles(
  memoryDir: string,
): Promise<{ files: string[]; memories: Array<MemoryFile | null> } | null> {
  const coreDir = getMemoryCoreDir(memoryDir);

  try {
    const stat = await fs.promises.stat(coreDir);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const files = await listMemoryFilesAsync(coreDir);
  if (files.length === 0) {
    return null;
  }

  return {
    files,
    memories: await Promise.all(files.map((filePath) => readMemoryFileAsync(filePath))),
  };
}

function appendMemoryFileLines(
  lines: string[],
  memoryDir: string,
  files: string[],
  memories: Array<MemoryFile | null>,
  prefix?: string,
): void {
  for (let index = 0; index < files.length; index++) {
    const filePath = files[index];
    const memory = memories[index];
    if (!filePath || !memory) {
      continue;
    }

    const relPath = path.relative(memoryDir, filePath);
    const displayPath = prefix ? `${prefix}/${relPath}` : relPath;
    const { description, tags } = memory.frontmatter;
    lines.push(`- ${displayPath}`);
    lines.push(`  Description: ${description}`);
    lines.push(`  Tags: ${tags?.join(", ") || "none"}`);
    lines.push("");
  }
}

async function buildMemoryContextSection(scope: MemoryContextScope): Promise<string[] | null> {
  const coreFiles = await readCoreMemoryFiles(scope.memoryDir);
  if (!coreFiles) return null;

  const lines: string[] = [`## ${scope.label}`, "", `Memory directory: ${scope.memoryDir}`, ""];
  appendMemoryFileLines(lines, scope.memoryDir, coreFiles.files, coreFiles.memories, scope.prefix);
  return lines;
}

export async function buildMemoryContextAsync(settings: MemoryMdSettings, cwd: string): Promise<string> {
  const projectMemoryDir = getMemoryDir(settings, cwd);
  const globalMemoryDir = getGlobalMemoryDir(settings);

  if (!globalMemoryDir || globalMemoryDir === projectMemoryDir) {
    const coreFiles = await readCoreMemoryFiles(projectMemoryDir);
    if (!coreFiles) return "";

    const lines = [
      "# Project Memory",
      "",
      `Memory directory: ${projectMemoryDir}`,
      "Paths below are relative to that directory.",
      "",
      "Available memory files:",
      "",
    ];
    appendMemoryFileLines(lines, projectMemoryDir, coreFiles.files, coreFiles.memories);
    return lines.join("\n");
  }

  const sections = (
    await Promise.all(getMemoryContextScopes(settings, cwd).map((scope) => buildMemoryContextSection(scope)))
  ).filter((section): section is string[] => section !== null);

  if (sections.length === 0) {
    return "";
  }

  const lines = [
    "# Project Memory",
    "",
    `Shared global memory directory: ${globalMemoryDir}`,
    `Project memory directory: ${projectMemoryDir}`,
    "Paths below are prefixed with `global/` or `project/` when shared global memory is enabled.",
    "",
    "Available memory files:",
    "",
  ];

  for (const section of sections) {
    lines.push(...section);
  }

  return lines.join("\n");
}
