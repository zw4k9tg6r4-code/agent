import { Buffer } from "node:buffer";

import type {
  CheckpointStore,
  PermissionConfirmer,
  PermissionDecision,
  PermissionEvaluator,
  PermissionMode,
  SessionEventStore,
  Tool,
  ToolCall,
  ToolFailure,
  ToolResult,
  JsonObject,
} from "@agent/contracts";

import type { PendingToolState } from "./history.js";
import { sanitizeToolResult } from "./redaction.js";

export interface DispatchToolInput {
  readonly state: PendingToolState;
  readonly tools: readonly Tool[];
  readonly permissionMode: PermissionMode;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly permissions: PermissionEvaluator;
  readonly confirmations: PermissionConfirmer;
  readonly sessions: SessionEventStore;
  readonly checkpoints: CheckpointStore;
}

export class ToolDispatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolDispatchError";
    this.code = code;
  }
}

function failure(
  call: ToolCall,
  code: string,
  message: string,
  retryable = false,
): ToolFailure {
  return {
    toolCallId: call.id,
    ok: false,
    output: "",
    error: { code, message, retryable },
  };
}

async function recordFailure(
  input: DispatchToolInput,
  result: ToolFailure,
): Promise<ToolFailure> {
  await input.sessions.append(input.sessionId, {
    type: "tool_failed",
    turnId: input.turnId,
    step: input.state.step,
    result,
  });
  return result;
}

function validateAndNormalizeToolResult(
  rawResult: unknown,
  call: ToolCall,
  limitBytes: number,
): ToolResult {
  if (typeof rawResult !== "object" || rawResult === null) {
    return failure(call, "invalid_tool_result", "Tool returned a non-object result.");
  }
  const res = rawResult as Record<string, unknown>;
  if (typeof res["ok"] !== "boolean") {
    return failure(call, "invalid_tool_result", "Tool result ok property must be a boolean.");
  }
  if (res["toolCallId"] !== call.id) {
    return failure(call, "invalid_tool_result", "Tool result id does not match the requested call id.");
  }
  if (typeof res["output"] !== "string") {
    return failure(call, "invalid_tool_result", "Tool output must be a string.");
  }
  if (Buffer.byteLength(res["output"], "utf8") > limitBytes) {
    return failure(call, "tool_output_too_large", `Tool output string exceeded the limit of ${limitBytes} bytes.`);
  }
  if (res["metadata"] !== undefined) {
    if (typeof res["metadata"] !== "object" || res["metadata"] === null || Array.isArray(res["metadata"])) {
      return failure(call, "invalid_tool_result", "Tool metadata must be a JSON object.");
    }
    const visited = new Set<object>();
    let nodes = 0;
    let valid = true;
    let failReason = "";
    function checkMetadata(val: unknown, depth: number): void {
      if (!valid) return;
      nodes += 1;
      if (nodes > 2048) {
        valid = false;
        failReason = "Tool metadata exceeded 2048 nodes.";
        return;
      }
      if (depth > 32) {
        valid = false;
        failReason = "Tool metadata exceeded depth limit of 32.";
        return;
      }
      if (typeof val === "object" && val !== null) {
        if (visited.has(val)) {
          valid = false;
          failReason = "Tool metadata contains circular references.";
          return;
        }
        visited.add(val);
        if (Array.isArray(val)) {
          for (const item of val) checkMetadata(item, depth + 1);
        } else {
          for (const item of Object.values(val)) checkMetadata(item, depth + 1);
        }
      }
    }
    checkMetadata(res["metadata"], 1);
    if (!valid) {
      return failure(call, "invalid_tool_result", failReason);
    }
    let metaStr: string;
    try {
      metaStr = JSON.stringify(res["metadata"]);
    } catch {
      return failure(call, "invalid_tool_result", "Tool metadata could not be serialized to JSON.");
    }
    if (Buffer.byteLength(metaStr, "utf8") > limitBytes) {
      return failure(call, "tool_metadata_too_large", `Tool metadata exceeded the limit of ${limitBytes} bytes.`);
    }
  }
  if (!res["ok"]) {
    const errorObj = res["error"];
    if (typeof errorObj !== "object" || errorObj === null || Array.isArray(errorObj)) {
      return failure(call, "invalid_tool_result", "Tool failure missing valid error object.");
    }
    const err = errorObj as Record<string, unknown>;
    const code = typeof err["code"] === "string" && err["code"].length > 0 ? err["code"] : "tool_failed";
    const message = typeof err["message"] === "string" ? err["message"] : "Tool execution failed.";
    const retryable = typeof err["retryable"] === "boolean" ? err["retryable"] : false;
    return {
      toolCallId: call.id,
      ok: false,
      output: res["output"] as string,
      ...(res["metadata"] !== undefined && { metadata: res["metadata"] as JsonObject }),
      error: { code, message, retryable },
    };
  }
  return {
    toolCallId: call.id,
    ok: true,
    output: res["output"] as string,
    ...(res["metadata"] !== undefined && { metadata: res["metadata"] as JsonObject }),
  };
}

export async function dispatchToolCall(
  input: DispatchToolInput,
): Promise<ToolResult> {
  if (input.signal.aborted) {
    throw input.signal.reason;
  }
  if (input.state.executionStarted) {
    throw new ToolDispatchError(
      "unknown_tool_execution_state",
      `Tool execution already started without a terminal result: ${input.state.call.id}.`,
    );
  }
  if (!input.state.requestRecorded) {
    await input.sessions.append(input.sessionId, {
      type: "tool_requested",
      turnId: input.turnId,
      step: input.state.step,
      call: input.state.call,
    });
  }

  const tool = input.tools.find(
    (candidate) => candidate.definition.name === input.state.call.name,
  );
  if (tool === undefined) {
    return recordFailure(
      input,
      failure(
        input.state.call,
        "tool_not_found",
        `No registered tool is named ${input.state.call.name}.`,
      ),
    );
  }

  const permissionRequest = {
    mode: input.permissionMode,
    tool: tool.definition,
    call: input.state.call,
    workspaceRoot: input.workspaceRoot,
  } as const;

  let decision: PermissionDecision | undefined = input.state.decision;
  if (decision === undefined) {
    try {
      decision = await input.permissions.evaluate(permissionRequest);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Permission evaluation failed.";
      return recordFailure(
        input,
        failure(
          input.state.call,
          "permission_evaluation_failed",
          message,
        ),
      );
    }
    await input.sessions.append(input.sessionId, {
      type: "permission_decided",
      turnId: input.turnId,
      step: input.state.step,
      toolCallId: input.state.call.id,
      decision,
    });
  }

  if (decision.outcome === "deny") {
    return recordFailure(
      input,
      failure(
        input.state.call,
        "permission_denied",
        decision.reason,
      ),
    );
  }

  if (decision.outcome === "ask") {
    let approved = input.state.confirmation;
    if (approved === undefined) {
      approved = await input.confirmations.confirm(
        permissionRequest,
        decision,
        input.signal,
      );
      await input.sessions.append(input.sessionId, {
        type: "permission_confirmed",
        turnId: input.turnId,
        step: input.state.step,
        toolCallId: input.state.call.id,
        approved,
      });
    }
    if (!approved) {
      return recordFailure(
        input,
        failure(
          input.state.call,
          "permission_rejected",
          "The user rejected this tool call.",
        ),
      );
    }
  }

  const resolvedCall: ToolCall = {
    id: input.state.call.id,
    name: input.state.call.name,
    arguments: decision.resolvedArguments,
  };
  await input.sessions.append(input.sessionId, {
    type: "tool_execution_started",
    turnId: input.turnId,
    step: input.state.step,
    toolCallId: input.state.call.id,
  });

  let rawResult: ToolResult;
  try {
    rawResult = await tool.execute(resolvedCall, {
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      signal: input.signal,
      checkpoints: input.checkpoints,
    });
  } catch (error) {
    if (input.signal.aborted) {
      // Persist the cancellation as a terminal tool result instead of
      // throwing: tool_execution_started was already appended above, and a
      // throw here would leave it without a terminal result, bricking the
      // session (unknown_tool_execution_state on every resume/finish).
      return recordFailure(
        input,
        failure(input.state.call, "CANCELLED", "process was cancelled"),
      );
    }
    rawResult = failure(
      input.state.call,
      "tool_execution_failed",
      error instanceof Error ? error.message : "Tool execution failed.",
      true,
    );
  }

  const limitBytes = tool.definition.outputLimitBytes;
  let result = validateAndNormalizeToolResult(rawResult, input.state.call, limitBytes);
  // File-content tools need verbatim output for the model to reason about
  // code; the generic name:value secret pattern would corrupt it. Metadata
  // and error messages are still fully redacted inside sanitizeToolResult.
  result = sanitizeToolResult(result, {
    namedSecrets:
      input.state.call.name !== "file_read" &&
      input.state.call.name !== "file_search",
  });

  // NOTE: PROCESS_TERMINATION_FAILED is persisted as a regular tool_failed
  // result on purpose. Throwing here would leave tool_execution_started
  // without a terminal result and brick the session (the kill deadline was
  // already enforced by the tool layer; the outcome stays visible via the
  // error code).

  if (result.ok) {
    await input.sessions.append(input.sessionId, {
      type: "tool_completed",
      turnId: input.turnId,
      step: input.state.step,
      result,
    });
  } else {
    await input.sessions.append(input.sessionId, {
      type: "tool_failed",
      turnId: input.turnId,
      step: input.state.step,
      result,
    });
  }
  return result;
}
