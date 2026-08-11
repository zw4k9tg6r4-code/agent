import { describe, expect, it } from "vitest";

import { dispatchToolCall } from "../src/tool-dispatcher.js";
import {
  FixedConfirmer,
  FixedPermissionEvaluator,
  makeTool,
  MemorySessionStore,
  NoopCheckpointStore,
} from "./helpers.js";

describe("tool result redaction", () => {
  it("removes common credential forms before events and model feedback", async () => {
    const store = new MemorySessionStore();
    const result = await dispatchToolCall({
      state: {
        call: {
          id: "call-1",
          name: "shell_execute",
          arguments: { command: "example" },
        },
        step: 1,
        requestRecorded: false,
        decision: undefined,
        confirmation: undefined,
        executionStarted: false,
      },
      tools: [
        makeTool(
          "shell_execute",
          async (call) => ({
            toolCallId: call.id,
            ok: true,
            output: [
              "Authorization: Bearer sk-test-secret-123456",
              "API_KEY=plain-secret-value",
            ].join("\n"),
            metadata: {
              nested: {
                token: "sk-nested-secret-123456",
              },
            },
          }),
          "execute",
        ),
      ],
      permissionMode: "workspace",
      workspaceRoot: "C:/workspace",
      sessionId: "session-1",
      turnId: "turn-1",
      signal: new AbortController().signal,
      permissions: new FixedPermissionEvaluator([
        {
          outcome: "allow",
          reason: "test",
          ruleId: "test.allow",
          resolvedArguments: { command: "example" },
        },
      ]),
      confirmations: new FixedConfirmer([]),
      sessions: store,
      checkpoints: new NoopCheckpointStore(),
    });

    const serializedResult = JSON.stringify(result);
    const serializedEvents = JSON.stringify(store.events("session-1"));
    for (const serialized of [serializedResult, serializedEvents]) {
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("sk-test-secret-123456");
      expect(serialized).not.toContain("plain-secret-value");
      expect(serialized).not.toContain("sk-nested-secret-123456");
    }
  });
});
