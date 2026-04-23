// Covers anchor persistence, lookup, filtering, deletion, and on-disk index rebuild behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TapeAnchor } from "../tape/tape-anchor.js";
import { AnchorStore } from "../tape/tape-anchor.js";
import { createTempDir, writeText } from "./test-helpers.js";

function createStore(projectName = "demo-project") {
  const tapeBasePath = createTempDir("pi-memory-md-tape-anchor");
  return {
    tapeBasePath,
    projectName,
    store: new AnchorStore(tapeBasePath, projectName),
    indexPath: path.join(tapeBasePath, `${projectName}__anchors.jsonl`),
  };
}

function createAnchor(overrides: Partial<TapeAnchor>): TapeAnchor {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "handoff/default",
    kind: overrides.kind ?? "handoff",
    sessionId: overrides.sessionId ?? "session-1",
    sessionEntryId: overrides.sessionEntryId ?? "entry-1",
    timestamp: overrides.timestamp ?? "2026-04-23T10:00:00.000Z",
    meta: overrides.meta,
  };
}

test("AnchorStore persists appended anchors and reloads them from disk", () => {
  const { tapeBasePath, projectName, store } = createStore();
  const anchor = createAnchor({
    id: "anchor-1",
    name: "task/begin",
    timestamp: "2026-04-23T10:00:00.000Z",
    meta: { summary: "start task", purpose: "task" },
  });

  store.append(anchor);

  const reloadedStore = new AnchorStore(tapeBasePath, projectName);
  const loadedAnchor = reloadedStore.findById("anchor-1");

  assert.deepEqual(loadedAnchor, anchor);
});

test("AnchorStore skips malformed and incomplete JSONL lines during load", () => {
  const { tapeBasePath, projectName, indexPath } = createStore();

  writeText(
    indexPath,
    [
      "not-json",
      JSON.stringify({ id: "missing-fields", name: "bad" }),
      JSON.stringify(
        createAnchor({
          id: "fallback-id-source",
          name: "task/ok",
          sessionEntryId: "entry-9",
          timestamp: "2026-04-23T12:00:00.000Z",
        }),
      ),
      JSON.stringify({
        name: "task/fallback-id",
        kind: "handoff",
        sessionId: "session-1",
        sessionEntryId: "entry-10",
        timestamp: "2026-04-23T12:30:00.000Z",
      }),
    ].join("\n"),
  );

  const store = new AnchorStore(tapeBasePath, projectName);
  const anchors = store.getAllAnchors();

  assert.equal(anchors.length, 2);
  assert.equal(anchors[0]?.id, "fallback-id-source");
  assert.equal(anchors[1]?.id, "entry-10:2026-04-23T12:30:00.000Z:task/fallback-id");
});

test("AnchorStore find helpers return newest matching anchors", () => {
  const { store } = createStore();
  const anchors = [
    createAnchor({ id: "a1", name: "task/checkpoint", sessionId: "session-1", timestamp: "2026-04-23T10:00:00.000Z" }),
    createAnchor({ id: "a2", name: "task/checkpoint", sessionId: "session-2", timestamp: "2026-04-23T11:00:00.000Z" }),
    createAnchor({ id: "a3", name: "task/checkpoint", sessionId: "session-1", timestamp: "2026-04-23T12:00:00.000Z" }),
  ];

  for (const anchor of anchors) {
    store.append(anchor);
  }

  assert.equal(store.findByName("task/checkpoint")?.id, "a3");
  assert.equal(store.findByNameInSession("task/checkpoint", "session-2")?.id, "a2");
  assert.equal(store.findByNameInSession("task/checkpoint", "session-1")?.id, "a3");
  assert.equal(store.getLastAnchor()?.id, "a3");
  assert.equal(store.getLastAnchor("session-2")?.id, "a2");
});

test("AnchorStore search combines filters for session, range, name, meta, and keywords", () => {
  const { store } = createStore();
  const anchors = [
    createAnchor({
      id: "a1",
      name: "task/plan",
      kind: "handoff",
      sessionId: "session-1",
      timestamp: "2026-04-23T10:00:00.000Z",
      meta: { summary: "plan release", purpose: "plan", keywords: ["release", "urgent"] },
    }),
    createAnchor({
      id: "a2",
      name: "session/new",
      kind: "session",
      sessionId: "session-2",
      timestamp: "2026-04-23T11:00:00.000Z",
      meta: { summary: "resume work", purpose: "resume", keywords: ["followup"] },
    }),
    createAnchor({
      id: "a3",
      name: "task/release",
      kind: "handoff",
      sessionId: "session-1",
      timestamp: "2026-04-23T12:00:00.000Z",
      meta: { summary: "ship release", purpose: "deploy", keywords: ["release", "prod"] },
    }),
  ];

  for (const anchor of anchors) {
    store.append(anchor);
  }

  assert.deepEqual(
    store
      .search({ sessionId: "session-1", kind: "handoff", since: "2026-04-23T11:30:00.000Z" })
      .map((anchor) => anchor.id),
    ["a3"],
  );
  assert.deepEqual(
    store.search({ name: "release" }).map((anchor) => anchor.id),
    ["a3"],
  );
  assert.deepEqual(
    store.search({ query: "resume" }).map((anchor) => anchor.id),
    ["a2"],
  );
  assert.deepEqual(
    store.search({ summary: "ship", purpose: "deploy" }).map((anchor) => anchor.id),
    ["a3"],
  );
  assert.deepEqual(
    store.search({ keywords: ["release"] }).map((anchor) => anchor.id),
    ["a1", "a3"],
  );
  assert.deepEqual(
    store.search({ keywords: ["release", "prod"] }).map((anchor) => anchor.id),
    ["a3"],
  );
  assert.deepEqual(
    store.search({ until: "2026-04-23T11:00:00.000Z", limit: 5 }).map((anchor) => anchor.id),
    ["a1", "a2"],
  );
});

test("AnchorStore removeById rebuilds the file and updates in-memory index", () => {
  const { store, indexPath } = createStore();
  const anchorOne = createAnchor({ id: "a1", name: "task/one", timestamp: "2026-04-23T10:00:00.000Z" });
  const anchorTwo = createAnchor({ id: "a2", name: "task/two", timestamp: "2026-04-23T11:00:00.000Z" });

  store.append(anchorOne);
  store.append(anchorTwo);

  const removed = store.removeById("a1");
  const fileContent = fs.readFileSync(indexPath, "utf-8");

  assert.deepEqual(removed, anchorOne);
  assert.equal(store.findById("a1"), null);
  assert.equal(store.findById("a2")?.id, "a2");
  assert.doesNotMatch(fileContent, /"id":"a1"/);
  assert.match(fileContent, /"id":"a2"/);
});

test("AnchorStore clear removes persisted index file and all anchors", () => {
  const { store, indexPath } = createStore();

  store.append(createAnchor({ id: "a1", name: "task/one" }));
  assert.equal(fs.existsSync(indexPath), true);

  store.clear();

  assert.equal(store.getAllAnchors().length, 0);
  assert.equal(fs.existsSync(indexPath), false);
});
