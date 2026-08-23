import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionEvent } from "@agent/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CliError,
  EXIT_CODES,
  JsonlSessionEventStore,
} from "../src/index.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-sessions-"));
  roots.push(root);
  const sessionRoot = join(root, ".agent", "sessions");
  let id = 0;
  let time = 0;
  const store = new JsonlSessionEventStore(
    sessionRoot,
    {
      createEventId: () => `event-${++id}`,
      now: () => new Date(1_753_000_000_000 + time++ * 1_000),
      lockWaitMs: 1_000,
    },
  );
  return { root, sessionRoot, store };
}

async function collect(
  source: AsyncIterable<SessionEvent>,
): Promise<readonly SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function appendRunningSession(
  store: JsonlSessionEventStore,
  sessionId = "session-1",
): Promise<void> {
  await store.append(sessionId, {
    type: "session_started",
    task: "inspect the repository",
    workspaceRoot: "C:\\workspace",
    permissionMode: "workspace",
  });
  await store.append(sessionId, {
    type: "turn_started",
    turnId: "turn-1",
    kind: "new",
  });
  await store.append(sessionId, {
    type: "model_request_started",
    turnId: "turn-1",
    step: 1,
  });
  await store.append(sessionId, {
    type: "model_response_completed",
    turnId: "turn-1",
    step: 1,
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "file_read",
        arguments: { path: "README.md" },
      }],
    },
    stopReason: "tool_use",
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      estimatedCostUsd: 0.0014,
    },
  });
  await store.append(sessionId, {
    type: "tool_requested",
    turnId: "turn-1",
    step: 1,
    call: {
      id: "call-1",
      name: "file_read",
      arguments: { path: "README.md" },
    },
  });
  await store.append(sessionId, {
    type: "tool_completed",
    turnId: "turn-1",
    step: 1,
    result: {
      ok: true,
      toolCallId: "call-1",
      output: "README",
    },
  });
  await store.append(sessionId, {
    type: "turn_completed",
    turnId: "turn-1",
    output: "Repository inspected.",
    steps: 1,
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      estimatedCostUsd: 0.0014,
    },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("JsonlSessionEventStore", () => {
  it("atomically assigns metadata and persists one JSON object per line", async () => {
    const { root, store } = await fixture();

    const event = await store.append("session-1", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: "C:\\workspace",
      permissionMode: "workspace",
    });

    expect(event).toMatchObject({
      type: "session_started",
      eventId: "event-1",
      sessionId: "session-1",
      sequence: 1,
    });
    expect(event.at).toBe(new Date(1_753_000_000_000).toISOString());
    const raw = await readFile(
      join(root, ".agent", "sessions", "session-1.jsonl"),
      "utf8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(event);
  });

  it("serializes appends from two Store instances into consecutive sequences", async () => {
    const { sessionRoot, store } = await fixture();
    await store.append("session-1", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: "C:\\workspace",
      permissionMode: "workspace",
    });
    await store.append("session-1", {
      type: "turn_started",
      turnId: "turn-1",
      kind: "new",
    });
    const other = new JsonlSessionEventStore(sessionRoot, {
      lockWaitMs: 1_000,
    });

    const appended = await Promise.all([
      store.append("session-1", {
        type: "model_output",
        turnId: "turn-1",
        step: 1,
        text: "first",
      }),
      other.append("session-1", {
        type: "model_output",
        turnId: "turn-1",
        step: 1,
        text: "second",
      }),
    ]);

    expect(appended.map((event) => event.sequence).sort()).toEqual([3, 4]);
    expect((await collect(store.read("session-1"))).map(
      (event) => event.sequence,
    )).toEqual([1, 2, 3, 4]);
  });

  it("returns exact list/get fields and derives running-session metrics", async () => {
    const { store } = await fixture();
    await appendRunningSession(store);

    const item = await store.get("session-1");
    expect(item).toMatchObject({
      sessionId: "session-1",
      state: "running",
      task: "inspect the repository",
      lastSequence: 7,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        estimatedCostUsd: 0.0014,
      },
    });
    await expect(store.list()).resolves.toEqual([item]);
    await expect(store.details("session-1")).resolves.toMatchObject({
      item,
      durationMs: 6_000,
      modelRequests: 1,
      toolCalls: 1,
    });
  });

  it("counts completed model usage for failed and cancelled running attempts", async () => {
    const { store } = await fixture();
    for (const sessionId of ["session-failed", "session-cancelled"]) {
      await store.append(sessionId, {
        type: "session_started",
        task: "inspect",
        workspaceRoot: "C:\\workspace",
        permissionMode: "workspace",
      });
      await store.append(sessionId, {
        type: "turn_started",
        turnId: `turn-${sessionId}`,
        kind: "new",
      });
      await store.append(sessionId, {
        type: "model_response_completed",
        turnId: `turn-${sessionId}`,
        step: 1,
        message: { role: "assistant", content: "partial" },
        stopReason: "end_turn",
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          estimatedCostUsd: 0.00025,
        },
      });
    }
    await store.append("session-failed", {
      type: "turn_failed",
      turnId: "turn-session-failed",
      code: "provider_failed",
      message: "provider failed after a complete response",
    });

    await expect(store.get("session-failed")).resolves.toMatchObject({
      state: "running",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        estimatedCostUsd: 0.00025,
      },
    });
    await expect(store.get("session-cancelled")).resolves.toMatchObject({
      state: "running",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        estimatedCostUsd: 0.00025,
      },
    });
  });

  it("repairs a syntactically incomplete final line before the next append", async () => {
    const { root, store } = await fixture();
    await appendRunningSession(store);
    const path = join(root, ".agent", "sessions", "session-1.jsonl");
    await appendFile(
      path,
      '{"type":"tool_execution_started"',
      "utf8",
    );

    const restored = await collect(store.read("session-1"));
    expect(restored).toHaveLength(7);
    expect(restored.at(-1)?.type).toBe("turn_completed");
    await store.append("session-1", {
      type: "turn_started",
      turnId: "turn-2",
      kind: "continue",
    });
    const repaired = await collect(store.read("session-1"));
    expect(repaired).toHaveLength(8);
    expect(repaired.at(-1)).toMatchObject({
      type: "turn_started",
      sequence: 8,
      turnId: "turn-2",
    });
    for (const line of (await readFile(path, "utf8")).trimEnd().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("rejects complete malformed event payloads and illegal Turn order", async () => {
    const { root, store } = await fixture();
    await store.append("session-1", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: "C:\\workspace",
      permissionMode: "workspace",
    });
    const path = join(root, ".agent", "sessions", "session-1.jsonl");
    await appendFile(
      path,
      JSON.stringify({
        type: "turn_started",
        eventId: "bad-event",
        sessionId: "session-1",
        sequence: 2,
        at: new Date().toISOString(),
        kind: "new",
      }),
      "utf8",
    );
    await expect(collect(store.read("session-1"))).rejects.toThrow(
      "turn_started.turnId",
    );

    const { store: ordered } = await fixture();
    await ordered.append("session-2", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: "C:\\workspace",
      permissionMode: "workspace",
    });
    await ordered.append("session-2", {
      type: "turn_started",
      turnId: "turn-1",
      kind: "new",
    });
    await expect(ordered.append("session-2", {
      type: "turn_started",
      turnId: "turn-2",
      kind: "continue",
    })).rejects.toThrow("cannot start continue while turn-1 is incomplete");
  });

  it("rejects a second live process lease for the same session", async () => {
    const { sessionRoot, store } = await fixture();
    const other = new JsonlSessionEventStore(sessionRoot);
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = store.withSessionLease("session-1", async () => {
      entered();
      await gate;
    });
    await active;

    await expect(
      other.withSessionLease("session-1", async () => undefined),
    ).rejects.toEqual(
      new CliError(
        "SESSION_BUSY",
        EXIT_CODES.usageOrConfig,
        "session is busy in another process: session-1",
      ),
    );
    release();
    await held;
  });

  it("removes a corrupt lease lock instead of failing forever", async () => {
    const { sessionRoot, store } = await fixture();
    const lockPath = join(sessionRoot, "session-1.lock");
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "not-json-at-all", "utf8");

    await expect(
      store.append("session-1", {
        type: "session_started",
        task: "inspect",
        workspaceRoot: "C:\\workspace",
        permissionMode: "workspace",
      }, "stale-token"),
    ).rejects.toEqual(
      new CliError(
        "SESSION_BUSY",
        EXIT_CODES.usageOrConfig,
        "invalid or missing session lease token",
      ),
    );
    await expect(
      readFile(lockPath, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The cleaned lock can be acquired again by a fresh caller.
    await expect(
      store.append("session-1", {
        type: "session_started",
        task: "inspect",
        workspaceRoot: "C:\\workspace",
        permissionMode: "workspace",
      }),
    ).resolves.toMatchObject({ type: "session_started" });
  });

  it("rejects append after terminal and path-like session ids", async () => {
    const { store } = await fixture();
    await expect(
      store.append("bad-order", {
        type: "turn_started",
        turnId: "turn-1",
        kind: "new",
      }),
    ).rejects.toThrow("first event must be session_started");
    await appendRunningSession(store);
    await store.append("session-1", {
      type: "session_completed",
      summary: "done",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    });

    await expect(
      store.append("session-1", {
        type: "user_message",
        turnId: "turn-2",
        content: "continue",
      }),
    ).rejects.toThrow("has an event after its terminal");
    await expect(collect(store.read("../outside"))).rejects.toEqual(
      new CliError(
        "DATA_ERROR",
        EXIT_CODES.usageOrConfig,
        "invalid session id: ../outside",
      ),
    );
  });

  it("rejects operations if the session root is a symbolic link or escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-cli-escape-"));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "agent-cli-outside-"));
    roots.push(outside);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const agentDir = join(workspaceRoot, ".agent");
    await mkdir(agentDir);
    await symlink(outside, join(agentDir, "sessions"), process.platform === "win32" ? "junction" : "dir");

    const store = new JsonlSessionEventStore(join(agentDir, "sessions"));
    await expect(store.append("session-1", {
      type: "session_started",
      task: "inspect",
      workspaceRoot,
      permissionMode: "workspace",
    })).rejects.toThrow(/must not be a symbolic link|must not be a reparse point/);
  });

  it("keeps reads and appends consistent across many increments", { timeout: 30_000 }, async () => {
    const { store } = await fixture();
    const sessionId = "session-incremental";
    await store.append(sessionId, {
      type: "session_started",
      task: "streaming workload",
      workspaceRoot: "C:\\workspace",
      permissionMode: "workspace",
    });
    await store.append(sessionId, {
      type: "turn_started",
      turnId: "turn-1",
      kind: "new",
    });

    const totalDeltas = 300;
    for (let index = 1; index <= totalDeltas; index += 1) {
      await store.append(sessionId, {
        type: "model_output",
        turnId: "turn-1",
        step: 1,
        text: `delta-${index}`,
      });
      if (index % 150 === 0) {
        const snapshot = await collect(store.read(sessionId));
        expect(snapshot).toHaveLength(index + 2);
        expect(snapshot.at(-1)?.sequence).toBe(index + 2);
      }
    }
    await store.append(sessionId, {
      type: "turn_completed",
      turnId: "turn-1",
      output: "done",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const events = await collect(store.read(sessionId));
    expect(events).toHaveLength(totalDeltas + 3);
    for (const [index, event] of events.entries()) {
      expect(event.sequence).toBe(index + 1);
    }
    const item = await store.get(sessionId);
    expect(item?.state).toBe("running");
  });
});
