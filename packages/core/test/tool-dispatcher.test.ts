import type {
  PermissionDecision,
  SessionEventData,
  ToolCall,
} from "@agent/contracts";
import { describe, expect, it, vi } from "vitest";

import { dispatchToolCall } from "../src/tool-dispatcher.js";
import {
  FixedConfirmer,
  FixedPermissionEvaluator,
  makeTool,
  MemorySessionStore,
  NoopCheckpointStore,
} from "./helpers.js";

const originalCall = {
  id: "call-1",
  name: "file_read",
  arguments: { path: "../README.md" },
} as const;

function baseInput(
  permissions: FixedPermissionEvaluator,
  confirmations: FixedConfirmer,
  store: MemorySessionStore,
) {
  return {
    state: {
      call: originalCall,
      step: 1,
      requestRecorded: false,
      decision: undefined,
      confirmation: undefined,
      executionStarted: false,
    },
    permissionMode: "workspace" as const,
    workspaceRoot: "C:/workspace",
    sessionId: "session-1",
    turnId: "turn-1",
    signal: new AbortController().signal,
    permissions,
    confirmations,
    sessions: store,
    checkpoints: new NoopCheckpointStore(),
  };
}

describe("dispatchToolCall", () => {
  it("executes resolved arguments and records the complete allow sequence", async () => {
    const store = new MemorySessionStore();
    const execute = vi.fn(async (call: ToolCall) => ({
      toolCallId: call.id,
      ok: true as const,
      output: String(call.arguments["path"]),
    }));
    const tool = makeTool("file_read", execute);
    const permissions = new FixedPermissionEvaluator([
      {
        outcome: "allow",
        reason: "inside workspace",
        ruleId: "workspace.read",
        resolvedArguments: { path: "C:/workspace/README.md" },
      },
    ]);
    const confirmations = new FixedConfirmer([]);

    const result = await dispatchToolCall({
      ...baseInput(permissions, confirmations, store),
      tools: [tool],
    });

    expect(result).toMatchObject({ ok: true, toolCallId: "call-1" });
    expect(execute).toHaveBeenCalledWith(
      {
        id: "call-1",
        name: "file_read",
        arguments: { path: "C:/workspace/README.md" },
      },
      expect.objectContaining({
        workspaceRoot: "C:/workspace",
        sessionId: "session-1",
      }),
    );
    expect(permissions.requests).toEqual([originalCall]);
    expect(
      store.events("session-1").map((event) => event.type),
    ).toEqual([
      "tool_requested",
      "permission_decided",
      "tool_execution_started",
      "tool_completed",
    ]);
  });

  it("asks exactly once and does not execute when confirmation is rejected", async () => {
    const store = new MemorySessionStore();
    const execute = vi.fn(async () => ({
      toolCallId: "call-1",
      ok: true as const,
      output: "unexpected",
    }));
    const permissions = new FixedPermissionEvaluator([
      {
        outcome: "ask",
        reason: "requires approval",
        ruleId: "workspace.confirm",
        resolvedArguments: { path: "C:/workspace/README.md" },
      },
    ]);
    const confirmations = new FixedConfirmer([false]);

    const result = await dispatchToolCall({
      ...baseInput(permissions, confirmations, store),
      tools: [makeTool("file_read", execute)],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission_rejected" },
    });
    expect(confirmations.calls).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(
      store.events("session-1").map((event) => event.type),
    ).toEqual([
      "tool_requested",
      "permission_decided",
      "permission_confirmed",
      "tool_failed",
    ]);
  });

  it("does not ask or execute a denied call", async () => {
    const store = new MemorySessionStore();
    const execute = vi.fn();
    const confirmations = new FixedConfirmer([]);

    const result = await dispatchToolCall({
      ...baseInput(
        new FixedPermissionEvaluator([
          {
            outcome: "deny",
            reason: "outside workspace",
            ruleId: "workspace.escape",
          },
        ]),
        confirmations,
        store,
      ),
      tools: [makeTool("file_read", execute)],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(result.toolCallId).toBe("call-1");
    expect(result.ok).toBe(false);
    expect(confirmations.calls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("handles permission evaluation failure and tool execution failure", async () => {
    const errorTool = makeTool("error_tool", async () => {
      throw new Error("Execution exploded");
    });

    const store = new MemorySessionStore();
    const call1 = { id: "c-err", name: "error_tool", arguments: {} };
    const base = baseInput(new FixedPermissionEvaluator([]), new FixedConfirmer([]), store);

    const permResult = await dispatchToolCall({
      ...base,
      state: { ...base.state, call: call1 },
      tools: [errorTool],
      permissions: {
        evaluate: async () => { throw new Error("Permission exploded"); }
      } as any,
    });
    expect(permResult).toMatchObject({
      ok: false,
      error: { code: "permission_evaluation_failed", message: "Permission exploded" }
    });

    const call2 = { id: "c-err2", name: "error_tool", arguments: {} };
    const execResult = await dispatchToolCall({
      ...base,
      state: { ...base.state, call: call2 },
      permissions: new FixedPermissionEvaluator([{ outcome: "allow", reason: "test", ruleId: "test", resolvedArguments: {} }]),
      tools: [errorTool],
    });
    expect(execResult).toMatchObject({
      ok: false,
      error: { code: "tool_execution_failed", message: "Execution exploded" }
    });
  });

  it("returns structured failures for unknown tools and mismatched result ids", async () => {
    const unknownStore = new MemorySessionStore();
    const unusedPermissions = new FixedPermissionEvaluator([]);
    const unknown = await dispatchToolCall({
      ...baseInput(
        unusedPermissions,
        new FixedConfirmer([]),
        unknownStore,
      ),
      tools: [],
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "tool_not_found" },
    });
    expect(unusedPermissions.requests).toEqual([]);

    const mismatchStore = new MemorySessionStore();
    const mismatch = await dispatchToolCall({
      ...baseInput(
        new FixedPermissionEvaluator([
          {
            outcome: "allow",
            reason: "allowed",
            ruleId: "allow",
            resolvedArguments: originalCall.arguments,
          },
        ]),
        new FixedConfirmer([]),
        mismatchStore,
      ),
      tools: [
        makeTool("file_read", async () => ({
          toolCallId: "another-call",
          ok: true,
          output: "wrong",
        })),
      ],
    });
    expect(mismatch).toMatchObject({
      ok: false,
      toolCallId: "call-1",
      error: { code: "invalid_tool_result" },
    });
  });

  it("reuses persisted decisions and confirmations without repeating them", async () => {
    const rejectedStore = new MemorySessionStore();
    const rejectedPermissions = new FixedPermissionEvaluator([]);
    const rejectedConfirmations = new FixedConfirmer([]);
    const execute = vi.fn();
    const rejected = await dispatchToolCall({
      ...baseInput(
        rejectedPermissions,
        rejectedConfirmations,
        rejectedStore,
      ),
      state: {
        call: originalCall,
        step: 1,
        requestRecorded: true,
        decision: {
          outcome: "ask",
          reason: "approval required",
          ruleId: "workspace.confirm",
          resolvedArguments: { path: "C:/workspace/README.md" },
        },
        confirmation: false,
        executionStarted: false,
      },
      tools: [makeTool("file_read", execute)],
    });

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "permission_rejected" },
    });
    expect(rejectedPermissions.requests).toEqual([]);
    expect(rejectedConfirmations.calls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(
      rejectedStore.events("session-1").map((event) => event.type),
    ).toEqual(["tool_failed"]);

    const allowedStore = new MemorySessionStore();
    const allowedPermissions = new FixedPermissionEvaluator([]);
    const allowedExecute = vi.fn(async (call: ToolCall) => ({
      toolCallId: call.id,
      ok: true as const,
      output: String(call.arguments["path"]),
    }));
    const allowed = await dispatchToolCall({
      ...baseInput(
        allowedPermissions,
        new FixedConfirmer([]),
        allowedStore,
      ),
      state: {
        call: originalCall,
        step: 1,
        requestRecorded: true,
        decision: {
          outcome: "allow",
          reason: "already allowed",
          ruleId: "workspace.read",
          resolvedArguments: { path: "C:/workspace/PERSISTED.md" },
        },
        confirmation: undefined,
        executionStarted: false,
      },
      tools: [makeTool("file_read", allowedExecute)],
    });

    expect(allowed.ok).toBe(true);
    expect(allowedPermissions.requests).toEqual([]);
    expect(allowedExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { path: "C:/workspace/PERSISTED.md" },
      }),
      expect.anything(),
    );
    expect(
      allowedStore.events("session-1").map((event) => event.type),
    ).toEqual([
      "tool_execution_started",
      "tool_completed",
    ]);
  });

  it("persists PROCESS_TERMINATION_FAILED as tool_failed instead of throwing", async () => {
    const store = new MemorySessionStore();
    const permissions = new FixedPermissionEvaluator([
      {
        outcome: "allow",
        reason: "inside workspace",
        ruleId: "workspace.read",
        resolvedArguments: { path: "C:/workspace/README.md" },
      },
    ]);
    const result = await dispatchToolCall({
      ...baseInput(permissions, new FixedConfirmer([]), store),
      tools: [
        makeTool("file_read", async (call: ToolCall) => ({
          toolCallId: call.id,
          ok: false as const,
          output: "",
          error: {
            code: "PROCESS_TERMINATION_FAILED",
            message: "process tree did not terminate",
            retryable: false,
          },
        })),
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROCESS_TERMINATION_FAILED" },
    });
    expect(
      store.events("session-1").map((event) => event.type),
    ).toEqual([
      "tool_requested",
      "permission_decided",
      "tool_execution_started",
      "tool_failed",
    ]);
  });

  it("records a mid-execution abort as CANCELLED instead of bricking the session", async () => {
    const controller = new AbortController();
    const store = new MemorySessionStore();
    const permissions = new FixedPermissionEvaluator([
      {
        outcome: "allow",
        reason: "inside workspace",
        ruleId: "workspace.read",
        resolvedArguments: { path: "C:/workspace/README.md" },
      },
    ]);
    const result = await dispatchToolCall({
      ...baseInput(permissions, new FixedConfirmer([]), store),
      signal: controller.signal,
      tools: [
        makeTool("file_read", async () => {
          controller.abort();
          throw new Error("boom");
        }),
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });
    expect(
      store.events("session-1").map((event) => event.type),
    ).toContain("tool_failed");
  });
});
