// Covers tape_handoff mode gating and accepted trigger combinations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTapeAnchorDelete, registerTapeHandoff, registerTapeSearch } from "../tape/tape-tools.js";

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
      createAnchor(name: string, type: string, meta?: unknown) {
        const anchor = {
          id: "anchor-1",
          timestamp: "2026-04-23T12:00:00.000Z",
          name,
          type,
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
    type: "handoff",
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
    type: "handoff",
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
    type: "handoff",
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
    type: "handoff",
    meta: { summary: "kw", purpose: "test", trigger: "keyword", keywords: ["tape", "memory"] },
  });
});

test("tape_search includes anchor ids for follow-up deletion", async () => {
  const harness = createToolHarness();
  const service = {
    getSessionId: () => "session-1",
    searchAnchorsWithFallback: () => [
      {
        id: "anchor-1",
        name: "task/delete-me",
        type: "handoff",
        timestamp: "2026-04-23T12:00:00.000Z",
        sessionId: "session-1",
        sessionEntryId: "entry-1",
      },
    ],
    scanEntriesWithFallback: () => [],
  };

  registerTapeSearch(harness.pi as never, () => service as never);
  const tool = harness.tools.get("tape_search");
  assert.ok(tool);

  const result = (await tool.execute("tool-call-1", { kinds: ["anchor"], scan: "delete-me" })) as any;

  assert.match(result.content[0].text, /id=anchor-1 task\/delete-me/);
});

test("tape_search can include nearby context for anchor results", async () => {
  const harness = createToolHarness();
  const service = {
    getSessionId: () => "session-1",
    searchAnchorsWithFallback: () => [
      {
        id: "anchor-1",
        name: "task/context",
        type: "handoff",
        timestamp: "2026-04-23T12:00:00.000Z",
        sessionId: "session-1",
        sessionEntryId: "entry-2",
      },
    ],
    scan: () => [
      {
        id: "entry-1",
        type: "message",
        timestamp: "2026-04-23T11:59:00.000Z",
        message: { role: "user", content: "before anchor" },
      },
      {
        id: "tool-empty",
        type: "message",
        timestamp: "2026-04-23T12:00:00.000Z",
        message: { role: "assistant", content: "" },
      },
      {
        id: "tool-result",
        type: "message",
        timestamp: "2026-04-23T12:00:01.000Z",
        message: {
          role: "assistant",
          content:
            '{"id":"anchor-1","name":"task/context","type":"handoff","timestamp":"2026-04-23T12:00:00.000Z","sessionId":"session-1","sessionEntryId":"entry-2"}',
        },
      },
      {
        id: "entry-2",
        type: "message",
        timestamp: "2026-04-23T12:01:00.000Z",
        message: { role: "assistant", content: "after anchor" },
      },
    ],
    scanEntriesWithFallback: () => [],
  };

  registerTapeSearch(harness.pi as never, () => service as never);
  const tool = harness.tools.get("tape_search");
  assert.ok(tool);

  const result = (await tool.execute("tool-call-1", { kinds: ["anchor"], contextLines: 1 })) as any;

  assert.match(result.content[0].text, /Before: .*before anchor/);
  assert.match(result.content[0].text, /After: .*after anchor/);
  assert.doesNotMatch(result.content[0].text, /sessionEntryId/);
});

test("tape_delete deletes exact ids only and supports batches", async () => {
  const harness = createToolHarness();
  const deletedIds: string[] = [];
  const service = {
    deleteAnchor(id: string) {
      deletedIds.push(id);
      return id === "missing" ? null : { id, name: `anchor/${id}` };
    },
  };

  registerTapeAnchorDelete(harness.pi as never, () => service as never);
  const tool = harness.tools.get("tape_delete");
  assert.ok(tool);

  const emptyResult = (await tool.execute("tool-call-1", {})) as any;
  assert.match(emptyResult.content[0].text, /Use tape_search first/);
  assert.equal(emptyResult.details.deleted, false);

  const result = (await tool.execute("tool-call-2", { id: " a1 ", ids: ["a2", "a1", "missing"] })) as any;
  assert.deepEqual(deletedIds, ["a1", "a2", "missing"]);
  assert.equal(result.details.deletedCount, 2);
  assert.match(result.content[0].text, /"id":"a1"/);
  assert.match(result.content[0].text, /"id":"a2"/);
});
