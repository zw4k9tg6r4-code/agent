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
} from "@agent/contracts";

import { AgentCoreError } from "./agent-runner.js";
import type { PendingToolState } from "./history.js";
import { sanitizeToolResult } from "./redaction.js";
import { Buffer } from "node:buffer";

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

  let result: ToolResult;
  try {
    result = await tool.execute(resolvedCall, {
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      signal: input.signal,
      checkpoints: input.checkpoints,
    });
  } catch (error) {
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    result = failure(
      input.state.call,
      "tool_execution_failed",
      error instanceof Error ? error.message : "Tool execution failed.",
      true,
    );
  }

  result = sanitizeToolResult(result);

  if (!result.ok && result.error.code === "PROCESS_TERMINATION_FAILED") {
    throw new AgentCoreError(
      "process_termination_failed",
      "process tree did not terminate within the bounded kill deadline",
    );
  }

  if (result.ok) {
    const outputBytes = Buffer.byteLength(result.output, "utf8");
    if (outputBytes > tool.definition.outputLimitBytes) {
      result = failure(
        input.state.call,
        "tool_output_too_large",
        `Tool output exceeded the limit of ${tool.definition.outputLimitBytes} bytes.`,
      );
    }
  }

  if (result.toolCallId !== input.state.call.id) {
    result = failure(
      input.state.call,
      "invalid_tool_result",
      "Tool result id does not match the requested call id.",
    );
  }
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
