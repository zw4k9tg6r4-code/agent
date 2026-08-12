import type { ModelProvider, TokenUsage } from "./model.js";
import type {
  PermissionConfirmer,
  PermissionEvaluator,
  PermissionMode,
} from "./permission.js";
import type {
  SessionEventStore,
  SessionState,
  TerminalSessionState,
} from "./session.js";
import type { CheckpointStore, Tool } from "./tool.js";

export interface AgentRunLimits {
  readonly maxSteps: number;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface AgentNewTurnOptions {
  readonly kind: "new";
  readonly task: string;
  readonly workspaceRoot: string;
  readonly permissionMode: PermissionMode;
  readonly limits: AgentRunLimits;
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly token?: string;
}

export interface AgentContinueTurnOptions {
  readonly kind: "continue";
  readonly sessionId: string;
  readonly message: string;
  readonly workspaceRoot: string;
  readonly limits: AgentRunLimits;
  readonly signal: AbortSignal;
  readonly token?: string;
}

export interface AgentResumeTurnOptions {
  readonly kind: "resume";
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly limits: AgentRunLimits;
  readonly signal: AbortSignal;
  readonly token?: string;
}

export type AgentTurnOptions =
  | AgentContinueTurnOptions
  | AgentNewTurnOptions
  | AgentResumeTurnOptions;

export interface AgentFinishOptions {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly token?: string;
}

export interface AgentDependencies {
  readonly provider: ModelProvider;
  readonly tools: readonly Tool[];
  readonly permissions: PermissionEvaluator;
  readonly confirmations: PermissionConfirmer;
  readonly sessions: SessionEventStore;
  readonly checkpoints: CheckpointStore;
}

export interface AgentRunError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentTurnResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: SessionState;
  readonly output: string;
  readonly steps: number;
  readonly usage: TokenUsage;
  readonly error?: AgentRunError;
}

export interface AgentRunResult {
  readonly sessionId: string;
  readonly status: TerminalSessionState;
  readonly summary: string;
  readonly steps: number;
  readonly usage: TokenUsage;
  readonly error?: AgentRunError;
}

export interface AgentRunner {
  runTurn(options: AgentTurnOptions): Promise<AgentTurnResult>;
  finishSession(options: AgentFinishOptions): Promise<AgentRunResult>;
}
