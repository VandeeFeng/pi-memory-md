import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { DEFAULT_HOOKS, normalizeHooks } from "./hooks.js";
import { normalizeTapeKeywords } from "./tape/tape-gate.js";
import type { MemoryFile, MemoryFrontmatter, MemoryMdSettings, MemoryMeta, ParsedFrontmatter } from "./types.js";
import {
  DEFAULT_LOCAL_PATH,
  DEFAULT_TAPE_EXCLUDE_DIRS,
  escapeXml,
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
  delivery: "message-append",
  /** @deprecated Use `delivery` instead. */
  injection: "message-append",
  memoryDir: {
    repoUrl: "",
    localPath: DEFAULT_LOCAL_PATH,
  },
  tape: {
    enabled: false,
    thread: true,
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
    autoSync: undefined,
    memoryDir: undefined,
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
  if (rawSettings.memoryDir?.localPath && !rawSettings.localPath) {
    rawSettings.localPath = rawSettings.memoryDir.localPath;
  }

  if (rawSettings.memoryDir?.repoUrl && !rawSettings.repoUrl) {
    rawSettings.repoUrl = rawSettings.memoryDir.repoUrl;
  }

  const loadedSettings = deepMergeSettings(DEFAULT_SETTINGS, rawSettings);
  const delivery = rawSettings.delivery ?? rawSettings.injection ?? loadedSettings.delivery ?? loadedSettings.injection;
  loadedSettings.delivery = delivery;
  loadedSettings.injection = delivery;
  loadedSettings.hooks = normalizeHooks(rawSettings.hooks ?? rawSettings.autoSync ?? loadedSettings.hooks);

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
    loadedSettings.tape.thread = loadedSettings.tape.thread !== false;
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
  if (!Object.hasOwn(settings.memoryDir ?? {}, "globalMemory")) return null;

  const globalMemory = settings.memoryDir?.globalMemory;
  if (globalMemory === undefined || globalMemory === null || globalMemory === "") return null;

  const directoryName = globalMemory.trim();
  const safeDirectoryName =
    path.basename(directoryName).replace(/^\.+$/, DEFAULT_GLOBAL_MEMORY_DIRNAME) || DEFAULT_GLOBAL_MEMORY_DIRNAME;
  const localPath = settings.localPath || DEFAULT_LOCAL_PATH;
  return path.join(localPath, safeDirectoryName);
}

export function getMemoryCoreDir(memoryDir: string): string {
  return path.join(memoryDir, "core");
}

export function getMemoryUserDir(memoryDir: string): string {
  return path.join(getMemoryCoreDir(memoryDir), "user");
}

export function isMemoryInitialized(memoryDir: string): boolean {
  return fs.existsSync(getMemoryCoreDir(memoryDir));
}

export async function getMemoryMeta(settings: MemoryMdSettings, cwd: string): Promise<MemoryMeta> {
  const projectMemoryDir = getMemoryDir(settings, cwd);
  const globalMemoryDir = getGlobalMemoryDir(settings);
  const globalMemoryExists = !!globalMemoryDir && fs.existsSync(globalMemoryDir);

  const [projectFiles, globalFiles] = await Promise.all([
    listMemoryFilesAsync(projectMemoryDir),
    globalMemoryExists && globalMemoryDir !== projectMemoryDir ? listMemoryFilesAsync(globalMemoryDir) : null,
  ]);

  const projectMeta = getProjectMeta(cwd);

  return {
    ...projectMeta,
    initialized: isMemoryInitialized(projectMemoryDir),
    memoryPath: projectMemoryDir,
    project: {
      scope: "project",
      dir: projectMemoryDir,
      exists: fs.existsSync(projectMemoryDir),
      fileCount: projectFiles.length,
    },
    global: {
      scope: "global",
      dir: globalMemoryDir,
      exists: globalMemoryExists,
      fileCount: globalFiles?.length ?? null,
    },
  };
}

export function renderMemoryTree(memoryDir: string, maxLines = 25): string {
  const safeMaxLines = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 25;

  try {
    execFileSync("tree", ["--version"], { encoding: "utf-8" });
    const treeOutput = execFileSync("tree", ["-L", "3", "-I", "node_modules", "--noreport", memoryDir], {
      encoding: "utf-8",
    }).trim();
    const treeLines = treeOutput.split("\n");
    const summary = execFileSync(
      "find",
      [memoryDir, "-maxdepth", "3", "-not", "-path", "*/node_modules/*", "-printf", "%y\n"],
      { encoding: "utf-8" },
    )
      .split("\n")
      .reduce(
        (counts, type) => ({
          directories: counts.directories + (type === "d" ? 1 : 0),
          files: counts.files + (type === "f" ? 1 : 0),
        }),
        { directories: -1, files: 0 },
      );

    return treeLines.length > safeMaxLines
      ? `${summary.directories} directories, ${summary.files} files\n\n${treeLines.slice(0, safeMaxLines).join("\n")}\n...`
      : treeOutput;
  } catch {
    try {
      return execFileSync("find", [memoryDir, "-type", "d", "-not", "-path", "*/node_modules/*"], {
        encoding: "utf-8",
      }).trim();
    } catch {
      return "Unable to generate directory tree.";
    }
  }
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
  // readdir + Promise.all completes in filesystem order, which varies between runs and
  // machines. Sorting keeps the injected index byte-stable so prompt caches survive a
  // restart, and makes the block reproducible. Plain sort: code-unit order, no locale.
  return files.sort();
}

export function writeMemoryFile(filePath: string, content: string, frontmatter: MemoryFrontmatter): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, matter.stringify(content, frontmatter));
}

/** Overwritten in place — state is a snapshot, not a log, so history here misleads. */
export const SESSION_STATE_FILENAME = "state.md";

export type SessionStateInput = {
  cwd: string;
  filesTouched: string[];
  lastPrompt: string;
  compactionCount: number;
  now?: Date;
};

function readFrontmatterValue(filePath: string, key: "created"): string | undefined {
  try {
    const parsed = matter(fs.readFileSync(filePath, "utf-8"));
    const value = parsed.data?.[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function renderSessionState(input: SessionStateInput): string {
  const iso = (input.now ?? new Date()).toISOString();
  const lines = [
    "# Session state (auto-captured)",
    "",
    "Snapshot taken right before a compaction summarized this session. It is current",
    "state, not a durable rule: overwrite or delete it once the work is finished.",
    "",
    `- captured: ${iso}`,
    `- cwd: ${input.cwd}`,
    `- compactions so far: ${input.compactionCount}`,
  ];

  if (input.filesTouched.length > 0) {
    lines.push("", "## Files edited this session", "");
    for (const filePath of input.filesTouched) lines.push(`- ${filePath}`);
  }

  if (input.lastPrompt.trim()) {
    lines.push("", "## Last user request", "", input.lastPrompt.trim());
  }

  return `${lines.join("\n")}\n`;
}

/** Writes `<memoryDir>/core/state.md`, preserving the original `created` date. */
export function writeSessionStateFile(memoryDir: string, input: SessionStateInput): string {
  const filePath = path.join(getMemoryCoreDir(memoryDir), SESSION_STATE_FILENAME);
  const today = getCurrentDate();
  writeMemoryFile(filePath, renderSessionState(input), {
    description: "Session state auto-captured before compaction: edited files and last request",
    tags: ["state", "session"],
    created: readFrontmatterValue(filePath, "created") ?? today,
    updated: today,
  });
  return filePath;
}

// Deprecated after migrating initialization to memory-init skill.
// Keep this block commented for reference during transition.
// export function ensureDirectoryStructure(memoryDir: string): void {
//   const dirs = [
//     getMemoryUserDir(memoryDir),
//     path.join(getMemoryCoreDir(memoryDir), "project"),
//     path.join(memoryDir, "reference"),
//   ];
//
//   for (const dir of dirs) {
//     fs.mkdirSync(dir, { recursive: true });
//   }
// }
//
// export function createDefaultFiles(memoryDir: string): void {
//   const identityFile = path.join(getMemoryUserDir(memoryDir), "identity.md");
//   if (!fs.existsSync(identityFile)) {
//     writeMemoryFile(identityFile, "# User Identity\n\nCustomize this file with your information.", {
//       description: "User identity and background",
//       tags: ["user", "identity"],
//       created: getCurrentDate(),
//     });
//   }
//
//   const userFile = path.join(getMemoryUserDir(memoryDir), "USER.md");
//   if (!fs.existsSync(userFile)) {
//     writeMemoryFile(
//       userFile,
//       "# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming preferred",
//       {
//         description: "User habits and code style preferences",
//         tags: ["user", "preferences"],
//         created: getCurrentDate(),
//       },
//     );
//   }
// }
//
// export function initializeMemoryDirectory(memoryDir: string): void {
//   ensureDirectoryStructure(memoryDir);
//   createDefaultFiles(memoryDir);
// }

export function formatMemoryContext(context: string): string {
  return context.trimStart().startsWith("<memory_context")
    ? context
    : `<memory_context mode="normal">\n${context}\n</memory_context>`;
}

export function countMemoryContextFiles(context: string): number {
  return context.split("\n").filter((line) => line.startsWith("-")).length;
}

async function readMemoryFiles(
  memoryDir: string,
): Promise<{ files: string[]; memories: Array<MemoryFile | null> } | null> {
  try {
    const stat = await fs.promises.stat(memoryDir);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const files = await listMemoryFilesAsync(memoryDir);
  if (files.length === 0) {
    return null;
  }

  return {
    files,
    memories: await Promise.all(files.map((filePath) => readMemoryFileAsync(filePath))),
  };
}

// memory delivery context template
export function memoryContextItemTpl(entry: {
  path: string;
  description?: string;
  tags?: string[] | string;
  priority?: "normal" | "high";
}): string[] {
  const tags = Array.isArray(entry.tags) ? entry.tags.join(", ") : entry.tags;
  return [
    `- path: ${entry.path}`,
    `  priority: ${entry.priority ?? "normal"}`,
    `  description: ${entry.description || "No description"}`,
    `  tags: ${tags || "none"}`,
  ];
}

export function memoryContextHeaderTpl(
  mode: "normal" | "tape" = "normal",
  options: { handoffMode?: "auto" | "manual" } = {},
): string[] {
  const lines = [`<memory_context mode="${mode}">`];

  if (mode === "normal") {
    lines.push(
      "<instructions>",
      "These memory files can help you better understand the project and the user.",
      "</instructions>",
    );
  }

  if (mode === "tape") {
    lines.push(
      "<instructions>",
      "Tape is enabled for this conversation. Use tape tools when you need anchors or tape history.",
    );

    if (options.handoffMode === "manual") {
      lines.push(
        "Handoff mode: manual. `tape_handoff` is blocked unless the keyword is triggered or user create manually.",
      );
    }

    lines.push("</instructions>");
  }

  return lines;
}

export function memoryContextTpl(
  entries: Array<{ path: string; memory: MemoryFile }> = [],
  options: { includeHeader?: boolean; mode?: "normal" | "tape" } = {},
): string[] {
  const lines: string[] = [];

  if (options.includeHeader !== false) {
    lines.push(...memoryContextHeaderTpl(options.mode ?? "normal"));
  }

  for (const entry of entries) {
    if (!entry.path || !entry.memory) {
      continue;
    }

    const { description, tags } = entry.memory.frontmatter;
    lines.push(...memoryContextItemTpl({ path: entry.path, description, tags }));
  }

  return lines;
}

type MemoryContextScope = {
  label: string;
  memoryDir: string;
  scanDir?: string;
};

type MemoryContextSection = {
  source: "global" | "project";
  directory: string;
  /** One entry per memory file, each already rendered as its own lines. */
  entries: string[][];
};

/**
 * The index is injected once per session, so an unbounded store silently grows
 * the context. 24k chars is roughly 6k tokens: enough for a few hundred entries,
 * small enough to notice. Override with `maxContextChars`, 0 to disable.
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 24_000;

/** Head-room reserved for the truncation notice inside the injected budget. */
const MAX_TRUNCATION_NOTICE_CHARS = 240;

async function buildMemoryContextSection(scope: MemoryContextScope): Promise<MemoryContextSection | null> {
  const scannedFiles = await readMemoryFiles(scope.scanDir ?? scope.memoryDir);
  if (!scannedFiles) return null;

  const source = scope.label === "Shared Global Memory" ? "global" : "project";
  const entries = scannedFiles.files
    .map((filePath, index) => ({ path: filePath, memory: scannedFiles.memories[index] }))
    .filter((entry): entry is { path: string; memory: MemoryFile } => Boolean(entry.memory))
    .map((entry) =>
      memoryContextItemTpl({
        path: entry.path,
        description: entry.memory.frontmatter.description,
        tags: entry.memory.frontmatter.tags,
      }),
    );

  if (entries.length === 0) return null;

  return { source, directory: scope.memoryDir, entries };
}

export async function buildMemoryContextAsync(settings: MemoryMdSettings, cwd: string): Promise<string> {
  const projectMemoryDir = getMemoryDir(settings, cwd);
  const globalMemoryDir = getGlobalMemoryDir(settings);
  const scopes: MemoryContextScope[] = [];

  if (globalMemoryDir && globalMemoryDir !== projectMemoryDir) {
    scopes.push({
      label: "Shared Global Memory",
      memoryDir: globalMemoryDir,
    });
  }

  scopes.push({
    label: "Project Memory",
    memoryDir: projectMemoryDir,
    scanDir: getMemoryCoreDir(projectMemoryDir),
  });

  const sections = (await Promise.all(scopes.map((scope) => buildMemoryContextSection(scope)))).filter(
    (section): section is MemoryContextSection => section !== null,
  );

  if (sections.length === 0) {
    return "";
  }

  const maxChars = settings.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const totalEntries = sections.reduce((count, section) => count + section.entries.length, 0);
  const lines = memoryContextTpl([], { mode: "normal" });
  // Reserve room for the closing tag plus a truncation notice so the notice itself
  // can never push the block past the budget.
  const tailChars = "</memory_context>".length + 1 + MAX_TRUNCATION_NOTICE_CHARS;
  let chars = lines.join("\n").length;
  let omitted = 0;
  let kept = 0;

  for (const section of sections) {
    const opening = `<memory_files source="${section.source}" directory="${escapeXml(section.directory)}">`;
    const closing = "</memory_files>";
    chars += opening.length + closing.length + 2;
    lines.push(opening);

    for (const entry of section.entries) {
      const entryChars = entry.join("\n").length + 1;
      // Global entries come first, so the project tail is what gets dropped.
      if (maxChars > 0 && chars + entryChars + tailChars > maxChars) {
        omitted += 1;
        continue;
      }
      chars += entryChars;
      kept += 1;
      lines.push(...entry);
    }

    lines.push(closing);
  }

  if (omitted > 0) {
    lines.push(
      `[memory index truncated: kept ${kept} of ${totalEntries} entries at maxContextChars=${maxChars}. ` +
        "Consolidate memory files, move detail to archive/, or raise pi-memory-md.maxContextChars.]",
    );
  }

  lines.push("</memory_context>");
  return lines.join("\n");
}
