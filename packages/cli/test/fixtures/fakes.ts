import type {
  AgentFinishOptions,
  AgentRunner,
  AgentRunResult,
  AgentTurnOptions,
  AgentTurnResult,
  CheckpointCaptureRequest,
  CheckpointRestoreRequest,
  CheckpointRestoreResult,
  CheckpointStore,
} from "@agent/contracts";

import type {
  CliIO,
  CliRuntimeFactory,
  RuntimeBundle,
  RuntimeFactoryInput,
} from "../../src/index.js";

export class FakeIO implements CliIO {
  readonly interactive = true;
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly #answers: (string | null)[];

  constructor(answers: readonly (string | null)[] = []) {
    this.#answers = [...answers];
  }

  write(text: string): void {
    this.output.push(text);
  }

  writeError(text: string): void {
    this.errors.push(text);
  }

  async readLine(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    this.output.push(prompt);
    return signal.aborted ? null : (this.#answers.shift() ?? null);
  }
}

export class FakeCheckpointStore implements CheckpointStore {
  readonly captures: CheckpointCaptureRequest[] = [];
  readonly restores: CheckpointRestoreRequest[] = [];
  result: CheckpointRestoreResult = {
    restoredPaths: ["src/app.ts"],
    removedPaths: ["src/generated.ts"],
  };

  async capture(request: CheckpointCaptureRequest): Promise<void> {
    this.captures.push(request);
  }

  async restore(
    request: CheckpointRestoreRequest,
  ): Promise<CheckpointRestoreResult> {
    this.restores.push(request);
    return this.result;
  }
}

export class FakeRunner implements AgentRunner {
  readonly turnOptions: AgentTurnOptions[] = [];
  readonly finishOptions: AgentFinishOptions[] = [];
  readonly #turnResults: AgentTurnResult[];
  readonly #finishResult: AgentRunResult;

  constructor(
    turnResults: readonly AgentTurnResult[],
    finishResult: AgentRunResult = completedRun(),
  ) {
    this.#turnResults = [...turnResults];
    this.#finishResult = finishResult;
  }

  async runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
    this.turnOptions.push(options);
    const result = this.#turnResults.shift();
    if (result === undefined) throw new Error("no fake turn result");
    return result;
  }

  async finishSession(options: AgentFinishOptions): Promise<AgentRunResult> {
    this.finishOptions.push(options);
    return { ...this.#finishResult, sessionId: options.sessionId };
  }
}

export class FakeRuntimeFactory implements CliRuntimeFactory {
  readonly inputs: RuntimeFactoryInput[] = [];
  readonly checkpoints = new FakeCheckpointStore();
  readonly #runner: AgentRunner;

  constructor(runner: AgentRunner) {
    this.#runner = runner;
  }

  async create(input: RuntimeFactoryInput): Promise<RuntimeBundle> {
    this.inputs.push(input);
    return { runner: this.#runner, checkpoints: this.checkpoints };
  }

  async createCheckpointStore(): Promise<CheckpointStore> {
    return this.checkpoints;
  }
}

export function runningTurn(
  output = "Turn completed.",
  sessionId = "session-fake",
): AgentTurnResult {
  return {
    sessionId,
    turnId: "turn-fake",
    status: "running",
    output,
    steps: 1,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
  };
}

export function erroredTurn(
  kind: "cancelled" | "failed",
): AgentTurnResult {
  return {
    sessionId: "session-fake",
    turnId: "turn-fake",
    status: "running",
    output: "",
    steps: 1,
    usage: {
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
    },
    error: kind === "cancelled"
      ? {
          code: "turn_cancelled",
          message: "user cancelled the active turn",
          retryable: true,
        }
      : {
          code: "MODEL_ERROR",
          message: "provider unavailable",
          retryable: true,
        },
  };
}

export function completedRun(): AgentRunResult {
  return {
    sessionId: "session-fake",
    status: "completed",
    summary: "Task completed.",
    steps: 1,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
  };
}
