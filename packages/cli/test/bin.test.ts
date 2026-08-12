import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunner } from "@agent/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeCli,
  EXIT_CODES,
  initializeWorkspace,
  type SignalSource,
} from "../src/index.js";
import {
  FakeIO,
  FakeRuntimeFactory,
  FakeRunner,
  erroredTurn,
} from "./fixtures/fakes.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-cli-bin-"));
  roots.push(value);
  return value;
}

function signals(emitter = new EventEmitter()): {
  readonly emitter: EventEmitter;
  readonly source: SignalSource;
} {
  return {
    emitter,
    source: {
      once(event, listener) {
        emitter.once(event, listener);
        return this;
      },
      removeListener(event, listener) {
        emitter.removeListener(event, listener);
        return this;
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (value) => {
      await rm(value, { force: true, recursive: true });
    }),
  );
});

describe("executeCli", () => {
  it("runs help without configuration", async () => {
    const workspaceRoot = await root();
    const io = new FakeIO();

    const code = await executeCli(["--help"], {
      workspaceRoot,
      environment: {},
      io,
      runtimeFactory: new FakeRuntimeFactory(new FakeRunner([])),
      signalSource: signals().source,
      version: "0.0.0",
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(io.output.join("")).toContain("agent resume <session-id>");
  });

  it("maps usage/config errors to 2 without exposing environment values", async () => {
    const workspaceRoot = await root();
    await initializeWorkspace(workspaceRoot);
    const io = new FakeIO();

    const code = await executeCli(["run", "inspect"], {
      workspaceRoot,
      environment: { OTHER_KEY: "sk-never-print" },
      io,
      runtimeFactory: new FakeRuntimeFactory(new FakeRunner([])),
      signalSource: signals().source,
      version: "0.0.0",
    });

    expect(code).toBe(EXIT_CODES.usageOrConfig);
    expect(io.errors.join("")).toContain(
      "set environment variable OPENAI_API_KEY",
    );
    expect(io.errors.join("")).not.toContain("sk-never-print");
  });

  it("maps Ctrl+C during a turn to 130", async () => {
    const workspaceRoot = await root();
    await initializeWorkspace(workspaceRoot);
    const { JsonlSessionEventStore } = await import("../src/index.js");
    const sessions = new JsonlSessionEventStore(join(workspaceRoot, ".agent", "sessions"));
    await sessions.append("session-fake", {
      type: "session_started",
      task: "wait",
      workspaceRoot,
      permissionMode: "workspace",
    });
    const io = new FakeIO();
    const signal = signals();
    const runner: AgentRunner = {
      async runTurn(options) {
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        return erroredTurn("cancelled");
      },
      async finishSession() {
        throw new Error("cancelled turn must not be finished");
      },
    };

    const running = executeCli(["run", "wait"], {
      workspaceRoot,
      environment: { OPENAI_API_KEY: "sk-fake-only" },
      io,
      runtimeFactory: new FakeRuntimeFactory(runner),
      signalSource: signal.source,
      version: "0.0.0",
    });
    signal.emitter.emit("SIGINT");

    await expect(running).resolves.toBe(EXIT_CODES.cancelled);
    expect(io.errors.join("")).toContain("Task cancelled.");
  });

  it("maps unexpected runtime failures to 1", async () => {
    const workspaceRoot = await root();
    await initializeWorkspace(workspaceRoot);
    const io = new FakeIO();
    const runtimeFactory = new FakeRuntimeFactory(new FakeRunner([]));
    runtimeFactory.create = async () => {
      throw new Error("composition failed");
    };

    const code = await executeCli(["run", "inspect"], {
      workspaceRoot,
      environment: { OPENAI_API_KEY: "sk-fake-only" },
      io,
      runtimeFactory,
      signalSource: signals().source,
      version: "0.0.0",
    });

    expect(code).toBe(EXIT_CODES.runtimeFailure);
    expect(io.errors).toEqual(["Unexpected error: composition failed\n"]);
  });
});
