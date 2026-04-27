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

  const _reloadedStore = new AnchorStore(tapeBasePath, projectName);
  const loadedAnchor = store.query({ id: "anchor-1" })[0];

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

test("AnchorStore query returns newest matching anchors", () => {
  const { store } = createStore();
  const anchors = [
    createAnchor({ id: "a1", name: "task/checkpoint", sessionId: "session-1", timestamp: "2026-04-23T10:00:00.000Z" }),
    createAnchor({ id: "a2", name: "task/checkpoint", sessionId: "session-2", timestamp: "2026-04-23T11:00:00.000Z" }),
    createAnchor({ id: "a3", name: "task/checkpoint", sessionId: "session-1", timestamp: "2026-04-23T12:00:00.000Z" }),
  ];

  for (const anchor of anchors) {
    store.append(anchor);
  }

  // query by name returns newest in that session
  assert.equal(store.query({ name: "task/checkpoint", nameCaseInsensitive: true, returnMode: "last" })[0]?.id, "a3");

  // query by name + session returns newest
  assert.equal(
    store.query({ name: "task/checkpoint", nameCaseInsensitive: true, sessionId: "session-2", returnMode: "last" })[0]
      ?.id,
    "a2",
  );
  assert.equal(
    store.query({ name: "task/checkpoint", nameCaseInsensitive: true, sessionId: "session-1", returnMode: "last" })[0]
      ?.id,
    "a3",
  );

  // getAllAnchors and query for last
  const all = store.getAllAnchors();
  assert.equal(all[all.length - 1]?.id, "a3");
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
  assert.equal(store.query({ id: "a1" }).length, 0);
  assert.equal(store.query({ id: "a2" })[0]?.id, "a2");
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

test("AnchorStore queryFile filters by id, name, sessionId and supports returnMode", () => {
  const { store } = createStore();
  const anchors = [
    createAnchor({ id: "id-1", name: "task/alpha", sessionId: "s1", timestamp: "2026-04-23T10:00:00.000Z" }),
    createAnchor({ id: "id-2", name: "task/alpha", sessionId: "s2", timestamp: "2026-04-23T11:00:00.000Z" }),
    createAnchor({ id: "id-3", name: "task/alpha", sessionId: "s1", timestamp: "2026-04-23T12:00:00.000Z" }),
  ];
  for (const anchor of anchors) {
    store.append(anchor);
  }

  // Access private queryFile via any
  const queryFile = (store as any).queryFile.bind(store);

  // Filter by id
  const byId = queryFile({ id: "id-2" });
  assert.equal(byId.length, 1);
  assert.equal(byId[0]?.id, "id-2");

  // Filter by sessionId
  const bySession = queryFile({ sessionId: "s1" });
  assert.equal(bySession.length, 2);

  // Filter by name (case insensitive) returns sorted by timestamp
  const byName = queryFile({ name: "task/alpha", nameCaseInsensitive: true });
  assert.equal(byName.length, 3);

  // returnMode: first returns only the newest
  const latest = queryFile({ id: "id-1", returnMode: "first" });
  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.id, "id-1");

  const latestBySession = queryFile({ sessionId: "s1", returnMode: "first" });
  assert.equal(latestBySession.length, 1);
  assert.equal(latestBySession[0]?.id, "id-3");
});

test("AnchorStore file fallback populates memory index after file search", () => {
  const { tapeBasePath, projectName, indexPath } = createStore();

  const anchors = [
    createAnchor({ id: "older-1", name: "task/old", sessionId: "s1", timestamp: "2026-04-23T10:00:00.000Z" }),
    createAnchor({ id: "older-2", name: "task/old", sessionId: "s1", timestamp: "2026-04-23T11:00:00.000Z" }),
  ];
  writeText(indexPath, `${anchors.map((a) => JSON.stringify(a)).join("\n")}\n`);

  const store = new AnchorStore(tapeBasePath, projectName);

  assert.equal(store.getAllAnchors().length, 2);

  // query should work
  const found = store.query({ id: "older-1" });
  assert.equal(found[0]?.id, "older-1");

  // After query, memory should still have all anchors
  assert.equal(store.getAllAnchors().length, 2);
});

test("AnchorStore case-insensitive query works for both memory and file fallback", () => {
  const { store } = createStore();
  store.append(createAnchor({ id: "a1", name: "Task/Begin", sessionId: "s1" }));

  // Case-insensitive match
  assert.equal(store.query({ name: "task/begin", nameCaseInsensitive: true, returnMode: "last" })[0]?.id, "a1");
  assert.equal(store.query({ name: "TASK/BEGIN", nameCaseInsensitive: true, returnMode: "last" })[0]?.id, "a1");

  // query with session filter
  assert.equal(
    store.query({ name: "task/begin", nameCaseInsensitive: true, sessionId: "s1", returnMode: "last" })[0]?.id,
    "a1",
  );

  // Multiple matches
  store.append(createAnchor({ id: "a2", name: "Task/Begin", sessionId: "s2" }));
  const all = store.query({ name: "task/begin", nameCaseInsensitive: true });
  assert.equal(all.length, 2);
});

test("AnchorStore query unifies find operations with returnMode", () => {
  const { store } = createStore();
  const anchors = [
    createAnchor({
      id: "a1",
      name: "task/alpha",
      sessionId: "s1",
      sessionEntryId: "e1",
      timestamp: "2026-04-23T10:00:00.000Z",
    }),
    createAnchor({
      id: "a2",
      name: "task/alpha",
      sessionId: "s2",
      sessionEntryId: "e2",
      timestamp: "2026-04-23T11:00:00.000Z",
    }),
    createAnchor({
      id: "a3",
      name: "task/alpha",
      sessionId: "s1",
      sessionEntryId: "e3",
      timestamp: "2026-04-23T12:00:00.000Z",
    }),
    createAnchor({
      id: "a4",
      name: "task/beta",
      sessionId: "s1",
      sessionEntryId: "e4",
      timestamp: "2026-04-23T13:00:00.000Z",
    }),
  ];
  for (const anchor of anchors) {
    store.append(anchor);
  }

  // query by id
  const byId = store.query({ id: "a2" });
  assert.equal(byId.length, 1);
  assert.equal(byId[0]?.id, "a2");

  // query by name (case insensitive)
  const byName = store.query({ name: "TASK/ALPHA", nameCaseInsensitive: true });
  assert.equal(byName.length, 3);

  // query by sessionId
  const bySession = store.query({ sessionId: "s1" });
  assert.equal(bySession.length, 3);

  // query by sessionEntryId
  const byEntryId = store.query({ sessionEntryId: "e3" });
  assert.equal(byEntryId.length, 1);
  assert.equal(byEntryId[0]?.id, "a3");

  // query with multiple filters
  const byNameAndSession = store.query({ name: "task/alpha", nameCaseInsensitive: true, sessionId: "s1" });
  assert.equal(byNameAndSession.length, 2);

  // returnMode: first returns newest
  const first = store.query({ sessionId: "s1", returnMode: "first" });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.id, "a4");

  // returnMode: last is alias for first (newest)
  const last = store.query({ sessionId: "s1", returnMode: "last" });
  assert.equal(last.length, 1);
  assert.equal(last[0]?.id, "a4");

  // returnMode: all returns all
  const all = store.query({ sessionId: "s1", returnMode: "all" });
  assert.equal(all.length, 3);

  // query with no matches
  const empty = store.query({ id: "nonexistent" });
  assert.equal(empty.length, 0);
});

test("AnchorStore query supports sessionEntryId with optional sessionId filter", () => {
  const { store } = createStore();
  const anchors = [
    createAnchor({ id: "a1", name: "task/one", sessionId: "s1", sessionEntryId: "e1" }),
    createAnchor({ id: "a2", name: "task/two", sessionId: "s2", sessionEntryId: "e1" }), // same entryId, different session
  ];
  for (const anchor of anchors) {
    store.append(anchor);
  }

  // query by sessionEntryId without sessionId - returns all matches
  const byEntryId = store.query({ sessionEntryId: "e1" });
  assert.equal(byEntryId.length, 2);

  // query by sessionEntryId with sessionId - returns filtered
  const byEntryIdAndSession = store.query({ sessionEntryId: "e1", sessionId: "s1" });
  assert.equal(byEntryIdAndSession.length, 1);
  assert.equal(byEntryIdAndSession[0]?.id, "a1");
});
