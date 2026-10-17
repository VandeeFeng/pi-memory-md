import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { writeMemoryFile } from "../memory-core.js";
import { type RecallDiagnostics, recallMemory } from "../memory-recall.js";
import type { TapeRelevanceReport } from "../tape/tape-relevance.js";
import type { MemoryMdSettings } from "../types.js";
import { createTempDir, initGitRepo } from "./test-helpers.js";

function setupRecall() {
  const cwd = createTempDir("pi-recall-project");
  const localPath = createTempDir("pi-recall-memories");
  const settings = {
    localPath,
    tape: { enabled: false, context: { fileLimit: 1, jev: { enabled: true } } },
  } as MemoryMdSettings;
  const root = path.join(localPath, path.basename(cwd));
  return { cwd, settings, root };
}

function registryFor(score: (excerpt: string) => number) {
  return {
    getModelOfType: () => ({}),
    async classify(_model: unknown, request: any) {
      return {
        stopReason: "stop",
        answers: Object.fromEntries(
          request.state.candidates.map((candidate: any, index: number) => [
            `file_${index}`,
            { type: "score", score: score(candidate.excerpt), confidence: 1 },
          ]),
        ),
      };
    },
  };
}

test("linked worktree recall uses only its own memory directory", async () => {
  const { cwd, root, settings } = setupRecall();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# Project\n");
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], {
    cwd,
    stdio: "ignore",
  });
  const worktree = path.join(createTempDir("pi-recall-worktree-memory"), "feature");
  execFileSync("git", ["worktree", "add", "-b", "memory-scope", worktree], { cwd, stdio: "ignore" });
  const nestedCwd = path.join(worktree, "src");
  fs.mkdirSync(nestedCwd);
  writeMemoryFile(path.join(root, "decision.md"), "Main-only persistence decision.", { description: "Main decision" });
  const worktreeMemory = path.join(settings.localPath!, path.basename(worktree));
  const decision = path.join(worktreeMemory, "decision.md");
  writeMemoryFile(decision, "Worktree-only persistence decision.", { description: "Worktree decision" });
  settings.tape!.context!.jev!.enabled = false;

  const result = await recallMemory(settings, nestedCwd, "persistence");
  assert.match(result.content, /Worktree-only persistence decision/);
  assert.doesNotMatch(result.content, /Main-only persistence decision/);

  fs.unlinkSync(decision);
  const missing = await recallMemory(settings, nestedCwd, "persistence");
  assert.equal(missing.content, "");
});

test("manual recall compares semantic scores across batches before applying the file limit", async () => {
  const { cwd, root, settings } = setupRecall();
  for (let index = 0; index < 8; index++) {
    writeMemoryFile(path.join(root, "reference", `${index}.md`), `# Decision\nMemory evidence ${index}.`, {
      description: "Memory decisions",
    });
  }
  let report: TapeRelevanceReport | undefined;
  const result = await recallMemory(settings, cwd, "memory evidence", {
    registry: registryFor((text) => (text.includes("evidence 6") ? 3 : 2)),
    onEvaluation: (value) => {
      report = value;
    },
  });
  assert.equal(result.fileCount, 1);
  assert.match(result.content, /Memory evidence 6/);
  assert.doesNotMatch(result.content, /Memory evidence 0/);
  assert.equal(report?.candidates, 8);
});

test("workspace lexical hits cannot crowd memory evidence out of semantic evaluation", async () => {
  const { cwd, root, settings } = setupRecall();
  for (let index = 0; index < 35; index++) {
    fs.writeFileSync(path.join(cwd, `${index}.ts`), "export const provider = 'invocation implementation';\n");
    writeMemoryFile(path.join(root, `${index}.md`), "# Notes\nUnrelated historical activity.", {
      description: "Notes",
    });
  }
  writeMemoryFile(
    path.join(root, "provider-policy.md"),
    "# Provider policy\nThe synthetic provider requires a validation step before use.",
    { description: "Execution constraint" },
  );
  const evaluated: string[] = [];
  const result = await recallMemory(settings, cwd, "provider invocation implementation", {
    registry: registryFor((text) => {
      evaluated.push(text);
      return text.includes("validation step") ? 3 : 0;
    }),
  });
  assert.ok(evaluated.some((text) => text.includes("export const provider")));
  assert.ok(evaluated.length <= 30);
  assert.match(result.content, /requires a validation step/);
});

for (const method of ["jev", "bm25"] as const) {
  test(`${method} selects higher-ranked workspace evidence without memory priority`, async () => {
    const { cwd, root, settings } = setupRecall();
    settings.tape!.context!.jev!.enabled = method === "jev";
    fs.writeFileSync(path.join(cwd, "provider.ts"), "export const provider = 'invocation implementation';\n");
    writeMemoryFile(path.join(root, "decision.md"), "# Decision\nThe synthetic provider requires a validation step.", {
      description: "Prior decision",
    });
    const result = await recallMemory(settings, cwd, "provider invocation implementation", {
      registry: registryFor((text) => (text.includes("validation step") ? 2 : 3)),
    });
    assert.match(result.content, /export const provider/);
    assert.doesNotMatch(result.content, /requires a validation step/);
    assert.equal(result.diagnostics.method, method);
    assert.equal(result.diagnostics.memory.relevant, 1);
    assert.equal(result.diagnostics.memory.injected, 0);
    assert.equal(result.diagnostics.project.relevant, 1);
    assert.equal(result.diagnostics.project.injected, 1);
  });
}

test("recall diagnoses shortlisted, rejected and absent memory independently of workspace output", async () => {
  const { cwd, root, settings } = setupRecall();
  for (let index = 0; index < 20; index++) {
    writeMemoryFile(path.join(root, `${index}.md`), "# Provider\nUnrelated provider activity log.", {
      description: "Activity",
    });
  }
  fs.writeFileSync(path.join(cwd, "provider.ts"), "export const provider = 'running implementation';\n");
  const registry = registryFor((text) => (text.includes("export const") ? 3 : 1));
  const rejected = await recallMemory(settings, cwd, "provider", { registry });
  assert.match(rejected.content, /running implementation/);
  assert.doesNotMatch(rejected.content, /activity log/);
  assert.deepEqual(rejected.diagnostics.memory, {
    available: 20,
    candidates: 15,
    evaluated: 15,
    relevant: 0,
    injected: 0,
  });
  assert.equal(rejected.diagnostics.project.injected, 1);
  fs.rmSync(root, { recursive: true });
  const absent = await recallMemory(settings, cwd, "provider", { registry });
  assert.deepEqual(absent.diagnostics.memory, {
    available: 0,
    candidates: 0,
    evaluated: 0,
    relevant: 0,
    injected: 0,
  });
  assert.equal(absent.diagnostics.project.injected, 1);
});

test("partial Jev failure preserves billing and diagnostics without injecting context", async (context) => {
  const { cwd, root, settings } = setupRecall();
  for (let index = 0; index < 7; index++) {
    writeMemoryFile(path.join(root, `${index}.md`), `# Decision\nStored constraint ${index}.`, {
      description: "Constraint",
    });
  }
  context.mock.method(globalThis, "fetch", async () => Response.json({ usage: { cost: 0.001 } }));
  const base = registryFor(() => 2);
  let calls = 0;
  let report: TapeRelevanceReport | undefined;
  let diagnostics: RecallDiagnostics | undefined;
  await assert.rejects(
    recallMemory(settings, cwd, "constraint", {
      registry: {
        ...base,
        async classify(model: unknown, request: any, options: { fetch: typeof globalThis.fetch }) {
          await options.fetch("https://openrouter.ai/api/v1/systemone");
          if (++calls === 2) return { stopReason: "error", answers: {} };
          return base.classify(model, request);
        },
      },
      onEvaluation: (value) => {
        report = value;
      },
      onDiagnostics: (value) => {
        diagnostics = value;
      },
    }),
    /Jev recall failed.*no memory was injected/,
  );
  assert.equal(calls, 2);
  assert.equal(report?.actualCostUsd, 0.002);
  assert.equal(report?.status, "fallback");
  assert.equal(diagnostics?.status, "failed");
  assert.equal(diagnostics?.memory.candidates, 7);
  assert.equal(diagnostics?.memory.evaluated, 6);
  assert.equal(diagnostics?.memory.relevant, 6);
  assert.equal(diagnostics?.memory.injected, 0);
});

test("generated output budgets preserve diagnostic counts and relevance ordering", async () => {
  const { cwd, root, settings } = setupRecall();
  for (let index = 0; index < 10; index++) {
    fs.writeFileSync(path.join(cwd, `${index}.ts`), `export const provider = '${"implementation ".repeat(60)}';\n`);
    writeMemoryFile(path.join(root, `${index}.md`), `# Constraint\n${"持久化操作必须遵守已有决策。".repeat(60)}`, {
      description: "Provider constraint",
    });
  }
  for (const fileLimit of [0, 1, 3, 30]) {
    settings.tape!.context!.fileLimit = fileLimit;
    const result = await recallMemory(settings, cwd, "provider implementation", {
      registry: registryFor((text) => (text.includes("export const") ? 3 : 2)),
    });
    assert.ok(Buffer.byteLength(result.content) <= 16 * 1024);
    assert.ok(result.fileCount <= fileLimit);
    const { memory, project } = result.diagnostics;
    assert.ok(memory.candidates + project.candidates <= 30);
    assert.equal(memory.injected + project.injected, result.excerptCount);
    for (const [kind, counts] of [
      ["memory", memory],
      ["project", project],
    ] as const) {
      assert.ok(counts.available >= counts.candidates);
      assert.equal(counts.candidates, counts.evaluated);
      assert.ok(counts.evaluated >= counts.relevant);
      assert.ok(counts.relevant >= counts.injected);
      assert.equal([...result.content.matchAll(new RegExp(`kind="${kind}"`, "g"))].length, counts.injected);
    }
    if (fileLimit) assert.ok(project.injected > 0);
  }
});

test("manual recall never transmits hidden, archived, blacklisted or out-of-root memories", async () => {
  const { cwd, root, settings } = setupRecall();
  settings.tape!.context!.blacklist = ["reference/blocked.md"];
  for (const file of [
    ".env.private/secret.md",
    "archive/old.md",
    "reference/blocked.md",
    "core/node_modules/noise.md",
    "core/build/noise.md",
  ]) {
    writeMemoryFile(path.join(root, file), "# Private\nNever transmit this content.", { description: "Private" });
  }
  const outside = path.join(createTempDir("pi-recall-outside"), "outside.md");
  writeMemoryFile(outside, "# Outside\nNever transmit this content.", { description: "Outside" });
  fs.symlinkSync(outside, path.join(root, "alias.md"));
  writeMemoryFile(path.join(root, "reference", "safe.md"), "# Safe\nUse atomic writes for persistence.", {
    description: "Persistence",
  });
  const registry = registryFor((text) => {
    assert.doesNotMatch(text, /Never transmit/);
    return 3;
  });
  const result = await recallMemory(settings, cwd, "persistence", { registry });
  assert.match(result.content, /atomic writes/);
  assert.doesNotMatch(result.content, /Never transmit|outside.md/);
});

test("manual recall sums pi token usage and estimates across batches", async (context) => {
  const { cwd, root, settings } = setupRecall();
  settings.tape!.context!.jev!.provider = "typesafe";
  for (let index = 0; index < 7; index++) {
    writeMemoryFile(path.join(root, `${index}.md`), `# Memory\nStored decision ${index}.`, {
      description: "Decisions",
    });
  }
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ usage: { input_tokens: 100, output_tokens: 20 } }),
  );
  let calls = 0;
  let report: TapeRelevanceReport | undefined;
  const base = registryFor(() => 3);
  await recallMemory(settings, cwd, "stored decision", {
    registry: {
      ...base,
      async classify(model: unknown, request: any, options: any) {
        calls++;
        await options.fetch("https://api.typesafe.ai/v1/systemone");
        return { ...(await base.classify(model, request)), usage: { input: 100, output: 20, cost: { total: 0.001 } } };
      },
    },
    onEvaluation: (value) => {
      report = value;
    },
  });
  assert.ok(calls > 1);
  assert.deepEqual(report?.tokenUsage, { input: calls * 100, output: calls * 20 });
  assert.equal(report?.estimatedCostUsd, calls * 0.001);
  assert.equal(report?.actualCostUsd, null);
});

test("manual recall evaluates whitelisted memories normally and retains shared memory scope", async () => {
  const { cwd, root, settings } = setupRecall();
  settings.memoryDir = { globalMemory: "shared" };
  settings.tape!.context!.whitelist = ["core/pinned.md", "core/blocked.md"];
  settings.tape!.context!.blacklist = ["core/blocked.md"];
  writeMemoryFile(path.join(root, "core", "pinned.md"), "# Storage\nUse a synthetic storage fixture.", {
    description: "Storage",
  });
  writeMemoryFile(path.join(root, "core", "blocked.md"), "# Blocked\nNever transmit this content.", {
    description: "Blocked",
  });
  writeMemoryFile(path.join(settings.localPath!, "shared", "encryption.md"), "# Encryption\nUse envelope encryption.", {
    description: "Encryption",
  });
  writeMemoryFile(
    path.join(settings.localPath!, "another-project", "encryption.md"),
    "# Other\nNever transmit this content.",
    { description: "Other" },
  );
  const result = await recallMemory(settings, cwd, "encryption", {
    registry: registryFor((text) => {
      assert.doesNotMatch(text, /Never transmit/);
      return text.includes("envelope encryption") ? 3 : 0;
    }),
  });
  assert.equal(result.fileCount, 1);
  assert.doesNotMatch(result.content, /synthetic storage fixture/);
  assert.match(result.content, /Use envelope encryption/);
  assert.doesNotMatch(result.content, /Never transmit/);
});

test("legacy memory wrappers never reach Jev or output and citations retain original lines", async () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    for (const paragraphs of [1, 30]) {
      const { cwd, root, settings } = setupRecall();
      const source = path.join(root, "handoff.md");
      writeMemoryFile(
        source,
        [
          "# Storage decision",
          "",
          "<analysis>",
          ...Array.from({ length: paragraphs }, () => "Use atomic writes for synthetic storage records."),
          "</analysis>",
          "",
          "<plan>",
          "# Next step",
          "Validate synthetic records before writing them.",
          "</plan>",
        ].join(lineEnding),
        { description: "Storage constraints" },
      );
      const original = fs.readFileSync(source, "utf8");
      const evaluated: string[] = [];
      const result = await recallMemory(settings, cwd, "storage constraints", {
        registry: registryFor((text) => {
          evaluated.push(text);
          return 3;
        }),
      });
      for (const text of evaluated) assert.doesNotMatch(text, /<\/?(?:analysis|plan)>/i);
      assert.match(result.content, /Use atomic writes/);
      assert.match(result.content, /Validate synthetic records/);
      assert.doesNotMatch(result.content, /&lt;\/?(?:analysis|plan)&gt;/i);
      const lines = original.split("\n");
      const excerpts = [...result.content.matchAll(/lines="(\d+)-(\d+)"[^>]*>\n([\s\S]*?)\n<\/excerpt>/g)];
      assert.equal(excerpts.length, result.excerptCount);
      for (const match of excerpts) {
        assert.equal(
          match[3].trimEnd(),
          lines
            .slice(Number(match[1]) - 1, Number(match[2]))
            .join("\n")
            .trimEnd(),
        );
      }
      assert.equal(fs.readFileSync(source, "utf8"), original);
    }
  }
});

test("memory code examples and workspace markup retain literal analysis and plan tags", async () => {
  for (const fence of ["```", "~~~"]) {
    const { cwd, root, settings } = setupRecall();
    settings.tape!.context!.fileLimit = 2;
    writeMemoryFile(
      path.join(root, "syntax.md"),
      [
        "# Syntax",
        "Use `<plan>` as a literal syntax example.",
        `${fence}xml`,
        "<analysis>",
        "Documented sample.",
        "</analysis>",
        "<plan>",
        "Documented steps.",
        "</plan>",
        fence,
        "",
        "    <analysis>",
        "    <plan>",
      ].join("\n"),
      { description: "Syntax examples" },
    );
    fs.writeFileSync(
      path.join(cwd, "syntax.md"),
      "# Syntax\n<analysis>\nWorkspace markup.\n</analysis>\n<plan>\nSteps.\n</plan>\n",
    );
    const excerpts: string[] = [];
    const result = await recallMemory(settings, cwd, "syntax", {
      registry: registryFor((text) => {
        excerpts.push(text);
        return 3;
      }),
    });
    assert.equal(result.fileCount, 2);
    assert.ok(excerpts.some((text) => text.includes(`${fence}xml\n<analysis>`)));
    assert.ok(excerpts.some((text) => text.includes("    <analysis>\n    <plan>")));
    assert.ok(excerpts.some((text) => text.includes("Use `<plan>`")));
    assert.ok(excerpts.some((text) => text.includes("<analysis>\nWorkspace markup.")));
    assert.match(result.content, /&lt;analysis&gt;/);
    assert.match(result.content, /&lt;plan&gt;/);
  }
});

test("legacy wrapper-only memory supplies no evidence and makes no Jev request", async () => {
  const { cwd, root, settings } = setupRecall();
  writeMemoryFile(path.join(root, "empty.md"), "# Envelope\n<analysis>\n</analysis>\n<plan>\n</plan>\n", {
    description: "Empty handoff",
  });
  const base = registryFor(() => 3);
  let calls = 0;
  const result = await recallMemory(settings, cwd, "handoff", {
    registry: {
      ...base,
      classify(model: unknown, request: any) {
        calls++;
        return base.classify(model, request);
      },
    },
  });
  assert.equal(calls, 0, "empty envelope must not be classified");
  assert.equal(result.content, "");
  assert.equal(result.diagnostics.memory.available, 0);
  assert.equal(result.diagnostics.memory.candidates, 0);
});

test("generated multilingual excerpts stay within budget and cite original source lines", async () => {
  for (const sentence of [
    "Persist records atomically, never truncate the old file.",
    "并发写入必须使用互斥锁，避免覆盖旧数据。",
  ]) {
    const { cwd, root, settings } = setupRecall();
    const source = path.join(root, "reference", "persistence.md");
    writeMemoryFile(source, `# Persistence\n${`${sentence}\n`.repeat(100)}`, { description: "Persistence" });
    const result = await recallMemory(settings, cwd, "prevent data loss", { registry: registryFor(() => 3) });
    assert.ok(Buffer.byteLength(result.content) <= 16 * 1024);
    assert.ok(result.excerptCount > 1);
    const lines = fs.readFileSync(source, "utf8").split("\n");
    for (const match of result.content.matchAll(/lines="(\d+)-(\d+)"[^>]*>\n([\s\S]*?)\n<\/excerpt>/g)) {
      const original = lines.slice(Number(match[1]) - 1, Number(match[2])).join("\n");
      assert.equal(match[3].trimEnd(), original.trimEnd());
    }
  }
});

test("Chinese local recall matches intent words within differently phrased source sentences", async () => {
  const { cwd, root, settings } = setupRecall();
  settings.tape!.context!.jev!.enabled = false;
  writeMemoryFile(
    path.join(root, "reference", "concurrency.md"),
    "# 并发控制\n使用互斥锁保护并发写入，防止数据丢失。",
    {
      description: "持久化约束",
    },
  );
  const result = await recallMemory(settings, cwd, "并发写入时怎样避免数据丢失");
  assert.match(result.content, /使用互斥锁保护并发写入/);
});

for (const gitEnabled of [true, false]) {
  test(`recall jointly ranks workspace and memory evidence with git=${gitEnabled}`, async () => {
    const { cwd, root, settings } = setupRecall();
    if (gitEnabled) initGitRepo(cwd);
    settings.tape!.context!.fileLimit = 2;
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "storage.ts"), "export function persist() {\n  return atomicRename();\n}\n");
    writeMemoryFile(
      path.join(root, "reference", "persistence.md"),
      "# Persistence\nUse atomic rename to avoid partial writes.",
      {
        description: "Persistence decisions",
      },
    );
    const kinds = new Set<string>();
    const base = registryFor(() => 3);
    const result = await recallMemory(settings, gitEnabled ? path.join(cwd, "src") : cwd, "persist atomically", {
      registry: {
        ...base,
        async classify(model: unknown, request: any) {
          for (const candidate of request.state.candidates) kinds.add(candidate.kind);
          return base.classify(model, request);
        },
      },
    });
    assert.deepEqual(kinds, new Set(["memory", "project"]));
    assert.match(result.content, /atomicRename/);
    assert.match(result.content, /avoid partial writes/);
    assert.match(result.content, /kind="project"/);
    assert.equal(result.fileCount, 2);
  });
}

test("workspace recall never opens denied paths or sends binary source content", async (context) => {
  const { cwd, root, settings } = setupRecall();
  initGitRepo(cwd);
  settings.localPath = path.join(cwd, "memories");
  settings.tape!.context!.blacklist = ["blocked.ts"];
  fs.writeFileSync(path.join(cwd, "blocked.ts"), "must not be read or sent");
  fs.writeFileSync(path.join(cwd, ".gitignore"), "ignored/\n");
  for (const relative of [
    "ignored/private.ts",
    "node_modules/dependency/index.ts",
    ".env.folder/private.ts",
    "dist/output.js",
  ]) {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "must not be read or sent");
  }
  const external = path.join(createTempDir("pi-recall-external"), "external.ts");
  fs.writeFileSync(external, "must not be read or sent");
  fs.symlinkSync(external, path.join(cwd, "escape.ts"));
  fs.symlinkSync(path.join(cwd, "ignored", "private.ts"), path.join(cwd, "alias.ts"));
  fs.writeFileSync(path.join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(cwd, "safe.ts"), "export const persistence = 'atomic';\n");
  const nested = path.join(cwd, "nested-project");
  fs.mkdirSync(nested);
  initGitRepo(nested);
  fs.writeFileSync(path.join(nested, "other.ts"), "must not be read or sent");
  writeMemoryFile(
    path.join(settings.localPath, "another-project", "private.md"),
    "# Private\nmust not be read or sent",
    { description: "Private" },
  );
  const opened: string[] = [];
  const open = fs.promises.open.bind(fs.promises);
  context.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    opened.push(String(args[0]));
    return open(...args);
  });
  const result = await recallMemory(settings, cwd, "persistence", {
    registry: registryFor((text) => {
      assert.doesNotMatch(text, /must not be read or sent/);
      return 3;
    }),
  });
  assert.match(result.content, /persistence/);
  assert.deepEqual(opened, [path.join(cwd, "binary.dat"), path.join(cwd, "safe.ts")]);
  assert.ok(!result.content.includes(root));
});

test("linked worktree recall never reads the main worktree's source files", async () => {
  const { cwd, settings } = setupRecall();
  initGitRepo(cwd);
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"],
    {
      cwd,
      stdio: "ignore",
    },
  );
  const worktree = createTempDir("pi-recall-worktree");
  execFileSync("git", ["worktree", "add", "-b", "scope-test", worktree], { cwd, stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, "main-only.ts"), "must not be read or sent");
  fs.symlinkSync(path.join(cwd, "main-only.ts"), path.join(worktree, "main-alias.ts"));
  fs.writeFileSync(path.join(worktree, "current.ts"), "export const persistence = 'current worktree';\n");
  writeMemoryFile(
    path.join(settings.localPath!, path.basename(worktree), "reference", "persistence.md"),
    "# Persistence\nHistorical persistence constraint.",
    { description: "Persistence" },
  );
  settings.tape!.context!.fileLimit = 2;
  const result = await recallMemory(settings, worktree, "persistence", {
    registry: registryFor((text) => {
      assert.doesNotMatch(text, /must not be read or sent/);
      return 3;
    }),
  });
  assert.match(result.content, /current worktree/);
  assert.match(result.content, /Historical persistence constraint/);
  assert.doesNotMatch(result.content, /main-only.ts|main-alias.ts/);
});

test("new prompts reuse source parsing while Jev evaluates each intent again", async (context) => {
  const { cwd, root, settings } = setupRecall();
  writeMemoryFile(
    path.join(root, "storage.md"),
    "# Encryption\nUse envelope encryption.\n\n# Retention\nKeep backups for thirty days.",
    {
      description: "Backup policies",
    },
  );
  const opened: string[] = [];
  const open = fs.promises.open.bind(fs.promises);
  context.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    opened.push(String(args[0]));
    return open(...args);
  });
  const intents: string[] = [];
  const registry = {
    getModelOfType: () => ({}),
    async classify(_model: unknown, request: any) {
      intents.push(request.state.intent);
      return {
        stopReason: "stop",
        answers: Object.fromEntries(
          request.state.candidates.map((candidate: any, index: number) => [
            `file_${index}`,
            {
              type: "score",
              score: candidate.excerpt.toLowerCase().includes(request.state.intent) ? 3 : 0,
              confidence: 1,
            },
          ]),
        ),
      };
    },
  };
  const first = await recallMemory(settings, cwd, "encryption", { registry });
  assert.match(first.content, /envelope encryption/);
  assert.doesNotMatch(first.content, /thirty days/);
  assert.equal(opened.length, 1);
  const second = await recallMemory(settings, cwd, "retention", { registry });
  assert.match(second.content, /thirty days/);
  assert.doesNotMatch(second.content, /envelope encryption/);
  assert.deepEqual(intents, ["encryption", "retention"]);
  assert.equal(opened.length, 1, "unchanged sources must not be reopened for a new query");
});

test("recall reprocesses only changed and new files and removes deleted evidence", async (context) => {
  const { cwd, root, settings } = setupRecall();
  settings.tape!.context!.jev!.enabled = false;
  settings.tape!.context!.fileLimit = 10;
  fs.mkdirSync(path.join(cwd, "src"));
  const source = path.join(cwd, "src", "storage.ts");
  fs.writeFileSync(source, "export const evidence = 'alpha';\n");
  writeMemoryFile(path.join(root, "stable.md"), "# Evidence\nKeep stable evidence.", { description: "Evidence" });
  const opened: string[] = [];
  const open = fs.promises.open.bind(fs.promises);
  context.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    opened.push(String(args[0]));
    return open(...args);
  });
  await recallMemory(settings, cwd, "evidence");
  assert.equal(opened.length, 2);
  opened.length = 0;
  const original = fs.statSync(source);
  fs.writeFileSync(source, "export const evidence = 'bravo';\n");
  fs.utimesSync(source, original.atime, original.mtime);
  const changed = await recallMemory(settings, cwd, "evidence");
  assert.match(changed.content, /bravo/);
  assert.doesNotMatch(changed.content, /alpha/);
  assert.deepEqual(opened, [source]);
  opened.length = 0;
  const rootMtime = fs.statSync(cwd).mtimeMs;
  const added = path.join(cwd, "src", "added.ts");
  fs.writeFileSync(added, "export const evidence = 'new nested evidence';\n");
  assert.equal(fs.statSync(cwd).mtimeMs, rootMtime);
  assert.match((await recallMemory(settings, cwd, "evidence")).content, /new nested evidence/);
  assert.deepEqual(opened, [added]);
  opened.length = 0;
  fs.unlinkSync(source);
  const deleted = await recallMemory(settings, cwd, "evidence");
  assert.doesNotMatch(deleted.content, /bravo/);
  assert.match(deleted.content, /Keep stable evidence/);
  assert.deepEqual(opened, []);
});

test("cached recall revalidates ignore rules, blacklist and shared-memory scope", async () => {
  const { cwd, root, settings } = setupRecall();
  settings.tape!.context!.jev!.enabled = false;
  settings.tape!.context!.fileLimit = 10;
  settings.memoryDir = { globalMemory: "shared" };
  fs.writeFileSync(path.join(cwd, "private.ts"), "export const evidence = 'workspace evidence';\n");
  writeMemoryFile(path.join(root, "project.md"), "# Evidence\nProject evidence.", { description: "Evidence" });
  writeMemoryFile(path.join(settings.localPath!, "shared", "global.md"), "# Evidence\nShared evidence.", {
    description: "Evidence",
  });
  const first = await recallMemory(settings, cwd, "evidence");
  assert.match(first.content, /workspace evidence/);
  assert.match(first.content, /Shared evidence/);
  fs.writeFileSync(path.join(cwd, ".gitignore"), "private.ts\n");
  const ignored = await recallMemory(settings, cwd, "evidence");
  assert.doesNotMatch(ignored.content, /workspace evidence/);
  settings.tape!.context!.blacklist = ["project.md"];
  settings.memoryDir = {};
  const narrowed = await recallMemory(settings, cwd, "evidence");
  assert.equal(narrowed.content, "");
  const other = createTempDir("pi-recall-other-workspace");
  fs.writeFileSync(path.join(other, "other.ts"), "export const evidence = 'other workspace evidence';\n");
  const switched = await recallMemory(settings, other, "evidence");
  assert.match(switched.content, /other workspace evidence/);
  assert.doesNotMatch(switched.content, /Project evidence|Shared evidence/);
});

test("cached source text cannot bypass a subsequent hidden symlink target", async (context) => {
  const { cwd, settings } = setupRecall();
  settings.tape!.context!.jev!.enabled = false;
  const source = path.join(cwd, "source.ts");
  fs.writeFileSync(source, "export const evidence = 'previously visible';\n");
  assert.match((await recallMemory(settings, cwd, "evidence")).content, /previously visible/);
  const hidden = path.join(cwd, ".env.fixture");
  fs.writeFileSync(hidden, "private fixture");
  fs.unlinkSync(source);
  fs.symlinkSync(hidden, source);
  context.mock.method(fs.promises, "open", async () => assert.fail("hidden source must not be opened"));
  assert.equal((await recallMemory(settings, cwd, "evidence")).content, "");
});

test("cancelled corpus updates do not publish partially refreshed source caches", async (context) => {
  const { cwd, settings } = setupRecall();
  settings.tape!.context!.jev!.enabled = false;
  const source = path.join(cwd, "source.ts");
  fs.writeFileSync(source, "export const evidence = 'old';\n");
  await recallMemory(settings, cwd, "evidence");
  fs.writeFileSync(source, "export const evidence = 'updated';\n");
  const controller = new AbortController();
  const open = fs.promises.open.bind(fs.promises);
  let reads = 0;
  context.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    reads++;
    const handle = await open(...args);
    if (reads === 1) controller.abort();
    return handle;
  });
  await assert.rejects(recallMemory(settings, cwd, "evidence", { signal: controller.signal }), /abort/i);
  assert.match((await recallMemory(settings, cwd, "evidence")).content, /updated/);
  assert.equal(reads, 2, "aborted updates must not replace the last complete corpus");
});

test("local recall returns no context for unmatched intent", async () => {
  const { cwd, root, settings } = setupRecall();
  settings.tape!.context!.jev!.enabled = false;
  writeMemoryFile(path.join(root, "reference", "storage.md"), "# Storage\nEncrypt backups with envelope keys.", {
    description: "Storage",
  });
  const result = await recallMemory(settings, cwd, "banana", {
    registry: { classify: () => assert.fail("local recall must not call Jev") },
  });
  assert.equal(result.content, "");
  assert.equal(result.fileCount, 0);
  assert.deepEqual(result.diagnostics.memory, {
    available: 1,
    candidates: 0,
    evaluated: 0,
    relevant: 0,
    injected: 0,
  });
});
