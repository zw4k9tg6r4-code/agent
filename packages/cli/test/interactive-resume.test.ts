import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CliError,
  EXIT_CODES,
  initializeWorkspace,
  JsonlSessionEventStore,
  runCommand,
} from "../src/index.js";
import {
  FakeIO,
  FakeRunner,
  FakeRuntimeFactory,
  runningTurn,
} from "./fixtures/fakes.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-interactive-"));
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

describe("interactive mode", () => {
  it("runs a new turn, continues the same session, and finishes on /exit", async () => {
    const { root, sessions } = await setup();
    const io = new FakeIO(["inspect", "explain the result", "/exit"]);
    const runner = new FakeRunner([
      runningTurn("First answer.", "session-chat"),
      runningTurn("Second answer.", "session-chat"),
    ]);
    const signal = new AbortController().signal;

    const code = await runCommand(
      { kind: "interactive" },
      {
        workspaceRoot: root,
        environment: { OPENAI_API_KEY: "fake-only-key" },
        io,
        sessions,
        runtimeFactory: new FakeRuntimeFactory(runner),
        signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(runner.turnOptions[0]).toMatchObject({
      kind: "new",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
      signal,
    });
    expect(runner.turnOptions[1]).toEqual({
      kind: "continue",
      sessionId: "session-chat",
      workspaceRoot: root,
      message: "explain the result",
      limits: {
        maxSteps: 30,
        maxContextTokens: 64_000,
        maxOutputTokens: 8_000,
        timeoutMs: 300_000,
      },
      signal,
    });
    expect(runner.finishOptions).toEqual([{
      sessionId: "session-chat",
      signal,
    }]);
    expect(io.output.join("")).toContain("First answer.");
    expect(io.output.join("")).toContain("Second answer.");
  });

  it("exits cleanly on immediate EOF without loading config/runtime", async () => {
    const { root, sessions } = await setup();
    const factory = new FakeRuntimeFactory(new FakeRunner([]));

    const code = await runCommand(
      { kind: "interactive" },
      {
        workspaceRoot: root,
        environment: {},
        io: new FakeIO([]),
        sessions,
        runtimeFactory: factory,
        signal: new AbortController().signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(factory.inputs).toEqual([]);
  });

  it("maps Ctrl+C at the prompt to 130 without finalizing", async () => {
    const { root, sessions } = await setup();
    const controller = new AbortController();
    controller.abort();
    const runner = new FakeRunner([]);

    const code = await runCommand(
      { kind: "interactive" },
      {
        workspaceRoot: root,
        environment: {},
        io: new FakeIO([]),
        sessions,
        runtimeFactory: new FakeRuntimeFactory(runner),
        signal: controller.signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.cancelled);
    expect(runner.finishOptions).toEqual([]);
  });
});

describe("resume", () => {
  it("resumes a running session, returns to the prompt, then finishes", async () => {
    const { root, sessions } = await setup();
    await sessions.append("session-resume", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    await sessions.append("session-resume", {
      type: "turn_started",
      turnId: "turn-interrupted",
      kind: "new",
    });
    const io = new FakeIO(["/exit"]);
    const runner = new FakeRunner([
      runningTurn("Recovered answer.", "session-resume"),
    ]);
    const signal = new AbortController().signal;

    const code = await runCommand(
      { kind: "resume", sessionId: "session-resume" },
      {
        workspaceRoot: root,
        environment: { OPENAI_API_KEY: "fake-only-key" },
        io,
        sessions,
        runtimeFactory: new FakeRuntimeFactory(runner),
        signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(runner.turnOptions).toEqual([{
      kind: "resume",
      sessionId: "session-resume",
      workspaceRoot: root,
      limits: {
        maxSteps: 30,
        maxContextTokens: 64_000,
        maxOutputTokens: 8_000,
        timeoutMs: 300_000,
      },
      signal,
      token: expect.any(String),
    }]);
    expect(runner.finishOptions).toEqual([{
      sessionId: "session-resume",
      signal,
      token: expect.any(String),
    }]);
  });

  it("opens a completed running session at the prompt without a model call", async () => {
    const { root, sessions } = await setup();
    await sessions.append("session-ready", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    await sessions.append("session-ready", {
      type: "turn_started",
      turnId: "turn-complete",
      kind: "new",
    });
    await sessions.append("session-ready", {
      type: "turn_completed",
      turnId: "turn-complete",
      output: "done",
      steps: 1,
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      },
    });
    const io = new FakeIO(["explain more", "/exit"]);
    const runner = new FakeRunner([
      runningTurn("Explanation.", "session-ready"),
    ]);
    const signal = new AbortController().signal;

    const code = await runCommand(
      { kind: "resume", sessionId: "session-ready" },
      {
        workspaceRoot: root,
        environment: { OPENAI_API_KEY: "fake-only-key" },
        io,
        sessions,
        runtimeFactory: new FakeRuntimeFactory(runner),
        signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(runner.turnOptions).toEqual([{
      kind: "continue",
      sessionId: "session-ready",
      workspaceRoot: root,
      message: "explain more",
      limits: {
        maxSteps: 30,
        maxContextTokens: 64_000,
        maxOutputTokens: 8_000,
        timeoutMs: 300_000,
      },
      signal,
      token: expect.any(String),
    }]);
    expect(runner.finishOptions).toEqual([{
      sessionId: "session-ready",
      signal,
      token: expect.any(String),
    }]);
  });

  it("resumes unresolved tool state even after the prior attempt turn_failed", async () => {
    const { root, sessions } = await setup();
    await sessions.append("session-pending", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    await sessions.append("session-pending", {
      type: "turn_started",
      turnId: "turn-failed",
      kind: "new",
    });
    await sessions.append("session-pending", {
      type: "model_response_completed",
      turnId: "turn-failed",
      step: 1,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-pending",
          name: "file_read",
          arguments: { path: "README.md" },
        }],
      },
      stopReason: "tool_use",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    });
    await sessions.append("session-pending", {
      type: "tool_requested",
      turnId: "turn-failed",
      step: 1,
      call: {
        id: "call-pending",
        name: "file_read",
        arguments: { path: "README.md" },
      },
    });
    await sessions.append("session-pending", {
      type: "turn_failed",
      turnId: "turn-failed",
      code: "turn_timeout",
      message: "timed out before tool completion",
    });
    const runner = new FakeRunner([
      runningTurn("Recovered.", "session-pending"),
    ]);
    const signal = new AbortController().signal;

    const code = await runCommand(
      { kind: "resume", sessionId: "session-pending" },
      {
        workspaceRoot: root,
        environment: { OPENAI_API_KEY: "fake-only-key" },
        io: new FakeIO(["/exit"]),
        sessions,
        runtimeFactory: new FakeRuntimeFactory(runner),
        signal,
        version: "0.0.0",
      },
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(runner.turnOptions).toEqual([{
      kind: "resume",
      sessionId: "session-pending",
      workspaceRoot: root,
      limits: {
        maxSteps: 30,
        maxContextTokens: 64_000,
        maxOutputTokens: 8_000,
        timeoutMs: 300_000,
      },
      signal,
      token: expect.any(String),
    }]);
  });

  it("rejects a terminal session before creating runtime", async () => {
    const { root, sessions } = await setup();
    await sessions.append("session-done", {
      type: "session_started",
      task: "inspect",
      workspaceRoot: root,
      permissionMode: "workspace",
    });
    await sessions.append("session-done", {
      type: "session_cancelled",
      reason: "user_cancelled",
    });
    const factory = new FakeRuntimeFactory(new FakeRunner([]));

    await expect(
      runCommand(
        { kind: "resume", sessionId: "session-done" },
        {
          workspaceRoot: root,
          environment: { OPENAI_API_KEY: "fake-only-key" },
          io: new FakeIO(),
          sessions,
          runtimeFactory: factory,
          signal: new AbortController().signal,
          version: "0.0.0",
        },
      ),
    ).rejects.toEqual(
      new CliError(
        "DATA_ERROR",
        EXIT_CODES.usageOrConfig,
        "session session-done is not resumable: cancelled",
      ),
    );
    expect(factory.inputs).toEqual([]);
  });
});
