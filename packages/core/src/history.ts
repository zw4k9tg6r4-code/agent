import type {
  ModelMessage,
  PermissionDecision,
  PermissionMode,
  SessionEvent,
  SessionEventStore,
  TokenUsage,
  ToolCall,
} from "@agent/contracts";

export class SessionHistoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionHistoryError";
    this.code = code;
  }
}

export interface PendingToolState {
  readonly call: ToolCall;
  readonly step: number;
  readonly requestRecorded: boolean;
  readonly decision: PermissionDecision | undefined;
  readonly confirmation: boolean | undefined;
  readonly executionStarted: boolean;
}

export interface SessionSnapshot {
  readonly events: readonly SessionEvent[];
  readonly workspaceRoot: string;
  readonly permissionMode: PermissionMode;
  readonly messages: readonly ModelMessage[];
  readonly pendingToolStates: readonly PendingToolState[];
  readonly unknownToolCallIds: readonly string[];
  readonly incompleteTurnId: string | undefined;
  readonly logicalTurnSteps: number;
  readonly logicalTurnUsage: TokenUsage;
  readonly lastTurnCompleted: boolean;
}

interface MutablePendingToolState {
  call: ToolCall;
  step: number;
  requestRecorded: boolean;
  decision: PermissionDecision | undefined;
  confirmation: boolean | undefined;
  executionStarted: boolean;
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const estimated =
    (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  const base = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
  return estimated === 0
    ? base
    : { ...base, estimatedCostUsd: estimated };
}

function initialToolState(
  call: ToolCall,
  step: number,
): MutablePendingToolState {
  return {
    call,
    step,
    requestRecorded: false,
    decision: undefined,
    confirmation: undefined,
    executionStarted: false,
  };
}

function requireToolState(
  states: Map<string, MutablePendingToolState>,
  toolCallId: string,
  eventType: string,
): MutablePendingToolState {
  const state = states.get(toolCallId);
  if (state === undefined) {
    throw new SessionHistoryError(
      "malformed_session",
      `${eventType} references unknown tool call ${toolCallId}.`,
    );
  }
  return state;
}

function failedToolContent(
  event: Extract<SessionEvent, { readonly type: "tool_failed" }>,
): string {
  return JSON.stringify({
    ok: false,
    output: event.result.output,
    error: event.result.error,
  });
}

const MAX_SESSION_EVENTS = 100_000;

export async function loadSessionSnapshot(
  store: SessionEventStore,
  sessionId: string,
): Promise<SessionSnapshot> {
  const events: SessionEvent[] = [];
  for await (const event of store.read(sessionId)) {
    if (events.length >= MAX_SESSION_EVENTS) {
      throw new SessionHistoryError(
        "history_limit_exceeded",
        `Session history exceeded the limit of ${MAX_SESSION_EVENTS} events.`,
      );
    }
    events.push(event);
  }
  const started = events.find(
    (event) => event.type === "session_started",
  );
  if (started?.type !== "session_started") {
    throw new SessionHistoryError(
      "session_not_found",
      `Session does not exist or lacks session_started: ${sessionId}`,
    );
  }

  const messages: ModelMessage[] = [];
  const toolStates = new Map<string, MutablePendingToolState>();
  const terminalToolCallIds = new Set<string>();
  const turnTerminal = new Set<string>();
  const turnCompleted = new Set<string>();
  let latestTurnId: string | undefined;
  let logicalTurnSteps = 0;
  let logicalTurnUsage = ZERO_USAGE;

  for (const event of events) {
    if (event.type === "turn_started") {
      latestTurnId = event.turnId;
    } else if (event.type === "user_message") {
      messages.push({ role: "user", content: event.content });
      logicalTurnSteps = 0;
      logicalTurnUsage = ZERO_USAGE;
    } else if (event.type === "model_request_started") {
      logicalTurnSteps = Math.max(logicalTurnSteps, event.step);
    } else if (event.type === "model_response_completed") {
      messages.push(event.message);
      logicalTurnUsage = addUsage(logicalTurnUsage, event.usage);
      for (const call of event.message.toolCalls ?? []) {
        if (terminalToolCallIds.has(call.id)) {
          throw new SessionHistoryError(
            "malformed_session",
            `Tool call id was reused after a terminal result: ${call.id}.`,
          );
        }
        toolStates.set(
          call.id,
          toolStates.get(call.id) ?? initialToolState(call, event.step),
        );
      }
    } else if (event.type === "tool_requested") {
      const state =
        toolStates.get(event.call.id) ??
        initialToolState(event.call, event.step);
      state.call = event.call;
      state.step = event.step;
      state.requestRecorded = true;
      toolStates.set(event.call.id, state);
    } else if (event.type === "permission_decided") {
      const state = requireToolState(
        toolStates,
        event.toolCallId,
        event.type,
      );
      state.decision = event.decision;
    } else if (event.type === "permission_confirmed") {
      const state = requireToolState(
        toolStates,
        event.toolCallId,
        event.type,
      );
      if (state.decision?.outcome !== "ask") {
        throw new SessionHistoryError(
          "malformed_session",
          `permission_confirmed lacks an ask decision for ${event.toolCallId}.`,
        );
      }
      state.confirmation = event.approved;
    } else if (event.type === "tool_execution_started") {
      const state = requireToolState(
        toolStates,
        event.toolCallId,
        event.type,
      );
      state.executionStarted = true;
    } else if (
      event.type === "tool_completed" ||
      event.type === "tool_failed"
    ) {
      const state = requireToolState(
        toolStates,
        event.result.toolCallId,
        event.type,
      );
      messages.push({
        role: "tool",
        content:
          event.type === "tool_completed"
            ? event.result.output
            : failedToolContent(event),
        toolCallId: event.result.toolCallId,
        name: state.call.name,
      });
      toolStates.delete(event.result.toolCallId);
      terminalToolCallIds.add(event.result.toolCallId);
    } else if (
      event.type === "turn_completed" ||
      event.type === "turn_failed"
    ) {
      turnTerminal.add(event.turnId);
      if (event.type === "turn_completed") {
        turnCompleted.add(event.turnId);
      }
    }
  }

  const pendingToolStates = [...toolStates.values()].filter(
    (state) => !state.executionStarted,
  );
  const unknownToolCallIds = [...toolStates.values()]
    .filter((state) => state.executionStarted)
    .map((state) => state.call.id);
  const incompleteTurnId =
    latestTurnId !== undefined && !turnTerminal.has(latestTurnId)
      ? latestTurnId
      : undefined;

  return {
    events,
    workspaceRoot: started.workspaceRoot,
    permissionMode: started.permissionMode,
    messages,
    pendingToolStates: pendingToolStates.map((state) => ({ ...state })),
    unknownToolCallIds,
    incompleteTurnId,
    logicalTurnSteps,
    logicalTurnUsage,
    lastTurnCompleted:
      latestTurnId !== undefined && turnCompleted.has(latestTurnId),
  };
}
