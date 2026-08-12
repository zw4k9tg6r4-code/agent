import type {
  ModelEvent,
  ModelProvider,
  ModelProviderOptions,
  ModelRequest,
  PermissionConfirmer,
} from "@agent/contracts";
import { describe, expect, it } from "vitest";

import {
  createAgentRunner,
  type LoadedProjectContext,
  type ProjectContextLoader,
} from "../src/index.js";
import {
  FixedPermissionEvaluator,
  makeDependencies,
  makeTool,
  MemorySessionStore,
  ScriptedProvider,
} from "./helpers.js";

class StaticContextLoader implements ProjectContextLoader {
  async load(): Promise<LoadedProjectContext> {
    return {
      systemPrompt: "SAFETY",
      sources: [],
      compacted: false,
      beforeTokens: 2,
      afterTokens: 2,
    };
  }
}

const limits = {
  maxSteps: 3,
  maxContextTokens: 1_000,
  maxOutputTokens: 100,
  timeoutMs: 1_000,
} as const;

function ids(): () => string {
  const values = ["turn-1", "turn-2", "turn-3"];
  return () => values.shift() ?? "id-fallback";
}

describe("createAgentRunner", () => {
  it("runs two turns in one session and finalizes exactly once", async () => {
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "first" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", delta: "second" },
        {
          type: "usage",
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);
    const runner = createAgentRunner(
      makeDependencies({ provider, sessions: store }),
      {},
      { contextLoader: new StaticContextLoader(), createId: ids() },
    );

    const first = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "new",
      sessionId: "session-1",
      task: "first task",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      limits,
      signal: new AbortController().signal,
    });
    await expect(
      runner.runTurn({ workspaceRoot: 'C:/workspace',
        kind: "resume",
        sessionId: "session-1",
        limits,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "nothing_to_resume" });
    expect(provider.requests).toHaveLength(1);

    const second = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "continue",
      sessionId: "session-1",
      message: "second task",
      limits,
      signal: new AbortController().signal,
    });
    const finished = await runner.finishSession({
      sessionId: "session-1",
      signal: new AbortController().signal,
    });

    expect(first).toMatchObject({
      status: "running",
      output: "first",
      turnId: "turn-1",
    });
    expect(second).toMatchObject({
      status: "running",
      output: "second",
      turnId: "turn-2",
    });
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "first task" },
        { role: "assistant", content: "first" },
        { role: "user", content: "second task" },
      ]),
    );
    expect(finished).toMatchObject({
      status: "completed",
      summary: "second",
      steps: 2,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    expect(
      store.events("session-1").filter(
        (event) => event.type === "session_completed",
      ),
    ).toHaveLength(1);
    await expect(
      runner.finishSession({
        sessionId: "session-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "session_terminal" });
  });

  it("returns a recoverable turn failure on timeout", async () => {
    const store = new MemorySessionStore();
    const provider: ModelProvider = {
      id: "waiting",
      async *stream(
        _request: ModelRequest,
        options: ModelProviderOptions,
      ): AsyncIterable<ModelEvent> {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    };
    const runner = createAgentRunner(
      makeDependencies({ provider, sessions: store }),
      {},
      { contextLoader: new StaticContextLoader(), createId: ids() },
    );

    const result = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "new",
      sessionId: "session-timeout",
      task: "wait",
      workspaceRoot: "C:/workspace",
      permissionMode: "readonly",
      limits: { ...limits, timeoutMs: 10 },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "running",
      error: { code: "turn_timeout" },
    });
    expect(store.events("session-timeout").at(-1)?.type).toBe("turn_failed");
  });

  it("finalizes usage from a model response even when the turn fails", async () => {
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "too long" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 6, totalTokens: 9 },
        },
        { type: "completed", stopReason: "length" },
      ],
    ]);
    const runner = createAgentRunner(
      makeDependencies({ provider, sessions: store }),
      {},
      { contextLoader: new StaticContextLoader(), createId: ids() },
    );

    const turn = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "new",
      sessionId: "session-limited",
      task: "be concise",
      workspaceRoot: "C:/workspace",
      permissionMode: "readonly",
      limits: { ...limits, maxOutputTokens: 5 },
      signal: new AbortController().signal,
    });
    expect(turn).toMatchObject({
      status: "running",
      error: { code: "max_output_tokens_exceeded" },
      usage: { inputTokens: 3, outputTokens: 6, totalTokens: 9 },
    });

    const finished = await runner.finishSession({
      sessionId: "session-limited",
      signal: new AbortController().signal,
    });
    expect(finished).toMatchObject({
      status: "completed",
      steps: 1,
      usage: { inputTokens: 3, outputTokens: 6, totalTokens: 9 },
    });
  });

  it("preserves usage and authorization through two cancellations and resumes", async () => {
    const store = new MemorySessionStore();
    const call = {
      id: "call-1",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call },
        {
          type: "usage",
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        },
        { type: "completed", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "resumed" },
        {
          type: "usage",
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);
    const controllers = [
      new AbortController(),
      new AbortController(),
    ];
    let confirmationCalls = 0;
    const confirmations: PermissionConfirmer = {
      async confirm(_request, _decision, signal): Promise<boolean> {
        confirmationCalls += 1;
        const controller = controllers[confirmationCalls - 1];
        if (controller !== undefined) {
          controller.abort(`cancel-${confirmationCalls}`);
          throw signal.reason;
        }
        return true;
      },
    };
    const permissions = new FixedPermissionEvaluator([
      {
        outcome: "ask",
        reason: "approval required",
        ruleId: "workspace.confirm",
        resolvedArguments: { path: "C:/workspace/README.md" },
      },
    ]);
    const runner = createAgentRunner(
      makeDependencies({
        provider,
        sessions: store,
        permissions,
        confirmations,
        tools: [
          makeTool("file_read", async (resolvedCall) => ({
            toolCallId: resolvedCall.id,
            ok: true,
            output: "contents",
          })),
        ],
      }),
      {},
      { contextLoader: new StaticContextLoader(), createId: ids() },
    );

    const first = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "new",
      sessionId: "session-cancelled",
      task: "cancel me",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      limits,
      signal: controllers[0]?.signal ?? new AbortController().signal,
    });
    expect(first).toMatchObject({
      status: "running",
      steps: 1,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      error: { code: "turn_cancelled", message: "cancel-1" },
    });

    const second = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "resume",
      sessionId: "session-cancelled",
      limits,
      signal: controllers[1]?.signal ?? new AbortController().signal,
    });
    expect(second).toMatchObject({
      status: "running",
      steps: 1,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      error: { code: "turn_cancelled", message: "cancel-2" },
    });

    const third = await runner.runTurn({ workspaceRoot: 'C:/workspace',
      kind: "resume",
      sessionId: "session-cancelled",
      limits,
      signal: new AbortController().signal,
    });

    expect(third).toMatchObject({
      status: "running",
      output: "resumed",
      steps: 2,
      usage: { inputTokens: 13, outputTokens: 3, totalTokens: 16 },
    });
    expect(provider.requests).toHaveLength(2);
    expect(permissions.requests).toHaveLength(1);
    expect(confirmationCalls).toBe(3);
    expect(
      store.events("session-cancelled").filter(
        (event) =>
          event.type === "turn_failed" ||
          event.type === "session_cancelled",
      ),
    ).toEqual([]);
  });

  it("throws for invalid inputs and session states", async () => {
    const store = new MemorySessionStore();
    const runner = createAgentRunner(
      makeDependencies({ provider: new ScriptedProvider([]), sessions: store }),
      {},
      { contextLoader: new StaticContextLoader(), createId: ids() },
    );
    const signal = new AbortController().signal;

    await expect(
      runner.runTurn({ workspaceRoot: 'C:/workspace', kind: "new", sessionId: "s-1", task: "x", workspaceRoot: "w", permissionMode: "readonly", limits: { ...limits, maxSteps: 0 }, signal })
    ).rejects.toMatchObject({ code: "invalid_run_limits" });

    await runner.runTurn({ workspaceRoot: 'C:/workspace', kind: "new", sessionId: "s-1", task: "x", workspaceRoot: "w", permissionMode: "readonly", limits, signal });

    await expect(
      runner.runTurn({ workspaceRoot: 'C:/workspace', kind: "new", sessionId: "s-1", task: "x", workspaceRoot: "w", permissionMode: "readonly", limits, signal })
    ).rejects.toMatchObject({ code: "session_exists" });

    await expect(
      runner.runTurn({ workspaceRoot: 'C:/workspace', kind: "continue", sessionId: "s-2", message: "x", limits, signal })
    ).rejects.toMatchObject({ code: "session_not_found" });

    await expect(
      runner.finishSession({ sessionId: "s-2", signal })
    ).rejects.toMatchObject({ code: "session_not_found" });

    await runner.finishSession({ sessionId: "s-1", signal });

    await expect(
      runner.runTurn({ workspaceRoot: 'C:/workspace', kind: "continue", sessionId: "s-1", message: "x", limits, signal })
    ).rejects.toMatchObject({ code: "session_terminal" });

    await expect(
      runner.finishSession({ sessionId: "s-1", signal })
    ).rejects.toMatchObject({ code: "session_terminal" });
  });
});
