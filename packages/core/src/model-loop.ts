import { Buffer } from "node:buffer";

import type {
  AgentDependencies,
  AgentRunError,
  AgentRunLimits,
  ModelEvent,
  ModelMessage,
  ModelStopReason,
  PermissionMode,
  TokenUsage,
  ToolCall,
  ToolResult,
} from "@agent/contracts";

import {
  compactModelMessages,
  estimateMessagesTokens,
} from "./context.js";
import { AgentCoreError } from "./errors.js";
import type { PendingToolState } from "./history.js";
import { dispatchToolCall } from "./tool-dispatcher.js";

function validateToolCallPayload(call: ToolCall): void {
  if (typeof call.id !== "string" || call.id.trim().length === 0 || Buffer.byteLength(call.id, "utf8") > 256) {
    throw new AgentCoreError("invalid_tool_call", "Tool call ID must be a non-empty string under 256 bytes.");
  }
  if (typeof call.name !== "string" || call.name.trim().length === 0 || Buffer.byteLength(call.name, "utf8") > 256) {
    throw new AgentCoreError("invalid_tool_call", "Tool call name must be a non-empty string under 256 bytes.");
  }
  if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    throw new AgentCoreError("invalid_tool_call", "Tool call arguments must be a valid JSON object.");
  }
  let nodes = 0;
  function walk(val: unknown, currentDepth: number): void {
    nodes += 1;
    if (nodes > 2048) {
      throw new AgentCoreError("invalid_tool_call", "Tool call arguments exceeded 2048 nodes.");
    }
    if (currentDepth > 32) {
      throw new AgentCoreError("invalid_tool_call", "Tool call arguments exceeded depth limit of 32.");
    }
    if (typeof val === "object" && val !== null) {
      if (Array.isArray(val)) {
        for (const item of val) walk(item, currentDepth + 1);
      } else {
        for (const v of Object.values(val)) walk(v, currentDepth + 1);
      }
    }
  }
  walk(call.arguments, 1);
  let serialized: string;
  try {
    serialized = JSON.stringify(call.arguments);
  } catch {
    throw new AgentCoreError("invalid_tool_call", "Tool call arguments could not be serialized to JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 1_000_000) {
    throw new AgentCoreError("invalid_tool_call", "Tool call arguments exceeded 1MB limit.");
  }
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export interface ModelLoopInput {
  readonly dependencies: AgentDependencies;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workspaceRoot: string;
  readonly permissionMode: PermissionMode;
  readonly messages: readonly ModelMessage[];
  readonly limits: AgentRunLimits;
  readonly signal: AbortSignal;
  readonly pendingToolStates?: readonly PendingToolState[];
  readonly initialSteps?: number;
  readonly initialUsage?: TokenUsage;
}

interface ModelLoopBase {
  readonly output: string;
  readonly steps: number;
  readonly usage: TokenUsage;
  readonly messages: readonly ModelMessage[];
}

export type ModelLoopResult =
  | (ModelLoopBase & { readonly kind: "completed" })
  | (ModelLoopBase & {
      readonly kind: "failed";
      readonly error: AgentRunError;
    });

function sumUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const estimatedCost =
    (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  const base = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
  return estimatedCost === 0
    ? base
    : { ...base, estimatedCostUsd: estimatedCost };
}

function estimateUsage(
  messages: readonly ModelMessage[],
  output: string,
): TokenUsage {
  const inputTokens = estimateMessagesTokens(messages);
  const outputTokens = Math.max(1, Math.ceil(output.length / 4));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function normalizeError(error: unknown): AgentRunError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      code: error.code,
      message: error.message,
      retryable:
        "retryable" in error && typeof error.retryable === "boolean"
          ? error.retryable
          : false,
    };
  }
  return {
    code: "model_provider_failed",
    message:
      error instanceof Error ? error.message : "Model provider failed.",
    retryable: false,
  };
}

function toolMessage(call: ToolCall, result: ToolResult): ModelMessage {
  return {
    role: "tool",
    content: result.ok
      ? result.output
      : JSON.stringify({
          ok: false,
          output: result.output,
          error: result.error,
        }),
    toolCallId: call.id,
    name: call.name,
  };
}

function freshToolState(
  call: ToolCall,
  step: number,
): PendingToolState {
  return {
    call,
    step,
    requestRecorded: false,
    decision: undefined,
    confirmation: undefined,
    executionStarted: false,
  };
}

async function dispatchStates(
  input: ModelLoopInput,
  messages: ModelMessage[],
  states: readonly PendingToolState[],
): Promise<void> {
  for (const state of states) {
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    const result = await dispatchToolCall({
      state,
      tools: input.dependencies.tools,
      permissionMode: input.permissionMode,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
      turnId: input.turnId,
      signal: input.signal,
      permissions: input.dependencies.permissions,
      confirmations: input.dependencies.confirmations,
      sessions: input.dependencies.sessions,
      checkpoints: input.dependencies.checkpoints,
    });
    messages.push(toolMessage(state.call, result));
  }
}

export async function runModelLoop(
  input: ModelLoopInput,
): Promise<ModelLoopResult> {
  let messages = [...input.messages];
  let usage = input.initialUsage ?? ZERO_USAGE;
  let steps = input.initialSteps ?? 0;
  let latestOutput = "";
  const seenCallIds = new Set<string>();

  for (const msg of input.messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        seenCallIds.add(call.id);
      }
    } else if (msg.role === "tool") {
      seenCallIds.add(msg.toolCallId);
    }
  }
  for (const state of input.pendingToolStates ?? []) {
    seenCallIds.add(state.call.id);
  }

  if ((input.pendingToolStates?.length ?? 0) > 0) {
    await dispatchStates(
      input,
      messages,
      input.pendingToolStates ?? [],
    );
  }

  while (steps < input.limits.maxSteps) {
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    if (usage.outputTokens >= input.limits.maxOutputTokens) {
      return {
        kind: "failed",
        output: latestOutput,
        steps,
        usage,
        messages,
        error: {
          code: "max_output_tokens_exceeded",
          message: "The turn exhausted maxOutputTokens.",
          retryable: false,
        },
      };
    }
    const compacted = compactModelMessages(
      messages,
      input.limits.maxContextTokens,
    );
    messages = [...compacted.messages];
    if (compacted.compacted) {
      await input.dependencies.sessions.append(input.sessionId, {
        type: "context_compacted",
        turnId: input.turnId,
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
      });
    }

    steps += 1;
    await input.dependencies.sessions.append(input.sessionId, {
      type: "model_request_started",
      turnId: input.turnId,
      step: steps,
    });

    const requestMessages = [...messages];
    const calls: ToolCall[] = [];
    let text = "";
    let textLength = 0;
    let requestUsage: TokenUsage | undefined;
    let stopReason: ModelStopReason | undefined;
    try {
      for await (const event of input.dependencies.provider.stream(
        {
          messages: requestMessages,
          tools: input.dependencies.tools.map((tool) => tool.definition),
          maxOutputTokens:
            input.limits.maxOutputTokens - usage.outputTokens,
        },
        { signal: input.signal },
      )) {
        if (event.type === "text_delta") {
          textLength += event.delta.length;
          if (textLength > input.limits.maxOutputTokens * 8) {
            throw new AgentCoreError("model_output_too_large", "Model output text length exceeded absolute bounds.");
          }
          text += event.delta;
          await input.dependencies.sessions.append(input.sessionId, {
            type: "model_output",
            turnId: input.turnId,
            step: steps,
            text: event.delta,
          });
        } else if (event.type === "tool_call") {
          validateToolCallPayload(event.call);
          if (seenCallIds.has(event.call.id)) {
            throw new AgentCoreError("duplicate_tool_call_id", `Model generated duplicate tool call ID: ${event.call.id}`);
          }
          if (calls.length >= 30) {
            throw new AgentCoreError("too_many_tool_calls", "Model generated too many tool calls in a single turn.");
          }
          seenCallIds.add(event.call.id);
          calls.push(event.call);
        } else if (event.type === "usage") {
          requestUsage = event.usage;
        } else if (event.type === "completed") {
          stopReason = event.stopReason;
        }
      }
    } catch (error) {
      if (input.signal.aborted) {
        throw input.signal.reason;
      }
      return {
        kind: "failed",
        output: latestOutput,
        steps,
        usage,
        messages,
        error: normalizeError(error),
      };
    }

    if (stopReason === undefined) {
      return {
        kind: "failed",
        output: latestOutput,
        steps,
        usage,
        messages,
        error: {
          code: "model_stream_incomplete",
          message: "Model stream ended without a completed event.",
          retryable: false,
        },
      };
    }
    let observedUsage = estimateUsage(requestMessages, text);
    if (
      requestUsage &&
      typeof requestUsage.inputTokens === "number" &&
      typeof requestUsage.outputTokens === "number" &&
      typeof requestUsage.totalTokens === "number" &&
      Number.isSafeInteger(requestUsage.inputTokens) &&
      Number.isSafeInteger(requestUsage.outputTokens) &&
      Number.isSafeInteger(requestUsage.totalTokens) &&
      requestUsage.inputTokens >= 0 &&
      requestUsage.outputTokens >= 0 &&
      requestUsage.totalTokens >= 0 &&
      requestUsage.totalTokens === requestUsage.inputTokens + requestUsage.outputTokens &&
      (requestUsage.estimatedCostUsd === undefined ||
        (typeof requestUsage.estimatedCostUsd === "number" &&
          Number.isFinite(requestUsage.estimatedCostUsd) &&
          requestUsage.estimatedCostUsd >= 0))
    ) {
      observedUsage = {
        inputTokens: requestUsage.inputTokens,
        outputTokens: requestUsage.outputTokens,
        totalTokens: requestUsage.totalTokens,
        ...(requestUsage.estimatedCostUsd !== undefined && {
          estimatedCostUsd: requestUsage.estimatedCostUsd,
        }),
      };
    }

    const assistant = calls.length === 0
      ? { role: "assistant" as const, content: text }
      : {
          role: "assistant" as const,
          content: text,
          toolCalls: calls,
        };
    await input.dependencies.sessions.append(input.sessionId, {
      type: "model_response_completed",
      turnId: input.turnId,
      step: steps,
      message: assistant,
      stopReason,
      usage: observedUsage,
    });
    messages.push(assistant);
    latestOutput = text || latestOutput;
    usage = sumUsage(usage, observedUsage);

    if (
      usage.outputTokens > input.limits.maxOutputTokens ||
      stopReason === "length"
    ) {
      return {
        kind: "failed",
        output: latestOutput,
        steps,
        usage,
        messages,
        error: {
          code: "max_output_tokens_exceeded",
          message: "The turn reached maxOutputTokens.",
          retryable: false,
        },
      };
    }
    if (stopReason === "cancelled") {
      throw new DOMException("Model cancelled.", "AbortError");
    }
    if (calls.length > 0 || stopReason === "tool_use") {
      if (calls.length === 0) {
        return {
          kind: "failed",
          output: latestOutput,
          steps,
          usage,
          messages,
          error: {
            code: "model_tool_call_missing",
            message: "Model stopped for tool use without a tool call.",
            retryable: false,
          },
        };
      }
      await dispatchStates(
        input,
        messages,
        calls.map((call) => freshToolState(call, steps)),
      );
      continue;
    }
    return {
      kind: "completed",
      output: latestOutput,
      steps,
      usage,
      messages,
    };
  }

  return {
    kind: "failed",
    output: latestOutput,
    steps,
    usage,
    messages,
    error: {
      code: "max_steps_exceeded",
      message: `The turn reached maxSteps (${input.limits.maxSteps}).`,
      retryable: false,
    },
  };
}
