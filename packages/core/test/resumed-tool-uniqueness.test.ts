import { describe, expect, it } from "vitest";
import type {
  ModelEvent,
  ModelMessage,
} from "@agent/contracts";
import { runModelLoop } from "../src/model-loop.js";
import {
  makeDependencies,
  MemorySessionStore,
  ScriptedProvider,
} from "./helpers.js";

const signal = new AbortController().signal;

describe("Tool Call Uniqueness and Validation in Model Loop", () => {
  it("rejects tool call IDs that already exist in previous messages history", async () => {
    const existingMessages: ModelMessage[] = [
      {
        role: "assistant",
        content: "I will call a tool",
        toolCalls: [{ id: "call_existing_1", name: "test_tool", arguments: {} }],
      },
      {
        role: "tool",
        name: "test_tool",
        toolCallId: "call_existing_1",
        content: "done",
      },
    ];

    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: { id: "call_existing_1", name: "test_tool", arguments: {} },
        },
        { type: "completed", stopReason: "tool_use" },
      ],
    ]);

    const store = new MemorySessionStore();
    const dependencies = makeDependencies({
      provider,
      sessions: store,
    });

    const result = await runModelLoop({
      dependencies,
      sessionId: "s-1",
      turnId: "t-2",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      messages: existingMessages,
      limits: { maxSteps: 10, maxContextTokens: 10000, maxOutputTokens: 1000, timeoutMs: 10000 },
      signal,
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error?.code).toBe("duplicate_tool_call_id");
    }
  });

  it("rejects tool call with deeply nested arguments exceeding depth limit", async () => {
    let deepObj: any = { leaf: "val" };
    for (let i = 0; i < 35; i++) {
      deepObj = { nested: deepObj };
    }

    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: { id: "call_deep_1", name: "test_tool", arguments: deepObj },
        },
        { type: "completed", stopReason: "tool_use" },
      ],
    ]);

    const store = new MemorySessionStore();
    const dependencies = makeDependencies({
      provider,
      sessions: store,
    });

    const result = await runModelLoop({
      dependencies,
      sessionId: "s-1",
      turnId: "t-1",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      messages: [],
      limits: { maxSteps: 10, maxContextTokens: 10000, maxOutputTokens: 1000, timeoutMs: 10000 },
      signal,
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error?.code).toBe("invalid_tool_call");
    }
  });

  it("handles negative or invalid estimatedCostUsd safely without corrupting usage", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "hello" },
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            estimatedCostUsd: -0.5 as any,
          },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);

    const store = new MemorySessionStore();
    const dependencies = makeDependencies({
      provider,
      sessions: store,
    });

    const result = await runModelLoop({
      dependencies,
      sessionId: "s-1",
      turnId: "t-1",
      workspaceRoot: "C:/workspace",
      permissionMode: "workspace",
      messages: [{ role: "user", content: "hi" }],
      limits: { maxSteps: 10, maxContextTokens: 10000, maxOutputTokens: 1000, timeoutMs: 10000 },
      signal,
    });

    expect(result.kind).toBe("completed");
    expect(result.usage.estimatedCostUsd).toBeUndefined();
  });
});
