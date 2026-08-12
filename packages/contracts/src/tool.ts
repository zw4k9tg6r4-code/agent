import type { JsonObject, JsonSchema } from "./json.js";

export const RISK_LEVELS = [
  "read",
  "write",
  "execute",
  "network",
  "destructive",
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly riskLevel: RiskLevel;
  readonly outputLimitBytes: number;
  readonly supportsCancellation: boolean;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolResultBase {
  readonly toolCallId: string;
  readonly output: string;
  readonly metadata?: JsonObject;
}

export interface ToolSuccess extends ToolResultBase {
  readonly ok: true;
  readonly error?: never;
}

export interface ToolFailure extends ToolResultBase {
  readonly ok: false;
  readonly error: ToolError;
}

export type ToolResult = ToolFailure | ToolSuccess;

export interface CheckpointCaptureRequest {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly signal: AbortSignal;
}

export interface CheckpointRestoreRequest {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly expectedHashes?: ReadonlyMap<string, string | null>;
}

export interface CheckpointRestoreResult {
  readonly restoredPaths: readonly string[];
  readonly removedPaths: readonly string[];
}

export interface CheckpointStore {
  capture(request: CheckpointCaptureRequest): Promise<void>;
  restore(request: CheckpointRestoreRequest): Promise<CheckpointRestoreResult>;
}

export interface ToolExecutionContext {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly checkpoints: CheckpointStore;
}

export interface Tool {
  readonly definition: ToolDefinition;
  execute(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
