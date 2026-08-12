import type { PermissionDecision, PermissionMode } from "./permission.js";
import type {
  AssistantModelMessage,
  ModelStopReason,
  TokenUsage,
} from "./model.js";
import type {
  ToolCall,
  ToolFailure,
  ToolSuccess,
} from "./tool.js";

export const SESSION_STATES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export type TerminalSessionState = Exclude<SessionState, "running">;

export interface SessionEventBase {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly at: string;
}

export type SessionEventData =
  | {
      readonly type: "session_started";
      readonly task: string;
      readonly workspaceRoot: string;
      readonly permissionMode: PermissionMode;
    }
  | {
      readonly type: "turn_started";
      readonly turnId: string;
      readonly kind: "continue" | "new" | "resume";
    }
  | {
      readonly type: "user_message";
      readonly turnId: string;
      readonly content: string;
    }
  | {
      readonly type: "model_request_started";
      readonly turnId: string;
      readonly step: number;
    }
  | {
      readonly type: "model_output";
      readonly turnId: string;
      readonly step: number;
      readonly text: string;
    }
  | {
      readonly type: "model_response_completed";
      readonly turnId: string;
      readonly step: number;
      readonly message: AssistantModelMessage;
      readonly stopReason: ModelStopReason;
      readonly usage: TokenUsage;
    }
  | {
      readonly type: "tool_requested";
      readonly turnId: string;
      readonly step: number;
      readonly call: ToolCall;
    }
  | {
      readonly type: "permission_decided";
      readonly turnId: string;
      readonly step: number;
      readonly toolCallId: string;
      readonly decision: PermissionDecision;
    }
  | {
      readonly type: "permission_confirmed";
      readonly turnId: string;
      readonly step: number;
      readonly toolCallId: string;
      readonly approved: boolean;
    }
  | {
      readonly type: "tool_execution_started";
      readonly turnId: string;
      readonly step: number;
      readonly toolCallId: string;
    }
  | {
      readonly type: "tool_completed";
      readonly turnId: string;
      readonly step: number;
      readonly result: ToolSuccess;
    }
  | {
      readonly type: "tool_failed";
      readonly turnId: string;
      readonly step: number;
      readonly result: ToolFailure;
    }
  | {
      readonly type: "context_compacted";
      readonly turnId: string;
      readonly beforeTokens: number;
      readonly afterTokens: number;
    }
  | {
      readonly type: "turn_completed";
      readonly turnId: string;
      readonly output: string;
      readonly steps: number;
      readonly usage: TokenUsage;
    }
  | {
      readonly type: "turn_cancelled";
      readonly turnId: string;
      readonly reason: string;
    }
  | {
      readonly type: "turn_failed";
      readonly turnId: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: "session_completed";
      readonly summary: string;
      readonly usage: TokenUsage;
    }
  | {
      readonly type: "session_failed";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: "session_cancelled";
      readonly reason: string;
    };

export type SessionEvent = SessionEventBase & SessionEventData;

export interface SessionEventSink {
  append(
    sessionId: string,
    event: SessionEventData,
    token?: string,
  ): Promise<SessionEvent>;
}

export interface SessionListItem {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly task: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly usage: TokenUsage;
}

export interface SessionEventStore extends SessionEventSink {
  get(sessionId: string): Promise<SessionListItem | undefined>;
  read(sessionId: string): AsyncIterable<SessionEvent>;
  list(): Promise<readonly SessionListItem[]>;
}

export function isTerminalSessionState(
  state: SessionState,
): state is TerminalSessionState {
  return state !== "running";
}
