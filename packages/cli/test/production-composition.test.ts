import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelEvent,
  ModelProvider,
  ModelProviderOptions,
  ModelRequest,
  SessionEvent,
} from "@agent/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  DEFAULT_RUNTIME_MODULES,
  EXIT_CODES,
  initializeWorkspace,
  JsonlSessionEventStore,
  ProductionRuntimeFactory,
  runNonInteractiveCommand,
} from "../src/index.js";
import { FakeIO } from "./fixtures/fakes.js";

class SuccessfulFakeProvider implements ModelProvider {
  readonly id = "successful-fake";

  constructor(_config: unknown) {}

  async *stream(
    _request: ModelRequest,
    _options: ModelProviderOptions,
  ): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", delta: "real core completed" };
    yield {
      type: "usage",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    };
    yield { type: "completed", stopReason: "end_turn" };
  }
}

class FailingFakeProvider implements ModelProvider {
  readonly id = "failing-fake";

  constructor(_config: unknown) {}

  async *stream(
    _request: ModelRequest,
    _options: ModelProviderOptions,
  ): AsyncIterable<ModelEvent> {
    throw new Error("deterministic provider failure");
  }
}

describe("real production composition", () => {
  it("constructs all integrated packages without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-cli-composition-"));
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "fake-composition-key";
    try {
      const factory = new ProductionRuntimeFactory();
      const bundle = await factory.create({
        config: DEFAULT_CONFIG,
        sessions: new JsonlSessionEventStore(
          join(root, ".agent", "sessions"),
        ),
        confirmations: {
          confirm: async () => false,
        },
      });

      expect(typeof bundle.runner.runTurn).toBe("function");
      expect(typeof bundle.runner.finishSession).toBe("function");
      expect(typeof bundle.checkpoints.capture).toBe("function");
      expect(typeof bundle.checkpoints.restore).toBe("function");
      expect(await factory.createCheckpointStore()).toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env["OPENAI_API_KEY"];
      } else {
        process.env["OPENAI_API_KEY"] = previous;
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("runs and finalizes the real Core through CLI with a fake Provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-cli-real-core-"));
    try {
      await initializeWorkspace(root);
      const sessions = new JsonlSessionEventStore(
        join(root, ".agent", "sessions"),
      );
      const factory = new ProductionRuntimeFactory({
        ...DEFAULT_RUNTIME_MODULES,
        OpenAICompatibleProvider: SuccessfulFakeProvider,
      });
      const io = new FakeIO();

      const code = await runNonInteractiveCommand(
        { kind: "run", task: "exercise the real core" },
        {
          workspaceRoot: root,
          environment: { OPENAI_API_KEY: "fake-lifecycle-key" },
          io,
          sessions,
          runtimeFactory: factory,
          signal: new AbortController().signal,
          version: "0.0.0",
        },
      );

      expect(code).toBe(EXIT_CODES.success);
      const [item] = await sessions.list();
      expect(item).toMatchObject({
        state: "completed",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      });
      expect(io.output.join("")).toContain("real core completed");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not finalize a real Core running + error result", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-cli-real-error-"));
    try {
      await initializeWorkspace(root);
      const sessions = new JsonlSessionEventStore(
        join(root, ".agent", "sessions"),
      );
      const factory = new ProductionRuntimeFactory({
        ...DEFAULT_RUNTIME_MODULES,
        OpenAICompatibleProvider: FailingFakeProvider,
      });
      const io = new FakeIO();

      const code = await runNonInteractiveCommand(
        { kind: "run", task: "fail through the real core" },
        {
          workspaceRoot: root,
          environment: { OPENAI_API_KEY: "fake-lifecycle-key" },
          io,
          sessions,
          runtimeFactory: factory,
          signal: new AbortController().signal,
          version: "0.0.0",
        },
      );

      expect(code).toBe(EXIT_CODES.runtimeFailure);
      const [item] = await sessions.list();
      expect(item?.state).toBe("failed");
      const events: SessionEvent[] = [];
      if (item !== undefined) {
        for await (const event of sessions.read(item.sessionId)) {
          events.push(event);
        }
      }
      expect(events.at(-1)?.type).toBe("session_failed");
      expect(events.some((event) => event.type === "session_completed")).toBe(
        false,
      );
      expect(io.errors.join("")).toContain("deterministic provider failure");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
