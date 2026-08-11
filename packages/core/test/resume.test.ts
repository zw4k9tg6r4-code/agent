import type { ToolCall } from "@agent/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createAgentRunner,
  type LoadedProjectContext,
  type ProjectContextLoader,
} from "../src/index.js";
import {
  FixedConfirmer,
  FixedPermissionEvaluator,
  makeDependencies,
  makeTool,
  MemorySessionStore,
  ScriptedProvider,
} from "./helpers.js";

class StaticContextLoader implements ProjectContextLoader {
  async load(): Promise<LoadedProjectContext> {
    return {
      systemPrompt: "SAFETY",
      sources: [],
      compacted: false,
      beforeTokens: 2,
      afterTokens: 2,
    };
  }
}

const limits = {
  maxSteps: 3,
  maxContextTokens: 1_000,
  maxOutputTokens: 100,
  timeoutMs: 1_000,
} as const;

async function seedInterruptedSession(
  store: MemorySessionStore,
): Promise<void> {
  await store.append("session-1", {
    type: "session_started",
    task: "inspect",
    workspaceRoot: "C:/workspace",
    permissionMode: "workspace",
  });
  await store.append("session-1", {
    type: "turn_started",
    turnId: "original-turn",
    kind: "new",
  });
  await store.append("session-1", {
    type: "user_message",
    turnId: "original-turn",
    content: "inspect",
  });
}

describe("resume turns", () => {
  it("discards partial model output and reruns from the last complete response", async () => {
    const store = new MemorySessionStore();
    await seedInterruptedSession(store);
    await store.append("session-1", {
      type: "model_request_started",
      turnId: "original-turn",
      step: 1,
    });
    await store.append("session-1", {
      type: "model_output",
      turnId: "original-turn",
      step: 1,
      text: "partial",
    });
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "complete" },
        {
          type: "usage",
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);
    const runner = createAgentRunner(
      makeDependencies({ provider, sessions: store }),
      {},
      {
        contextLoader: new StaticContextLoader(),
        createId: () => "resume-turn",
      },
    );

    const result = await runner.runTurn({
      kind: "resume",
      sessionId: "session-1",
      limits,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "running",
      output: "complete",
      steps: 2,
    });
    expect(provider.requests[0]?.messages).toContainEqual({
      role: "user",
      content: "inspect",
    });
    expect(provider.requests[0]?.messages).not.toContainEqual({
      role: "assistant",
      content: "partial",
    });
  });

  it("resumes every pre-execution crash boundary from its persisted phase", async () => {
    const call = {
      id: "call-1",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    const evaluatedAllow = {
      outcome: "allow",
      reason: "evaluated",
      ruleId: "workspace.read",
      resolvedArguments: { path: "C:/workspace/EVALUATED.md" },
    } as const;
    const persistedAllow = {
      outcome: "allow",
      reason: "persisted",
      ruleId: "workspace.read",
      resolvedArguments: { path: "C:/workspace/PERSISTED.md" },
    } as const;
    const persistedAsk = {
      outcome: "ask",
      reason: "persisted approval",
      ruleId: "workspace.confirm",
      resolvedArguments: { path: "C:/workspace/PERSISTED.md" },
    } as const;
    const persistedDeny = {
      outcome: "deny",
      reason: "persisted denial",
      ruleId: "workspace.deny",
    } as const;
    const requested: any = {
      type: "tool_requested",
      turnId: "original-turn",
      step: 1,
      call,
    };
    const decided = (
      decision: any,
    ): any => ({
      type: "permission_decided",
      turnId: "original-turn",
      step: 1,
      toolCallId: call.id,
      decision,
    });
    const confirmed = (approved: boolean): any => ({
      type: "permission_confirmed",
      turnId: "original-turn",
      step: 1,
      toolCallId: call.id,
      approved,
    });
    const failedAttempt: any = {
      type: "turn_failed",
      turnId: "original-turn",
      code: "confirmation_transport_failed",
      message: "confirmation transport failed",
    };
    const scenarios = [
      {
        name: "model response before tool_requested",
        events: [],
        decisions: [evaluatedAllow],
        approvals: [],
        executes: true,
        executedPath: "C:/workspace/EVALUATED.md",
        addedToolEvents: [
          "tool_requested",
          "permission_decided",
          "tool_execution_started",
          "tool_completed",
        ],
      },
      {
        name: "tool_requested before permission_decided, after failed attempt",
        events: [requested, failedAttempt],
        decisions: [evaluatedAllow],
        approvals: [],
        executes: true,
        executedPath: "C:/workspace/EVALUATED.md",
        addedToolEvents: [
          "permission_decided",
          "tool_execution_started",
          "tool_completed",
        ],
      },
      {
        name: "persisted allow before execution_started",
        events: [requested, decided(persistedAllow)],
        decisions: [],
        approvals: [],
        executes: true,
        executedPath: "C:/workspace/PERSISTED.md",
        addedToolEvents: [
          "tool_execution_started",
          "tool_completed",
        ],
      },
      {
        name: "persisted ask before permission_confirmed",
        events: [requested, decided(persistedAsk)],
        decisions: [],
        approvals: [true],
        executes: true,
        executedPath: "C:/workspace/PERSISTED.md",
        addedToolEvents: [
          "permission_confirmed",
          "tool_execution_started",
          "tool_completed",
        ],
      },
      {
        name: "persisted approved ask before execution_started",
        events: [
          requested,
          decided(persistedAsk),
          confirmed(true),
        ],
        decisions: [],
        approvals: [],
        executes: true,
        executedPath: "C:/workspace/PERSISTED.md",
        addedToolEvents: [
          "tool_execution_started",
          "tool_completed",
        ],
      },
      {
        name: "persisted deny before terminal tool_failed",
        events: [requested, decided(persistedDeny)],
        decisions: [],
        approvals: [],
        executes: false,
        executedPath: undefined,
        addedToolEvents: ["tool_failed"],
      },
      {
        name: "persisted rejected ask before terminal tool_failed",
        events: [
          requested,
          decided(persistedAsk),
          confirmed(false),
        ],
        decisions: [],
        approvals: [],
        executes: false,
        executedPath: undefined,
        addedToolEvents: ["tool_failed"],
      },
    ];

    for (const scenario of scenarios) {
      const store = new MemorySessionStore();
      await seedInterruptedSession(store);
      await store.append("session-1", {
        type: "model_request_started",
        turnId: "original-turn",
        step: 1,
      });
      await store.append("session-1", {
        type: "model_response_completed",
        turnId: "original-turn",
        step: 1,
        message: { role: "assistant", content: "", toolCalls: [call] },
        stopReason: "tool_use",
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      });
      for (const event of scenario.events) {
        await store.append("session-1", event);
      }
      const eventCountBeforeResume = store.events("session-1").length;
      const execute = vi.fn(async (resolvedCall: ToolCall) => ({
        toolCallId: resolvedCall.id,
        ok: true as const,
        output: "contents",
      }));
      const permissions = new FixedPermissionEvaluator(
        scenario.decisions,
      );
      const confirmations = new FixedConfirmer(
        scenario.approvals,
      );
      const provider = new ScriptedProvider([
        [
          { type: "text_delta", delta: "done" },
          {
            type: "usage",
            usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
          },
          { type: "completed", stopReason: "end_turn" },
        ],
      ]);
      const runner = createAgentRunner(
        makeDependencies({
          provider,
          sessions: store,
          tools: [makeTool("file_read", execute)],
          permissions,
          confirmations,
        }),
        {},
        {
          contextLoader: new StaticContextLoader(),
          createId: () => `resume-${scenario.name}`,
        },
      );

      const result = await runner.runTurn({
        kind: "resume",
        sessionId: "session-1",
        limits,
        signal: new AbortController().signal,
      });

      expect(result, scenario.name).toMatchObject({
        status: "running",
        output: "done",
        steps: 2,
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      });
      expect(
        store.events("session-1")
          .slice(eventCountBeforeResume)
          .map((event) => event.type)
          .filter((type) =>
            [
              "tool_requested",
              "permission_decided",
              "permission_confirmed",
              "tool_execution_started",
              "tool_completed",
              "tool_failed",
            ].includes(type),
          ),
        scenario.name,
      ).toEqual(scenario.addedToolEvents);
      expect(permissions.requests, scenario.name).toHaveLength(
        scenario.decisions.length,
      );
      expect(confirmations.calls, scenario.name).toBe(
        scenario.approvals.length,
      );
      expect(execute, scenario.name).toHaveBeenCalledTimes(
        scenario.executes ? 1 : 0,
      );
      if (scenario.executedPath !== undefined) {
        expect(execute.mock.calls[0]?.[0].arguments["path"]).toBe(
          scenario.executedPath,
        );
      }
    }
  });

  it("blocks continue and finish while a safe pending call remains", async () => {
    const store = new MemorySessionStore();
    await seedInterruptedSession(store);
    const call = {
      id: "call-pending",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "original-turn",
      step: 1,
      message: { role: "assistant", content: "", toolCalls: [call] },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    await store.append("session-1", {
      type: "turn_failed",
      turnId: "original-turn",
      code: "transport_failed",
      message: "transport failed",
    });
    const runner = createAgentRunner(
      makeDependencies({ sessions: store }),
      {},
      {
        contextLoader: new StaticContextLoader(),
        createId: () => "blocked-turn",
      },
    );

    await expect(
      runner.runTurn({
        kind: "continue",
        sessionId: "session-1",
        message: "skip it",
        limits,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "pending_tool_call" });
    await expect(
      runner.finishSession({
        sessionId: "session-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "pending_tool_call" });
  });

  it("continues a requested but not-started tool, preserving usage and call id", async () => {
    const store = new MemorySessionStore();
    await seedInterruptedSession(store);
    const call = {
      id: "call-1",
      name: "file_read",
      arguments: { path: "README.md" },
    } as const;
    await store.append("session-1", {
      type: "model_request_started",
      turnId: "original-turn",
      step: 1,
    });
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "original-turn",
      step: 1,
      message: { role: "assistant", content: "", toolCalls: [call] },
      stopReason: "tool_use",
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    await store.append("session-1", {
      type: "tool_requested",
      turnId: "original-turn",
      step: 1,
      call,
    });
    const execute = vi.fn(async (resolvedCall: ToolCall) => ({
      toolCallId: resolvedCall.id,
      ok: true as const,
      output: "contents",
    }));
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", delta: "done" },
        {
          type: "usage",
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        },
        { type: "completed", stopReason: "end_turn" },
      ],
    ]);
    const runner = createAgentRunner(
      makeDependencies({
        provider,
        sessions: store,
        tools: [makeTool("file_read", execute)],
        permissions: new FixedPermissionEvaluator([
          {
            outcome: "allow",
            reason: "allowed",
            ruleId: "read",
            resolvedArguments: { path: "C:/workspace/README.md" },
          },
        ]),
        confirmations: new FixedConfirmer([]),
      }),
      {},
      {
        contextLoader: new StaticContextLoader(),
        createId: () => "resume-turn",
      },
    );

    const result = await runner.runTurn({
      kind: "resume",
      sessionId: "session-1",
      limits,
      signal: new AbortController().signal,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "running",
      steps: 2,
      usage: { inputTokens: 13, outputTokens: 3, totalTokens: 16 },
    });
  });

  it("never replays a tool whose execution state is unknown", async () => {
    const store = new MemorySessionStore();
    await seedInterruptedSession(store);
    const call = {
      id: "call-unknown",
      name: "file_patch",
      arguments: { path: "README.md" },
    } as const;
    await store.append("session-1", {
      type: "model_response_completed",
      turnId: "original-turn",
      step: 1,
      message: { role: "assistant", content: "", toolCalls: [call] },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    await store.append("session-1", {
      type: "tool_requested",
      turnId: "original-turn",
      step: 1,
      call,
    });
    await store.append("session-1", {
      type: "tool_execution_started",
      turnId: "original-turn",
      step: 1,
      toolCallId: call.id,
    });
    const execute = vi.fn();
    const provider = new ScriptedProvider([]);
    const runner = createAgentRunner(
      makeDependencies({
        provider,
        sessions: store,
        tools: [makeTool("file_patch", execute, "write")],
      }),
      {},
      {
        contextLoader: new StaticContextLoader(),
        createId: () => "resume-turn",
      },
    );

    const result = await runner.runTurn({
      kind: "resume",
      sessionId: "session-1",
      limits,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "running",
      error: { code: "unknown_tool_execution_state" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
    await expect(
      runner.finishSession({
        sessionId: "session-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "unknown_tool_execution_state",
    });
  });
});
