import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResult } from "@agent/contracts";
import { sanitizeToolResult } from "../src/redaction.js";
import { dispatchToolCall } from "../src/tool-dispatcher.js";
import {
  FixedConfirmer,
  FixedPermissionEvaluator,
  MemorySessionStore,
} from "./helpers.js";

const signal = new AbortController().signal;

describe("Safe Redaction and Tool Result Validation", () => {
  it("sanitizes circular metadata structures without stack overflow", () => {
    const circularObj: any = { key: "secret_value", apiKey: "sk-1234567890abcdef" };
    circularObj.self = circularObj;

    const result: ToolResult = {
      toolCallId: "call_1",
      ok: true,
      output: "result text",
      metadata: circularObj,
    };

    const sanitized = sanitizeToolResult(result);
    expect(sanitized.ok).toBe(true);
    expect(sanitized.metadata).toBeDefined();
    expect(sanitized.metadata?.["self"]).toBe("[REDACTED]");
  });

  it("converts a tool returning circular metadata into a bounded failure in dispatchToolCall", async () => {
    const circularMeta: any = { data: "test" };
    circularMeta.loop = circularMeta;

    const call: ToolCall = {
      id: "call_circ_1",
      name: "faulty_tool",
      arguments: {},
    };

    const store = new MemorySessionStore();

    const dispatched = await dispatchToolCall({
      state: {
        step: 1,
        call,
        requestRecorded: true,
        executionStarted: false,
        decision: undefined,
        confirmation: undefined,
      },
      tools: [{
        definition: {
          name: "faulty_tool",
          description: "test",
          inputSchema: { type: "object" },
          riskLevel: "read",
          outputLimitBytes: 10000,
          supportsCancellation: true,
        },
        execute: async () => ({
          toolCallId: "call_circ_1",
          ok: true,
          output: "success",
          metadata: circularMeta,
        }),
      }],
      permissionMode: "trusted",
      workspaceRoot: "C:/tmp/workspace",
      sessionId: "s-1",
      turnId: "t-1",
      signal,
      permissions: new FixedPermissionEvaluator([{ outcome: "allow", reason: "ok", ruleId: "r1", resolvedArguments: {} }]),
      confirmations: new FixedConfirmer([true]),
      sessions: store,
      checkpoints: {} as any,
    });

    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) {
      expect(dispatched.error.code).toBe("invalid_tool_result");
      expect(dispatched.error.message).toContain("circular");
    }
  });
});
