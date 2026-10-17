import assert from "node:assert/strict";
import { test } from "node:test";
import { rankTapeFiles, type TapeRelevanceReport } from "../tape/tape-relevance.js";

function makeFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `excerpt-${index}`,
    label: `${index}.md:1-2`,
    kind: "project" as const,
    excerpt: `# File ${index}\nimplementation`,
  }));
}

function makeRegistry(scores: number[]) {
  return {
    getModelOfType(type: string, provider: string, id: string) {
      assert.equal(type, "classifier");
      assert.equal(provider, "openrouter");
      assert.equal(id, "typesafe/jev-1.13");
      return { provider, id };
    },
    async classify() {
      return {
        stopReason: "stop",
        answers: Object.fromEntries(
          scores.map((score, index) => [`file_${index}`, { type: "score", score, confidence: 0.8 }]),
        ),
      };
    },
  };
}

test("Jev routes TypeSafe through pi with provider-specific defaults and pi token usage", async (contextTest) => {
  const files = makeFiles(2);
  contextTest.mock.method(globalThis, "fetch", async () =>
    Response.json({ usage: { input_tokens: 100, output_tokens: 20 } }),
  );
  for (const model of [undefined, " ", "jev-custom"]) {
    let report: TapeRelevanceReport | undefined;
    const registry = {
      getModelOfType(type: string, provider: string, id: string) {
        assert.equal(type, "classifier");
        assert.equal(provider, "typesafe");
        assert.equal(id, model?.trim() || "jev-latest");
        return { provider, id };
      },
      async classify(
        selected: unknown,
        request: any,
        options: { fetch: typeof globalThis.fetch; signal: AbortSignal },
      ) {
        assert.equal((selected as { provider: string }).provider, "typesafe");
        assert.equal(request.state.intent, "fix startup injection");
        assert.equal(Object.keys(request.questions).length, files.length);
        assert.equal(options.signal.aborted, false);
        await options.fetch("https://api.typesafe.ai/v1/systemone");
        return { ...(await makeRegistry([0, 3]).classify()), usage: { input: 101, output: 21, cost: { total: 0 } } };
      },
    };
    assert.deepEqual(
      await rankTapeFiles(
        files,
        "fix startup injection",
        { enabled: true, provider: "typesafe", model },
        {
          registry,
          onEvaluation: (value) => {
            report = value;
          },
        },
      ),
      [files[1].id],
    );
    assert.equal(report?.actualCostUsd, null);
    assert.deepEqual(report?.tokenUsage, { input: 101, output: 21 });
    assert.equal(report?.estimatedCostUsd, undefined);
  }
});

test("missing TypeSafe models and unknown providers never fall back to OpenRouter", async () => {
  for (const provider of ["typesafe", "unknown"] as const) {
    let lookups = 0;
    const registry = {
      getModelOfType(_type: string, selected: string) {
        lookups++;
        assert.equal(selected, "typesafe");
        return undefined;
      },
      async classify() {
        assert.fail("must not classify");
      },
    };
    assert.equal(
      await rankTapeFiles(
        makeFiles(1),
        "task",
        {
          enabled: true,
          provider: provider as "typesafe",
        },
        { registry },
      ),
      null,
    );
    assert.equal(lookups, provider === "typesafe" ? 1 : 0);
  }
});

test("disabled Jev, empty intent, older pi and missing models do not classify", async () => {
  const registry = {
    getModelOfType() {
      return undefined;
    },
    async classify() {
      assert.fail("must not classify");
    },
  };
  assert.equal(await rankTapeFiles([], "task", undefined, { registry }), null);
  assert.equal(await rankTapeFiles([], " ", { enabled: true }, { registry }), null);
  assert.equal(await rankTapeFiles([], "task", { enabled: true }, { registry: {} }), null);
  assert.equal(await rankTapeFiles([], "task", { enabled: true }, { registry }), null);
  assert.equal(await rankTapeFiles([], "task", { enabled: true }, { registry, signal: AbortSignal.abort() }), null);
});

test("Jev bounds batch, intent and supplied excerpts, and can select nothing", async () => {
  const files = makeFiles(35);
  files[0].excerpt = "evidence\n".repeat(1000);
  let calls = 0;
  const registry = {
    ...makeRegistry([]),
    async classify(_model: unknown, context: any) {
      calls++;
      assert.equal(context.state.intent.length, 2000);
      assert.ok(context.state.candidates.length <= 30);
      assert.ok(context.state.candidates.every((candidate: any) => candidate.excerpt.length <= 3000));
      assert.equal(context.state.candidates[0].truncated, true);
      assert.equal(context.state.candidates[1].truncated, false);
      return {
        stopReason: "stop",
        answers: Object.fromEntries(
          Object.keys(context.questions).map((id) => [id, { type: "score", score: 0, confidence: 1 }]),
        ),
      };
    },
  };
  assert.deepEqual(await rankTapeFiles(files, "target ".repeat(1000), { enabled: true }, { registry }), []);
  assert.equal(calls, 1);
});

test("generated relevance scores never invent candidates or violate threshold and stable ordering", async () => {
  const files = makeFiles(3).map((file, index) => ({
    ...file,
    kind: index % 2 === 0 ? ("project" as const) : ("memory" as const),
  }));
  for (const first of [0, 1.5, 3]) {
    for (const second of [0, 1.5, 3]) {
      for (const third of [0, 1.5, 3]) {
        const scores = [first, second, third];
        const registry = {
          ...makeRegistry(scores),
          async classify(_model: unknown, request: any) {
            assert.deepEqual(
              request.state.candidates.map((candidate: any) => candidate.kind),
              files.map((file) => file.kind),
            );
            return makeRegistry(scores).classify();
          },
        };
        const expected = files
          .map((file, index) => ({ ...file, score: scores[index] }))
          .filter((file) => file.score >= 1.5)
          .sort((left, right) => right.score - left.score)
          .map((file) => file.id);
        assert.deepEqual(await rankTapeFiles(files, "task", { enabled: true }, { registry }), expected);
      }
    }
  }
});

test("Jev failures and malformed or incomplete batches return no selection", async () => {
  const files = makeFiles(1);
  const invalidAnswers = [
    {},
    { file_0: { type: "noul", score: 2, confidence: 1 } },
    ...[-1, 3.1, "2", null].map((score) => ({ file_0: { type: "score", score, confidence: 1 } })),
    { file_0: { type: "score", score: 2, confidence: 2 } },
  ];
  for (const answers of invalidAnswers) {
    const registry = {
      ...makeRegistry([]),
      async classify() {
        return { stopReason: "stop", answers };
      },
    };
    assert.equal(await rankTapeFiles(files, "task", { enabled: true }, { registry }), null);
  }
  for (const stopReason of ["error", "aborted"]) {
    const registry = {
      ...makeRegistry([]),
      async classify() {
        return { stopReason, answers: {} };
      },
    };
    assert.equal(await rankTapeFiles(files, "task", { enabled: true }, { registry }), null);
  }
  const registry = {
    ...makeRegistry([]),
    async classify() {
      throw new Error("provider failed");
    },
  };
  assert.equal(await rankTapeFiles(files, "task", { enabled: true }, { registry }), null);
});

test("Jev reports wire billing, not catalog estimates, even when answers fail", async (contextTest) => {
  const files = makeFiles(1);
  let wireCost: unknown = 0.00001234;
  let malformed = false;
  contextTest.mock.method(globalThis, "fetch", async () => Response.json({ usage: { cost: wireCost } }));
  const registry = {
    ...makeRegistry([3]),
    async classify(_model: unknown, _context: unknown, options: { fetch: typeof globalThis.fetch }) {
      const response = await options.fetch("https://openrouter.ai/api/v1/systemone");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { usage: { cost: unknown } };
      assert.equal(body.usage.cost, wireCost);
      return {
        stopReason: "stop",
        answers: malformed ? {} : { file_0: { type: "score", score: 3, confidence: 1 } },
        usage: { cost: { total: 99 } },
      };
    },
  };
  let report: TapeRelevanceReport | undefined;
  const options = {
    registry,
    onEvaluation: (value: TapeRelevanceReport) => {
      report = value;
    },
  };
  assert.deepEqual(await rankTapeFiles(files, "task", { enabled: true }, options), [files[0].id]);
  assert.deepEqual(report, {
    status: "ranked",
    candidates: 1,
    relevant: 1,
    actualCostUsd: wireCost,
    estimatedCostUsd: 99,
  });
  malformed = true;
  assert.equal(await rankTapeFiles(files, "task", { enabled: true }, options), null);
  assert.deepEqual(report, {
    status: "fallback",
    candidates: 1,
    relevant: 0,
    actualCostUsd: wireCost,
    estimatedCostUsd: 99,
    reason: "invalid-answer",
  });
  malformed = false;
  for (wireCost of [0, null, -1, "0.01"]) {
    await rankTapeFiles(files, "task", { enabled: true }, options);
    assert.equal(report?.actualCostUsd, wireCost === 0 ? 0 : null);
  }
});

test("Jev passes its bounded deadline to pi's classifier", async () => {
  const files = makeFiles(1);
  const registry = {
    ...makeRegistry([]),
    async classify(_model: unknown, _context: unknown, options: { signal: AbortSignal }) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => assert.fail("deadline not enforced"), 1000);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve({ stopReason: "aborted", answers: {} });
          },
          { once: true },
        );
      });
    },
  };
  assert.equal(await rankTapeFiles(files, "task", { enabled: true, timeoutMs: 5 }, { registry }), null);
});
