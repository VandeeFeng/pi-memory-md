// Covers session anchors, entry querying, and tree-label synchronization across tape sessions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { TapeService } from "../tape/tape-service.js";
import { createTempDir, writeText } from "./test-helpers.js";

type MockSessionManager = {
  getLeafId: () => string | null;
  getSessionId: () => string;
  getEntry: (id: string) => SessionEntry | undefined;
  getEntries: () => SessionEntry[];
  getLabel: (id: string) => string | undefined;
  labelsById: Map<string, string>;
  labelTimestampsById: Map<string, string>;
};

function createMessageEntry(
  id: string,
  timestamp: string,
  role: "user" | "assistant",
  content: unknown,
  parentId?: string,
): SessionEntry {
  return {
    id,
    type: "message",
    timestamp,
    parentId,
    message: { role, content },
  } as SessionEntry;
}

function createSessionManager(entries: SessionEntry[], leafId?: string): MockSessionManager {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const labelsById = new Map<string, string>();
  const labelTimestampsById = new Map<string, string>();

  return {
    getLeafId: () => leafId ?? entries[entries.length - 1]?.id ?? null,
    getSessionId: () => "session-1",
    getEntry: (id) => byId.get(id),
    getEntries: () => entries,
    getLabel: (id) => labelsById.get(id),
    labelsById,
    labelTimestampsById,
  };
}

function writeSessionFile(
  agentDir: string,
  cwd: string,
  fileName: string,
  sessionId: string,
  entries: SessionEntry[],
): void {
  const encodedPath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = path.join(agentDir, "sessions", encodedPath);
  const lines = [JSON.stringify({ type: "session", id: sessionId })];

  for (const entry of entries) {
    lines.push(JSON.stringify(entry));
  }

  writeText(path.join(sessionDir, fileName), `${lines.join("\n")}\n`);
}

test("recordSessionStart chooses session/new for new startup and session/resume otherwise", () => {
  const tapeBasePath = createTempDir("pi-memory-md-tape-service-start");
  const cwd = createTempDir("pi-memory-md-cwd-start");
  const service = TapeService.create(tapeBasePath, "demo", "session-1", cwd);
  const emptyManager = createSessionManager([]);

  service.configureSessionTree(emptyManager as never);
  const startupAnchor = service.recordSessionStart("startup");
  const newAnchor = service.recordSessionStart("new");

  const populatedService = TapeService.create(tapeBasePath, "demo-2", "session-1", cwd);
  populatedService.configureSessionTree(
    createSessionManager([createMessageEntry("e1", "2026-04-23T10:00:00.000Z", "user", "hello")]) as never,
  );
  const resumeAnchor = populatedService.recordSessionStart("startup");

  assert.equal(startupAnchor.name, "session/new");
  assert.equal(newAnchor.name, "session/new");
  assert.equal(resumeAnchor.name, "session/resume");
});

test("createAnchor binds current session id and active session entry id", () => {
  const tapeBasePath = createTempDir("pi-memory-md-tape-service-create");
  const cwd = createTempDir("pi-memory-md-cwd-create");
  const service = TapeService.create(tapeBasePath, "demo", "session-xyz", cwd);

  service.configureSessionTree(
    createSessionManager(
      [createMessageEntry("leaf-1", "2026-04-23T10:00:00.000Z", "user", "hello")],
      "leaf-1",
    ) as never,
  );

  const anchor = service.createAnchor("task/begin", "handoff", { summary: "start work" }, false);

  assert.equal(anchor.sessionId, "session-xyz");
  assert.equal(anchor.sessionEntryId, "leaf-1");
  assert.equal(anchor.name, "task/begin");
  assert.equal(anchor.type, "handoff");
  assert.equal(service.getAnchorStore().scan({ id: anchor.id, mode: "latest" })[0]?.meta?.summary, "start work");
});

test("scan supports scope, types, limit, scan, anchors, and date ranges", () => {
  const tapeBasePath = createTempDir("pi-memory-md-tape-service-scan");
  const cwd = createTempDir("pi-memory-md-cwd-scan");
  const agentDir = createTempDir("pi-memory-md-agent-scan");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const sessionEntries = [
    createMessageEntry("a1", "2026-04-23T10:00:00.000Z", "user", "alpha bug"),
    createMessageEntry("a2", "2026-04-23T10:10:00.000Z", "assistant", "beta"),
    {
      id: "a3",
      type: "compaction",
      timestamp: "2026-04-23T10:20:00.000Z",
      summary: "gamma summary",
    } as SessionEntry,
    createMessageEntry("a4", "2026-04-23T10:30:00.000Z", "assistant", "delta bug"),
  ];
  const otherEntries = [createMessageEntry("b1", "2026-04-23T11:00:00.000Z", "user", "project only")];

  writeSessionFile(agentDir, cwd, "session-1.jsonl", "session-1", sessionEntries);
  writeSessionFile(agentDir, cwd, "session-2.jsonl", "session-2", otherEntries);

  try {
    const service = TapeService.create(tapeBasePath, "demo", "session-1", cwd);
    service.createAnchor("mark/start", "handoff", undefined, false);
    service.createAnchor("mark/end", "handoff", undefined, false);

    const anchors = service.getAnchorStore().scan({ name: "mark/start", nameCaseInsensitive: true });
    const endAnchor = service.getAnchorStore().scan({ name: "mark/end", nameCaseInsensitive: true, mode: "latest" })[0];
    anchors[0]!.timestamp = "2026-04-23T10:05:00.000Z";
    endAnchor!.timestamp = "2026-04-23T10:25:00.000Z";

    const storeFile = path.join(tapeBasePath, "demo__anchors.jsonl");
    fs.writeFileSync(
      storeFile,
      `${service
        .getAnchorStore()
        .getAllAnchors()
        .map((anchor) => JSON.stringify(anchor))
        .join("\n")}\n`,
    );

    assert.equal(service.scan({ entryScope: "session" }).length, 4);
    assert.equal(service.scan({ entryScope: "project" }).length, 5);
    assert.deepEqual(
      service.scan({ entryScope: "session", types: ["compaction"] }).map((entry) => entry.id),
      ["a3"],
    );
    assert.deepEqual(
      service.scan({ entryScope: "session", scan: "bug" }).map((entry) => entry.id),
      ["a1", "a4"],
    );
    assert.deepEqual(
      service.scan({ entryScope: "session", limit: 2 }).map((entry) => entry.id),
      ["a3", "a4"],
    );
    assert.deepEqual(
      service.scan({ entryScope: "session", sinceAnchor: "mark/start" }).map((entry) => entry.id),
      ["a2", "a3", "a4"],
    );
    assert.deepEqual(
      service
        .scan({ entryScope: "session", betweenAnchors: { start: "mark/start", end: "mark/end" } })
        .map((entry) => entry.id),
      ["a2", "a3"],
    );
    assert.deepEqual(
      service
        .scan({
          entryScope: "session",
          betweenDates: { start: "2026-04-23T10:15:00.000Z", end: "2026-04-23T10:35:00.000Z" },
        })
        .map((entry) => entry.id),
      ["a3", "a4"],
    );
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("configureSessionTree syncs labels and clears old prefix labels when prefix changes", () => {
  const tapeBasePath = createTempDir("pi-memory-md-tape-service-labels");
  const cwd = createTempDir("pi-memory-md-cwd-labels");
  const root = createMessageEntry("root", "2026-04-23T10:00:00.000Z", "assistant", [], undefined);
  const child = createMessageEntry("child", "2026-04-23T10:01:00.000Z", "assistant", "visible text", "root");
  const manager = createSessionManager([root, child], "root");

  manager.labelsById.set("child", "Base label");

  const service = TapeService.create(tapeBasePath, "demo", "session-1", cwd);
  service.configureSessionTree(manager as never, "⚓ ");

  const anchor = service.createAnchor("task/one", "handoff");
  assert.equal(manager.labelsById.get("child"), "Base label · ⚓ task/one");
  assert.equal(service.getLastAnchor()?.id, anchor.id);

  service.configureSessionTree(manager as never, "ANCHOR: ");

  assert.equal(manager.labelsById.get("child"), "Base label · ANCHOR: task/one");
  service.deleteAnchor(anchor.id);
  assert.equal(manager.labelsById.get("child"), "Base label");
});

test("scope and anchorScope combinations control anchor lookup behavior", () => {
  const tapeBasePath = createTempDir("pi-memory-md-tape-service-scope-combo");
  const cwd = createTempDir("pi-memory-md-cwd-scope-combo");
  const agentDir = createTempDir("pi-memory-md-agent-scope-combo");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // Session 1 entries
  const session1Entries = [
    createMessageEntry("s1-e1", "2026-04-23T10:00:00.000Z", "user", "session1 early"),
    createMessageEntry("s1-e2", "2026-04-23T10:10:00.000Z", "assistant", "session1 late"),
  ];
  // Session 2 entries
  const session2Entries = [createMessageEntry("s2-e1", "2026-04-23T11:00:00.000Z", "user", "session2 only")];

  writeSessionFile(agentDir, cwd, "session-1.jsonl", "session-1", session1Entries);
  writeSessionFile(agentDir, cwd, "session-2.jsonl", "session-2", session2Entries);

  try {
    // Create session-1 service and anchors
    const service = TapeService.create(tapeBasePath, "demo", "session-1", cwd);
    service.createAnchor("anchor/s1-start", "handoff", undefined, false);
    service.createAnchor("anchor/shared", "handoff", { summary: "session-1 version" }, false);

    // Create session-2 service and anchors
    const service2 = TapeService.create(tapeBasePath, "demo", "session-2", cwd);
    service2.createAnchor("anchor/s2-only", "handoff", undefined, false);
    service2.createAnchor("anchor/shared", "handoff", { summary: "session-2 version" }, false);

    // Test 1: anchorScope="session" finds anchors in current session only
    // Use a fresh service instance to ensure file sync
    const service1Refreshed = TapeService.create(tapeBasePath, "demo", "session-1", cwd);
    const currentOnly = service1Refreshed.getLastAnchor("session");
    assert.equal(currentOnly?.sessionId, "session-1");
    assert.equal(currentOnly?.name, "anchor/shared");

    // Test 2: anchorScope="project" from session-2 finds session-2's latest anchor
    const projectScope = service2.getLastAnchor("project");
    assert.equal(projectScope?.sessionId, "session-2");

    // Test 3: anchorScope="project" from session-1 also finds session-2's latest anchor (after file sync)
    const service1ProjectScope = service1Refreshed.getLastAnchor("project");
    assert.equal(service1ProjectScope?.sessionId, "session-2");

    // Test 4: findAnchorByName with session scope from session-1
    const foundInCurrent = service1Refreshed.findAnchorByName("anchor/shared", "session");
    assert.equal(foundInCurrent?.sessionId, "session-1");
    assert.equal(foundInCurrent?.meta?.summary, "session-1 version");

    // Test 5: findAnchorByName with project scope returns latest across sessions
    const foundInProject = service1Refreshed.findAnchorByName("anchor/shared", "project");
    assert.equal(foundInProject?.sessionId, "session-2");
    assert.equal(foundInProject?.meta?.summary, "session-2 version");

    // Test 6: anchor that exists only in session-1
    const s1OnlyAnchor = service1Refreshed.findAnchorByName("anchor/s1-start", "session");
    assert.ok(s1OnlyAnchor !== null);
    assert.equal(s1OnlyAnchor?.sessionId, "session-1");

    // Test 7: anchor that exists only in session-2, found via project scope from session-1
    const s2OnlyViaProject = service1Refreshed.findAnchorByName("anchor/s2-only", "project");
    assert.ok(s2OnlyViaProject !== null);
    assert.equal(s2OnlyViaProject?.sessionId, "session-2");

    // Test 7: resolveAnchor's session scope has fallback to project scope
    // Note: resolveAnchor falls back to project scope if not found in current session
    const s2OnlyViaCurrent = service1Refreshed.findAnchorByName("anchor/s2-only", "session");
    assert.ok(s2OnlyViaCurrent !== null); // Found via fallback
    assert.equal(s2OnlyViaCurrent?.sessionId, "session-2");

    // Test 7b: To truly restrict to current session, use scan with explicit sessionId filter
    const s2OnlyStrict = service1Refreshed.getAnchorStore().scan({
      name: "anchor/s2-only",
      nameCaseInsensitive: true,
      sessionId: "session-1",
      mode: "latest",
    })[0];
    assert.equal(s2OnlyStrict, undefined); // Not found in session-1

    // Test 8: Verify entries can be read independently from anchors (scope is separate concern)
    const entriesCurrent = service1Refreshed.scan({ entryScope: "session" });
    const entriesProject = service1Refreshed.scan({ entryScope: "project" });
    assert.ok(entriesCurrent.length >= 2); // session-1 entries
    assert.ok(entriesProject.length >= 3); // session-1 + session-2 entries

    // Test 10: Inconsistent combination - reading project entries but finding anchor in current session
    // This is the documented behavior: scope controls entries, anchorScope controls anchor lookup
    const inconsistentAnchor = service1Refreshed.findAnchorByName("anchor/shared", "session");
    const projectEntries = service1Refreshed.scan({ entryScope: "project" });
    // anchor is from session-1, but entries include session-2 too
    assert.equal(inconsistentAnchor?.sessionId, "session-1");
    assert.ok(projectEntries.some((e) => e.id === "s2-e1"));
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
