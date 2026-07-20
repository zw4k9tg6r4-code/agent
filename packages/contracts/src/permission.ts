import type { JsonObject } from "./json.js";
import type { ToolCall, ToolDefinition } from "./tool.js";

export const PERMISSION_MODES = [
  "readonly",
  "workspace",
  "trusted",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type PermissionOutcome = "allow" | "ask" | "deny";

export interface PermissionRequest {
  readonly mode: PermissionMode;
  readonly tool: ToolDefinition;
  readonly call: ToolCall;
  readonly workspaceRoot: string;
}

export interface PermissionDecisionBase {
  readonly reason: string;
  readonly ruleId: string;
}

export interface PermissionExecutableDecision extends PermissionDecisionBase {
  readonly outcome: "allow" | "ask";
  readonly resolvedArguments: JsonObject;
}

export interface PermissionDenyDecision extends PermissionDecisionBase {
  readonly outcome: "deny";
}

export type PermissionDecision =
  | PermissionDenyDecision
  | PermissionExecutableDecision;

export interface PermissionEvaluator {
  evaluate(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface PermissionConfirmer {
  confirm(
    request: PermissionRequest,
    decision: PermissionDecision,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}
