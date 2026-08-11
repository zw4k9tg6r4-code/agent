import type {
  AgentDependencies,
  CheckpointRestoreResult,
  CheckpointStore,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  PermissionConfirmer,
  PermissionDecision,
  PermissionEvaluator,
  SessionEvent,
  SessionEventData,
  SessionEventStore,
  SessionListItem,
  SessionState,
  TokenUsage,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@agent/contracts";

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

export class MemorySessionStore implements SessionEventStore {
  readonly #events = new Map<string, SessionEvent[]>();

  async append(
    sessionId: string,
    data: SessionEventData,
  ): Promise<SessionEvent> {
    const events = this.#events.get(sessionId) ?? [];
    const event = {
      ...data,
      eventId: `event-${sessionId}-${events.length + 1}`,
      sessionId,
      sequence: events.length + 1,
      at: new Date(events.length * 1_000).toISOString(),
    } as SessionEvent;
    events.push(event);
    this.#events.set(sessionId, events);
    return event;
  }

  async get(sessionId: string): Promise<SessionListItem | undefined> {
    const events = this.#events.get(sessionId);
    if (events === undefined || events.length === 0) {
      return undefined;
    }
    const started = events.find(
      (event) => event.type === "session_started",
    );
    if (started?.type !== "session_started") {
      throw new Error("session_started is missing");
    }
    let state: SessionState = "running";
    let usage = ZERO_USAGE;
    for (const event of events) {
      if (event.type === "model_response_completed") {
        usage = addUsage(usage, event.usage);
      } else if (event.type === "session_completed") {
        state = "completed";
      } else if (event.type === "session_failed") {
        state = "failed";
      } else if (event.type === "session_cancelled") {
        state = "cancelled";
      }
    }
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("session event list unexpectedly empty");
    }
    return {
      sessionId,
      state,
      task: started.task,
      updatedAt: last.at,
      lastSequence: last.sequence,
      usage,
    };
  }

  async *read(sessionId: string): AsyncIterable<SessionEvent> {
    for (const event of this.#events.get(sessionId) ?? []) {
      yield event;
    }
  }

  async list(): Promise<readonly SessionListItem[]> {
    const items = await Promise.all(
      [...this.#events.keys()].map(
        async (sessionId) => this.get(sessionId),
      ),
    );
    return items.filter(
      (item): item is SessionListItem => item !== undefined,
    );
  }

  events(sessionId: string): readonly SessionEvent[] {
    return this.#events.get(sessionId) ?? [];
  }
}

export class NoopCheckpointStore implements CheckpointStore {
  async capture(): Promise<void> {}

  async restore(): Promise<CheckpointRestoreResult> {
    return { restoredPaths: [], removedPaths: [] };
  }
}

export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ModelRequest[] = [];
  readonly #scripts: (
    | readonly ModelEvent[]
    | Error
  )[];

  constructor(
    scripts: readonly (readonly ModelEvent[] | Error)[],
  ) {
    this.#scripts = [...scripts];
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const script = this.#scripts.shift();
    if (script === undefined) {
      throw new Error("No scripted model response remains.");
    }
    if (script instanceof Error) {
      throw script;
    }
    for (const event of script) {
      yield event;
    }
  }
}

export class FixedPermissionEvaluator implements PermissionEvaluator {
  readonly decisions: PermissionDecision[];
  readonly requests: ToolCall[] = [];

  constructor(decisions: readonly PermissionDecision[]) {
    this.decisions = [...decisions];
  }

  async evaluate(
    request: Parameters<PermissionEvaluator["evaluate"]>[0],
  ): Promise<PermissionDecision> {
    this.requests.push(request.call);
    const decision = this.decisions.shift();
    if (decision === undefined) {
      throw new Error("No permission decision remains.");
    }
    return decision;
  }
}

export class FixedConfirmer implements PermissionConfirmer {
  readonly approvals: boolean[];
  calls = 0;

  constructor(approvals: readonly boolean[]) {
    this.approvals = [...approvals];
  }

  async confirm(): Promise<boolean> {
    this.calls += 1;
    const approval = this.approvals.shift();
    if (approval === undefined) {
      throw new Error("No confirmation response remains.");
    }
    return approval;
  }
}

export function makeTool(
  name: string,
  execute: (call: ToolCall) => Promise<ToolResult>,
  riskLevel: ToolDefinition["riskLevel"] = "read",
): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      riskLevel,
      outputLimitBytes: 4_096,
      supportsCancellation: true,
    },
    execute,
  };
}

export function makeDependencies(
  overrides: Partial<AgentDependencies> = {},
): AgentDependencies {
  return {
    provider: new ScriptedProvider([]),
    tools: [],
    permissions: new FixedPermissionEvaluator([]),
    confirmations: new FixedConfirmer([]),
    sessions: new MemorySessionStore(),
    checkpoints: new NoopCheckpointStore(),
    ...overrides,
  };
}
