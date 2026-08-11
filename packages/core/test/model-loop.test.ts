import { describe, expect, it } from "vitest";

import { runModelLoop } from "../src/model-loop.js";
import {
  FixedConfirmer,
  FixedPermissionEvaluator,
  makeDependencies,
  makeTool,
  MemorySessionStore,
  ScriptedProvider,
} from "./helpers.js";

const signal = new AbortController().signal;

function loopInput(
  provider: ScriptedProvider,
  store: MemorySessionStore,
  overrides: Record<string, unknown> = {},
) {
  const dependencies = makeDependencies({
    provider,
    sessions: store,
  });
  return {
    dependencies,
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceRoot: "C:/workspace",
    permissionMode: "workspace" as const,
    messages: [
      { role: "system" as const, content: "SAFETY" },
      { role: "user" as const, content: "TASK" },
    ],
    limits: {
      maxSteps: 3,
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
      timeoutMs: 60_000,
    },
    signal,
    ...overrides,
  };
}

describe("runModelLoop", () => {
  it("records streamed text and completes on end_turn", async () => {
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "hello " },
        { type: "text_delta", delta: "world" },
        {
          type: "usage",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);

    const result = await runModelLoop(loopInput(provider, store));

    expect(result).toMatchObject({
      kind: "completed",
      output: "hello world",
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    expect(
      store.events("session-1").map((event) => event.type),
    ).toEqual([
      "model_request_started",
      "model_output",
      "model_output",
      "model_response_completed",
    ]);
  });

  it("dispatches a complete tool request and feeds its result to the next request", async () => {
    const store = new MemorySessionStore();
    const call = {
      id: "call-1",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call },
        { type: "completed", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);
    const permissions = new FixedPermissionEvaluator([
      {
        outcome: "allow",
        reason: "read allowed",
        ruleId: "readonly.read",
        resolvedArguments: { path: "C:/workspace/README.md" },
      },
    ]);
    const dependencies = makeDependencies({
      provider,
      sessions: store,
      permissions,
      confirmations: new FixedConfirmer([]),
      tools: [
        makeTool("file_read", async (resolvedCall) => ({
          toolCallId: resolvedCall.id,
          ok: true,
          output: "contents",
        })),
      ],
    });

    const result = await runModelLoop({
      ...loopInput(provider, store),
      dependencies,
    });

    expect(result).toMatchObject({
      kind: "completed",
      output: "done",
      steps: 2,
    });
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      content: "contents",
      toolCallId: "call-1",
      name: "file_read",
    });
    expect(
      store.events("session-1").map((event) => event.type),
    ).toEqual([
      "model_request_started",
      "model_response_completed",
      "tool_requested",
      "permission_decided",
      "tool_execution_started",
      "tool_completed",
      "model_request_started",
      "model_output",
      "model_response_completed",
    ]);
  });

  it("stops at step and output limits without another provider request", async () => {
    const stepStore = new MemorySessionStore();
    const call = {
      id: "call-1",
      name: "missing",
      arguments: {},
    } as const;
    const stepProvider = new ScriptedProvider([
      [
        { type: "tool_call", call },
        { type: "completed", stopReason: "tool_use" },
      ],
    ]);
    const stepped = await runModelLoop(
      loopInput(stepProvider, stepStore, {
        limits: {
          maxSteps: 1,
          maxContextTokens: 1_000,
          maxOutputTokens: 100,
          timeoutMs: 60_000,
        },
      }),
    );
    expect(stepped).toMatchObject({
      kind: "failed",
      error: { code: "max_steps_exceeded" },
      steps: 1,
    });
    expect(stepProvider.requests).toHaveLength(1);

    const tokenStore = new MemorySessionStore();
    const tokenProvider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "too long" },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 6, totalTokens: 9 },
        },
        { type: "completed", stopReason: "length" },
      ],
    ]);
    const tokenResult = await runModelLoop(
      loopInput(tokenProvider, tokenStore, {
        limits: {
          maxSteps: 2,
          maxContextTokens: 1_000,
          maxOutputTokens: 5,
          timeoutMs: 60_000,
        },
      }),
    );
    expect(tokenResult).toMatchObject({
      kind: "failed",
      error: { code: "max_output_tokens_exceeded" },
    });

    const exhaustedStore = new MemorySessionStore();
    const exhaustedProvider = new ScriptedProvider([
      [
        { type: "tool_call", call },
        {
          type: "usage",
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        },
        { type: "completed", stopReason: "tool_use" },
      ],
    ]);
    const exhausted = await runModelLoop(
      loopInput(exhaustedProvider, exhaustedStore, {
        limits: {
          maxSteps: 2,
          maxContextTokens: 1_000,
          maxOutputTokens: 5,
          timeoutMs: 60_000,
        },
      }),
    );
    expect(exhausted).toMatchObject({
      kind: "failed",
      error: { code: "max_output_tokens_exceeded" },
    });
    expect(exhaustedProvider.requests).toHaveLength(1);
    expect(exhaustedStore.events("session-1").filter((e) => e.type === "tool_failed")).toHaveLength(1);
  });

  it("fails when model returns tool_use without tools or undefined stop reason or cancelled", async () => {
    const store = new MemorySessionStore();
    const providerUndefined = new ScriptedProvider([
      [
        { type: "text_delta", delta: "hi" },
        { type: "completed", stopReason: undefined as any },
      ],
    ]);
    const resultUndefined = await runModelLoop({
      dependencies: makeDependencies({ provider: providerUndefined, sessions: store }),
      sessionId: "s-1",
      turnId: "t-1",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      messages: [{ role: "user", content: "test" }],
      limits: { maxSteps: 3, maxContextTokens: 1000, maxOutputTokens: 100 },
      signal: new AbortController().signal,
    });
    expect(resultUndefined).toMatchObject({
      kind: "failed",
      error: { code: "model_stream_incomplete", message: "Model stream ended without a completed event." }
    });

    const providerEmptyTools = new ScriptedProvider([
      [
        { type: "text_delta", delta: "hi" },
        { type: "completed", stopReason: "tool_use" },
      ],
    ]);
    const resultEmptyTools = await runModelLoop({
      dependencies: makeDependencies({ provider: providerEmptyTools, sessions: store }),
      sessionId: "s-2",
      turnId: "t-2",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      messages: [{ role: "user", content: "test" }],
      limits: { maxSteps: 3, maxContextTokens: 1000, maxOutputTokens: 100 },
      signal: new AbortController().signal,
    });
    expect(resultEmptyTools).toMatchObject({
      kind: "failed",
      error: { code: "model_tool_call_missing", message: "Model stopped for tool use without a tool call." }
    });

    const providerCancelled = new ScriptedProvider([
      [
        { type: "text_delta", delta: "hi" },
        { type: "completed", stopReason: "cancelled" },
      ],
    ]);
    await expect(runModelLoop({
      dependencies: makeDependencies({ provider: providerCancelled, sessions: store }),
      sessionId: "s-3",
      turnId: "t-3",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      messages: [{ role: "user", content: "test" }],
      limits: { maxSteps: 3, maxContextTokens: 1000, maxOutputTokens: 100 },
      signal: new AbortController().signal,
    })).rejects.toThrow("Model cancelled.");
  });

  it("records context compaction before the affected model request", async () => {
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "ok" },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);
    const result = await runModelLoop(
      loopInput(provider, store, {
        messages: [
          { role: "system", content: "SAFE" },
          { role: "user", content: "GOAL" },
          { role: "assistant", content: "old-".repeat(100) },
        ],
        limits: {
          maxSteps: 2,
          maxContextTokens: 30,
          maxOutputTokens: 100,
          timeoutMs: 60_000,
        },
      }),
    );

    expect(result.kind).toBe("completed");
    expect(store.events("session-1")[0]?.type).toBe("context_compacted");
    expect(provider.requests[0]?.messages.map((message) => message.content))
      .not.toContain("old-".repeat(100));
  });
});
