import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isTerminalModelEvent,
  type CheckpointRestoreResult,
  type JsonObject,
  type ModelEvent,
  type ModelProvider,
  type CheckpointStore,
  type Tool,
  type ToolCall,
  type ToolResult,
} from "../src/index.js";

describe("model and tool contracts", () => {
  it("recognizes terminal model events", () => {
    const completed: ModelEvent = {
      type: "completed",
      stopReason: "end_turn",
    };
    const delta: ModelEvent = {
      type: "text_delta",
      delta: "hello",
    };

    expect(isTerminalModelEvent(completed)).toBe(true);
    expect(isTerminalModelEvent(delta)).toBe(false);
  });

  it("keeps tool inputs and metadata JSON-safe", () => {
    const input: JsonObject = {
      path: "README.md",
      options: {
        lineNumbers: true,
      },
    };
    const call: ToolCall = {
      id: "call-1",
      name: "file_read",
      arguments: input,
    };
    const result: ToolResult = {
      toolCallId: call.id,
      ok: true,
      output: "contents",
      metadata: {
        bytes: 8,
      },
    };

    if (!result.ok) {
      throw new Error("expected a successful tool result");
    }

    expect(result.metadata?.["bytes"]).toBe(8);
  });

  it("defines async provider and tool interfaces", () => {
    expectTypeOf<ModelProvider["stream"]>().returns.toMatchTypeOf<
      AsyncIterable<ModelEvent>
    >();
    expectTypeOf<Parameters<Tool["execute"]>[0]>().toEqualTypeOf<ToolCall>();
    expectTypeOf<Tool["execute"]>().returns.toMatchTypeOf<
      Promise<ToolResult>
    >();
    expectTypeOf<CheckpointStore["restore"]>().returns.toMatchTypeOf<
      Promise<CheckpointRestoreResult>
    >();
  });
});
