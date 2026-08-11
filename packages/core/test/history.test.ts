import { describe, expect, it } from "vitest";

import { loadSessionSnapshot } from "../src/history.js";
import { MemorySessionStore } from "./helpers.js";

async function seedSession(store: MemorySessionStore): Promise<void> {
  await store.append("session-1", {
    type: "session_started",
    task: "inspect",
    workspaceRoot: "C:/workspace",
    permissionMode: "workspace",
  });
  await store.append("session-1", {
    type: "turn_started",
    turnId: "turn-1",
    kind: "new",
  });
  await store.append("session-1", {
    type: "user_message",
    turnId: "turn-1",
    content: "inspect",
  });
}

describe("loadSessionSnapshot", () => {
  it("reconstructs only complete model responses and terminal tool results", async () => {
    const store = new MemorySessionStore();
    await seedSession(store);
    await store.append("session-1", {
      type: "model_output",
      turnId: "turn-1",
      step: 1,
      text: "display-only-partial",
    });
    const call = {
      id: "call-1",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "turn-1",
      step: 1,
      message: { role: "assistant", content: "", toolCalls: [call] },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    await store.append("session-1", {
      type: "tool_requested",
      turnId: "turn-1",
      step: 1,
      call,
    });
    await store.append("session-1", {
      type: "tool_completed",
      turnId: "turn-1",
      step: 1,
      result: {
        toolCallId: "call-1",
        ok: true,
        output: "README contents",
      },
    });

    const snapshot = await loadSessionSnapshot(store, "session-1");

    expect(snapshot.messages).toEqual([
      { role: "user", content: "inspect" },
      { role: "assistant", content: "", toolCalls: [call] },
      {
        role: "tool",
        content: "README contents",
        toolCallId: "call-1",
        name: "file_read",
      },
    ]);
    expect(
      snapshot.messages.some(
        (message) => message.content === "display-only-partial",
      ),
    ).toBe(false);
    expect(snapshot.pendingToolStates).toEqual([]);
  });

  it("identifies safe pending calls and unknown started executions separately", async () => {
    const store = new MemorySessionStore();
    await seedSession(store);
    const safeCall = {
      id: "call-safe",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    const unknownCall = {
      id: "call-unknown",
      name: "file_patch",
      arguments: { path: "README.md" },
    } as const;
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "turn-1",
      step: 1,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [safeCall, unknownCall],
      },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    for (const call of [safeCall, unknownCall]) {
      await store.append("session-1", {
        type: "tool_requested",
        turnId: "turn-1",
        step: 1,
        call,
      });
    }
    await store.append("session-1", {
      type: "tool_execution_started",
      turnId: "turn-1",
      step: 1,
      toolCallId: "call-unknown",
    });

    const snapshot = await loadSessionSnapshot(store, "session-1");

    expect(snapshot.pendingToolStates).toEqual([
      {
        call: safeCall,
        step: 1,
        requestRecorded: true,
        decision: undefined,
        confirmation: undefined,
        executionStarted: false,
      },
    ]);
    expect(snapshot.unknownToolCallIds).toEqual(["call-unknown"]);
    expect(snapshot.incompleteTurnId).toBe("turn-1");
  });

  it("keeps logical-turn usage across multiple resume attempt ids", async () => {
    const store = new MemorySessionStore();
    await seedSession(store);
    await store.append("session-1", {
      type: "model_request_started",
      turnId: "turn-1",
      step: 1,
    });
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "turn-1",
      step: 1,
      message: { role: "assistant", content: "first" },
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    await store.append("session-1", {
      type: "turn_started",
      turnId: "resume-1",
      kind: "resume",
    });
    await store.append("session-1", {
      type: "model_request_started",
      turnId: "resume-1",
      step: 2,
    });
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "resume-1",
      step: 2,
      message: { role: "assistant", content: "second" },
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    });

    const snapshot = await loadSessionSnapshot(store, "session-1");

    expect(snapshot.logicalTurnSteps).toBe(2);
    expect(snapshot.logicalTurnUsage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
  });

  it("rejects a missing or malformed session", async () => {
    await expect(
      loadSessionSnapshot(new MemorySessionStore(), "missing"),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });
});
