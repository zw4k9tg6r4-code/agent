import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  PermissionConfirmer,
  PermissionEvaluator,
  Tool,
} from "@agent/contracts";
import { createAgentRunner } from "@agent/core";
import { FileCheckpointStore } from "@agent/tools";
import { JsonlSessionEventStore } from "../src/session-store.js";

describe("E2E Cancellation and Resumption Lifecycle with Real JSONL Store", () => {
  it("allows resuming and finishing a session after a turn is cancelled during tool confirmation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-cancel-e2e-"));
    const sessionsDir = join(tempDir, ".agent", "sessions");

    try {
      const store = new JsonlSessionEventStore(sessionsDir);
      const checkpoints = new FileCheckpointStore();

      let streamCount = 0;
      const provider: ModelProvider = {
        id: "mock-provider",
        async *stream(
          _request: ModelRequest,
          _options?: { signal?: AbortSignal },
        ): AsyncIterable<ModelEvent> {
          streamCount += 1;
          if (streamCount === 1) {
            // First turn: requests a tool call
            yield {
              type: "tool_call",
              call: {
                id: "call_e2e_1",
                name: "test_tool",
                arguments: { action: "read" },
              },
            };
            yield { type: "completed", stopReason: "tool_use" };
          } else {
            // Resumed / second turn: completes
            yield { type: "text_delta", delta: "Task completed successfully." };
            yield { type: "completed", stopReason: "end_turn" };
          }
        },
      };

      const tool: Tool = {
        definition: {
          name: "test_tool",
          description: "Test tool",
          inputSchema: { type: "object" },
          riskLevel: "read",
          outputLimitBytes: 10000,
          supportsCancellation: true,
        },
        execute: async () => ({
          toolCallId: "call_e2e_1",
          ok: true,
          output: "Tool executed successfully",
        }),
      };

      const permissions: PermissionEvaluator = {
        evaluate: async () => ({
          outcome: "ask",
          reason: "Requires user confirmation",
          ruleId: "ask_all",
          resolvedArguments: { action: "read" },
        }),
      };

      const abortController = new AbortController();
      let confirmCallCount = 0;
      const confirmations: PermissionConfirmer = {
        confirm: async () => {
          confirmCallCount += 1;
          if (confirmCallCount === 1) {
            // Abort during confirmation on first attempt
            abortController.abort("User pressed Ctrl+C during confirmation");
            throw abortController.signal.reason;
          }
          return true;
        },
      };

      const runner = createAgentRunner({
        provider,
        sessions: store,
        permissions,
        confirmations,
        checkpoints,
        tools: [tool],
      });

      // 1. Run first turn which will be cancelled
      const firstResult = await runner.runTurn({
        kind: "new",
        task: "Execute test task",
        workspaceRoot: tempDir,
        permissionMode: "workspace",
        limits: {
          maxSteps: 10,
          maxContextTokens: 10000,
          maxOutputTokens: 1000,
          timeoutMs: 30000,
        },
        signal: abortController.signal,
      });

      expect(firstResult.status).toBe("running");
      expect(firstResult.error?.code).toBe("turn_cancelled");

      // Verify session exists and is in "running" state (resumable)
      const sessionItem = await store.get(firstResult.sessionId);
      expect(sessionItem).toBeDefined();
      expect(sessionItem?.state).toBe("running");

      // 2. Resume session with a fresh signal and allow confirmation to pass
      const resumeResult = await runner.runTurn({
        kind: "resume",
        sessionId: firstResult.sessionId,
        workspaceRoot: tempDir,
        limits: {
          maxSteps: 10,
          maxContextTokens: 10000,
          maxOutputTokens: 1000,
          timeoutMs: 30000,
        },
        signal: new AbortController().signal,
      });

      expect(resumeResult.status).toBe("running");
      expect(resumeResult.output).toBe("Task completed successfully.");

      // 3. Conclude session cleanly
      const finishResult = await runner.finishSession({
        sessionId: firstResult.sessionId,
        signal: new AbortController().signal,
      });

      expect(finishResult.status).toBe("completed");
      const finalItem = await store.get(firstResult.sessionId);
      expect(finalItem?.state).toBe("completed");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
