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
  assert.equal(anchor.kind, "handoff");
  assert.equal(service.getAnchorStore().findById(anchor.id)?.meta?.summary, "start work");
});

test("query supports scope, types, limit, query, anchors, and date ranges", () => {
  const tapeBasePath = createTempDir("pi-memory-md-tape-service-query");
  const cwd = createTempDir("pi-memory-md-cwd-query");
  const agentDir = createTempDir("pi-memory-md-agent-query");
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

    const anchors = service.getAnchorStore().findAllByName("mark/start");
    const endAnchor = service.getAnchorStore().findByName("mark/end");
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

    assert.equal(service.query({ scope: "session" }).length, 4);
    assert.equal(service.query({ scope: "project" }).length, 5);
    assert.deepEqual(
      service.query({ scope: "session", types: ["compaction"] }).map((entry) => entry.id),
      ["a3"],
    );
    assert.deepEqual(
      service.query({ scope: "session", query: "bug" }).map((entry) => entry.id),
      ["a1", "a4"],
    );
    assert.deepEqual(
      service.query({ scope: "session", limit: 2 }).map((entry) => entry.id),
      ["a3", "a4"],
    );
    assert.deepEqual(
      service.query({ scope: "session", sinceAnchor: "mark/start" }).map((entry) => entry.id),
      ["a2", "a3", "a4"],
    );
    assert.deepEqual(
      service
        .query({ scope: "session", betweenAnchors: { start: "mark/start", end: "mark/end" } })
        .map((entry) => entry.id),
      ["a2", "a3"],
    );
    assert.deepEqual(
      service
        .query({
          scope: "session",
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
