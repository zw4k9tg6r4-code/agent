import type { ToolCall, ToolDefinition } from "./tool.js";

export interface SystemModelMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserModelMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantModelMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolModelMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
  readonly name: string;
}

export type ModelMessage =
  | AssistantModelMessage
  | SystemModelMessage
  | ToolModelMessage
  | UserModelMessage;

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export type ModelStopReason =
  | "cancelled"
  | "end_turn"
  | "length"
  | "tool_use";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number;
}

export type ModelEvent =
  | {
      readonly type: "text_delta";
      readonly delta: string;
    }
  | {
      readonly type: "tool_call";
      readonly call: ToolCall;
    }
  | {
      readonly type: "usage";
      readonly usage: TokenUsage;
    }
  | {
      readonly type: "completed";
      readonly stopReason: ModelStopReason;
    };

export interface ModelProviderOptions {
  readonly signal: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  stream(
    request: ModelRequest,
    options: ModelProviderOptions,
  ): AsyncIterable<ModelEvent>;
}

export function isTerminalModelEvent(event: ModelEvent): boolean {
  return event.type === "completed";
}
