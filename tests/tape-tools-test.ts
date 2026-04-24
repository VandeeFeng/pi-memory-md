// Covers tape_handoff mode gating and accepted trigger combinations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTapeHandoff } from "../tape/tape-tools.js";

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

function createToolHarness() {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    pi: {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    },
  };
}

async function runHandoff(
  settings: Record<string, unknown>,
  params: Record<string, unknown>,
  tapeService?: { createAnchor: (...args: unknown[]) => unknown },
  consumeHandoffMatch: () =>
    | { trigger: "keyword"; instruction: { anchorName: string; matched: string[] } }
    | { trigger: "manual" }
    | null = () => null,
) {
  const harness = createToolHarness();
  const createdAnchors: unknown[] = [];
  const service =
    tapeService ??
    ({
      createAnchor(name: string, kind: string, meta?: unknown) {
        const anchor = {
          id: "anchor-1",
          timestamp: "2026-04-23T12:00:00.000Z",
          name,
          kind,
          meta,
        };
        createdAnchors.push(anchor);
        return anchor;
      },
    } as const);

  registerTapeHandoff(
    harness.pi as never,
    () => service as never,
    () => settings as never,
    consumeHandoffMatch as never,
  );
  const tool = harness.tools.get("tape_handoff");
  assert.ok(tool);

  const result = await tool.execute("tool-call-1", params);
  return { result, createdAnchors };
}

test("tape_handoff blocks direct calls when handoff mode is manual", async () => {
  const { result, createdAnchors } = await runHandoff(
    { tape: { anchor: { mode: "manual" } } },
    { name: "task/begin", summary: "manual test" },
  );

  assert.match((result as any).content[0].text, /disabled when tape\.anchor\.mode="manual"/);
  assert.equal((result as any).details.disabled, true);
  assert.deepEqual((result as any).details.allowedTriggers, ["keyword", "manual"]);
  assert.equal(createdAnchors.length, 0);
});

test("tape_handoff allows keyword and manual matches in manual mode", async () => {
  const keywordCall = await runHandoff(
    { tape: { anchor: { mode: "manual" } } },
    { name: "task/keyword", summary: "kw", purpose: "test" },
    undefined,
    () => ({ trigger: "keyword", instruction: { anchorName: "task/keyword", matched: ["tape"] } }),
  );
  const manualCall = await runHandoff(
    { tape: { anchor: { mode: "manual" } } },
    { name: "task/manual", summary: "manual", purpose: "test" },
    undefined,
    () => ({ trigger: "manual" }),
  );

  assert.equal(keywordCall.createdAnchors.length, 1);
  assert.deepEqual(keywordCall.createdAnchors[0], {
    id: "anchor-1",
    timestamp: "2026-04-23T12:00:00.000Z",
    name: "task/keyword",
    kind: "handoff",
    meta: { summary: "kw", purpose: "test", trigger: "keyword", keywords: ["tape"] },
  });
  assert.equal(manualCall.createdAnchors.length, 1);
  assert.equal((manualCall.createdAnchors[0] as any).meta.trigger, "manual");
});

test("tape_handoff allows direct calls in auto mode and defaults trigger to direct", async () => {
  const { result, createdAnchors } = await runHandoff(
    { tape: { anchor: { mode: "auto" } } },
    { name: "task/direct", summary: "ship it", purpose: "deploy" },
  );

  assert.equal(createdAnchors.length, 1);
  assert.deepEqual(createdAnchors[0], {
    id: "anchor-1",
    timestamp: "2026-04-23T12:00:00.000Z",
    name: "task/direct",
    kind: "handoff",
    meta: { summary: "ship it", purpose: "deploy", trigger: "direct" },
  });
  assert.equal((result as any).details.name, "task/direct");
});

test("tape_handoff downgrades mismatched keyword handoff match to direct", async () => {
  const { result, createdAnchors } = await runHandoff(
    { tape: { anchor: { mode: "auto" } } },
    { name: "task/fake-keyword", summary: "kw", purpose: "test" },
    undefined,
    () => ({ trigger: "keyword", instruction: { anchorName: "task/keyword", matched: ["tape"] } }),
  );

  assert.equal(createdAnchors.length, 1);
  assert.deepEqual(createdAnchors[0], {
    id: "anchor-1",
    timestamp: "2026-04-23T12:00:00.000Z",
    name: "task/fake-keyword",
    kind: "handoff",
    meta: { summary: "kw", purpose: "test", trigger: "direct" },
  });
  assert.equal((result as any).details.matchedKeywordHandoff, false);
  assert.equal((result as any).details.finalTrigger, "direct");
});

test("tape_handoff only accepts keyword handoff match when the anchor name matches this turn", async () => {
  const { createdAnchors } = await runHandoff(
    { tape: { anchor: { mode: "manual" } } },
    { name: "task/keyword", summary: "kw", purpose: "test" },
    undefined,
    () => ({ trigger: "keyword", instruction: { anchorName: "task/keyword", matched: ["tape", "memory"] } }),
  );

  assert.deepEqual(createdAnchors[0], {
    id: "anchor-1",
    timestamp: "2026-04-23T12:00:00.000Z",
    name: "task/keyword",
    kind: "handoff",
    meta: { summary: "kw", purpose: "test", trigger: "keyword", keywords: ["tape", "memory"] },
  });
});
