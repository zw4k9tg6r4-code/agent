import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type {
  PermissionDecision,
  PermissionRequest,
} from "@agent/contracts";
import { describe, expect, it } from "vitest";

import {
  createInterruptHandle,
  NodeCliIO,
  TerminalPermissionConfirmer,
  type CliIO,
  type SignalSource,
} from "../src/index.js";

class FakeIO implements CliIO {
  readonly interactive = true;
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly #answers: (string | null)[];

  constructor(answers: readonly (string | null)[]) {
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

const request: PermissionRequest = {
  mode: "workspace",
  tool: {
    name: "shell_execute",
    description: "Run a local command",
    inputSchema: { type: "object" },
    riskLevel: "execute",
    outputLimitBytes: 4_096,
    supportsCancellation: true,
  },
  call: {
    id: "call-1",
    name: "shell_execute",
    arguments: {
      program: "node",
      args: ["script.js"],
    },
  },
  workspaceRoot: "C:\\workspace",
};

const ask: PermissionDecision = {
  outcome: "ask",
  reason: "local program execution requires confirmation",
  ruleId: "workspace.execute.ask",
  resolvedArguments: {
    program: "C:\\Program Files\\nodejs\\node.exe",
    args: ["script.js"],
    cwd: "C:\\workspace",
    timeoutMs: 60_000,
  },
};

describe("TerminalPermissionConfirmer", () => {
  it("shows the exact resolved operation and accepts explicit yes", async () => {
    const io = new FakeIO(["yes"]);
    const approved = await new TerminalPermissionConfirmer(io).confirm(
      request,
      ask,
      new AbortController().signal,
    );

    expect(approved).toBe(true);
    const output = io.output.join("");
    expect(output).toContain("shell_execute");
    expect(output).toContain("workspace.execute.ask");
    expect(output).toContain(
      '"program": "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
    );
    expect(output).toContain('"cwd": "C:\\\\workspace"');
  });

  it.each([[""], ["n"], [null]] as const)(
    "denies input %j",
    async (answer) => {
      const confirmer = new TerminalPermissionConfirmer(new FakeIO([answer]));
      await expect(
        confirmer.confirm(request, ask, new AbortController().signal),
      ).resolves.toBe(false);
    },
  );

  it("denies immediately when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const io = new FakeIO(["yes"]);
    await expect(
      new TerminalPermissionConfirmer(io).confirm(
        request,
        ask,
        controller.signal,
      ),
    ).resolves.toBe(false);
    expect(io.output).toEqual([]);
  });

  it("denies on a real input-stream EOF instead of leaving a pending Promise", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();
    const io = new NodeCliIO(input, output, output, true);

    await expect(
      new TerminalPermissionConfirmer(io).confirm(
        request,
        ask,
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
  });
});

describe("NodeCliIO", () => {
  it("completes readLine with null when a real stream closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new NodeCliIO(input, output, output, false);
    const reading = io.readLine("agent> ", new AbortController().signal);
    input.end();

    await expect(reading).resolves.toBeNull();
  });
});

describe("SIGINT", () => {
  it("aborts once and removes the listener on dispose", () => {
    const emitter = new EventEmitter();
    const source: SignalSource = {
      once(event, listener) {
        emitter.once(event, listener);
        return this;
      },
      removeListener(event, listener) {
        emitter.removeListener(event, listener);
        return this;
      },
    };
    const handle = createInterruptHandle(source);

    emitter.emit("SIGINT");

    expect(handle.signal.aborted).toBe(true);
    handle.dispose();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });
});
