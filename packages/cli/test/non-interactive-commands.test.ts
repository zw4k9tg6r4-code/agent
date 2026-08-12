import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  initializeWorkspace,
  JsonlSessionEventStore,
  runNonInteractiveCommand,
} from "../src/index.js";
import {
  FakeIO,
  FakeRunner,
  FakeRuntimeFactory,
  runningTurn,
  erroredTurn,
} from "./fixtures/fakes.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-command-"));
  roots.push(root);
  await initializeWorkspace(root);
  return {
    root,
    sessions: new JsonlSessionEventStore(join(root, ".agent", "sessions")),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("non-interactive commands", () => {
  it("runs one new turn, prints it, then finishes the session", async () => {
    const { root, sessions } = await setup();
    const io = new FakeIO();
    const runner = new FakeRunner([runningTurn("Inspected.")]);
    const runtimeFactory = new FakeRuntimeFactory(runner);
    const signal = new AbortController().signal;

    const code = await runNonInteractiveCommand(
      { kind: "run", task: "inspect this repository" },
      {
        workspaceRoot: root,
        environment: { OPENAI_API_KEY: "sk-fake-only" },
        io,
        sessions,
        runtimeFactory,
        signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(runner.turnOptions).toEqual([{
      kind: "new",
      task: "inspect this repository",
      workspaceRoot: root,
      permissionMode: "workspace",
      limits: {
        maxSteps: 30,
        maxContextTokens: 64_000,
        maxOutputTokens: 8_000,
        timeoutMs: 300_000,
      },
      signal,
    }]);
    expect(runner.finishOptions).toEqual([{
      sessionId: "session-fake",
      signal,
    }]);
    expect(io.output.join("")).toContain("Inspected.");
    expect(io.output.join("")).toContain("Task completed.");
    expect(io.output.join("")).not.toContain("sk-fake-only");
  });

  it.each([
    ["failed", EXIT_CODES.runtimeFailure, "provider unavailable"],
    ["cancelled", EXIT_CODES.cancelled, "Task cancelled."],
  ] as const)("maps a %s turn and does not finish it", async (
    status,
    expectedCode,
    message,
  ) => {
    const { root, sessions } = await setup();
    await sessions.append("session-fake", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    const io = new FakeIO();
    const runner = new FakeRunner([erroredTurn(status)]);
    const code = await runNonInteractiveCommand(
      { kind: "run", task: "inspect" },
      {
        workspaceRoot: root,
        environment: { OPENAI_API_KEY: "sk-fake-only" },
        io,
        sessions,
        runtimeFactory: new FakeRuntimeFactory(runner),
        signal: new AbortController().signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(expectedCode);
    expect(io.errors.join("")).toContain(message);
    expect(runner.finishOptions).toEqual([]);
  });

  it("lists session state/time/usage without an API key", async () => {
    const { root, sessions } = await setup();
    await sessions.append("session-list", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    const io = new FakeIO();

    const code = await runNonInteractiveCommand(
      { kind: "sessions" },
      {
        workspaceRoot: root,
        environment: {},
        io,
        sessions,
        runtimeFactory: new FakeRuntimeFactory(new FakeRunner([])),
        signal: new AbortController().signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(io.output.join("")).toContain("session-list");
    expect(io.output.join("")).toContain("running");
    expect(io.output.join("")).toContain("0 tokens");
  });

  it("restores checkpoints without model configuration", async () => {
    const { root, sessions } = await setup();
    await sessions.append("session-undo", {
      type: "session_started",
      task: "change files",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    const io = new FakeIO();
    const runtimeFactory = new FakeRuntimeFactory(new FakeRunner([]));
    const signal = new AbortController().signal;

    const code = await runNonInteractiveCommand(
      { kind: "undo", sessionId: "session-undo" },
      {
        workspaceRoot: root,
        environment: {},
        io,
        sessions,
        runtimeFactory,
        signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(runtimeFactory.checkpoints.restores).toEqual([{
      sessionId: "session-undo",
      workspaceRoot: root,
      signal,
      expectedHashes: new Map(),
    }]);
    expect(io.output.join("")).toContain("Restored: src/app.ts");
    expect(io.output.join("")).toContain("Removed: src/generated.ts");
  });
});
