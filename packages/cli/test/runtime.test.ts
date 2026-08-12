import type {
  AgentDependencies,
  AgentRunner,
  CheckpointRestoreResult,
  CheckpointStore,
  ModelEvent,
  ModelProvider,
  ModelProviderOptions,
  ModelRequest,
  SessionEvent,
  PermissionDecision,
  PermissionEvaluator,
  PermissionRequest,
} from "@agent/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  ProductionRuntimeFactory,
  type RuntimeModules,
} from "../src/index.js";

describe("ProductionRuntimeFactory", () => {
  it("maps config and injects one checkpoint store into Agent dependencies", async () => {
    const captured: {
      providerConfig?: unknown;
      dependencies?: AgentDependencies;
      options?: unknown;
    } = {};

    class FakeProvider implements ModelProvider {
      readonly id = "fake-provider";

      constructor(config: unknown) {
        captured.providerConfig = config;
      }

      async *stream(
        _request: ModelRequest,
        _options: ModelProviderOptions,
      ): AsyncIterable<ModelEvent> {
        yield { type: "completed", stopReason: "end_turn" };
      }
    }

    class FakePermissions implements PermissionEvaluator {
      async evaluate(
        _request: PermissionRequest,
      ): Promise<PermissionDecision> {
        return {
          outcome: "deny",
          reason: "not used",
          ruleId: "test.deny",
        };
      }
    }

    class FakeCheckpoints implements CheckpointStore {
      async capture(): Promise<void> {}

      async restore(): Promise<CheckpointRestoreResult> {
        return { restoredPaths: [], removedPaths: [] };
      }
    }

    const runner: AgentRunner = {
      async runTurn(options) {
        return {
          sessionId:
            options.kind === "new"
              ? (options.sessionId ?? "session-new")
              : options.sessionId,
          turnId: "turn-1",
          status: "running",
          output: "done",
          steps: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        };
      },
      async finishSession(options) {
        return {
          sessionId: options.sessionId,
          status: "completed",
          summary: "done",
          steps: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        };
      },
    };

    const modules: RuntimeModules = {
      OpenAICompatibleProvider: FakeProvider,
      DefaultPermissionEvaluator: FakePermissions,
      FileCheckpointStore: FakeCheckpoints,
      createBuiltinTools: () => [],
      createAgentRunner(dependencies, options) {
        captured.dependencies = dependencies;
        captured.options = options;
        return runner;
      },
    };
    const factory = new ProductionRuntimeFactory(modules);
    const sessions = {
      append: async () => {
        throw new Error("not used");
      },
      get: async () => undefined,
      read: async function* () {},
      list: async () => [],
    };
    const confirmations = {
      confirm: async () => false,
    };

    const bundle = await factory.create({
      config: { ...DEFAULT_CONFIG, skills: ["review"] },
      sessions,
      confirmations,
      environment: { OPENAI_API_KEY: "sk-test-runtime-key" },
    });

    expect(captured.providerConfig).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKeyEnvVar: "OPENAI_API_KEY",
      apiKey: "sk-test-runtime-key",
      requestTimeoutMs: 60_000,
      maxRetries: 2,
    });
    expect(captured.options).toEqual({ enabledSkills: ["review"] });
    expect(bundle.runner).toBe(runner);
    expect(captured.dependencies?.provider.id).toBe("fake-provider");
    expect(captured.dependencies?.tools).toEqual([]);
    expect(captured.dependencies?.sessions).toBe(sessions);
    expect(captured.dependencies?.confirmations).toBe(confirmations);
    expect(captured.dependencies?.checkpoints).toBe(bundle.checkpoints);
    expect(await factory.createCheckpointStore()).toBeInstanceOf(
      FakeCheckpoints,
    );
  });
});
