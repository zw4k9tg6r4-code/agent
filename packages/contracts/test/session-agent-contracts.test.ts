import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isTerminalSessionState,
  type AgentDependencies,
  type AgentRunner,
  type AgentRunResult,
  type AgentTurnOptions,
  type AgentTurnResult,
  type SessionEvent,
  type SessionEventData,
  type SessionEventSink,
  type SessionEventStore,
  type SessionListItem,
  type TerminalSessionState,
} from "../src/index.js";

describe("session and Agent contracts", () => {
  it("distinguishes running from terminal session states", () => {
    expect(isTerminalSessionState("running")).toBe(false);
    expect(isTerminalSessionState("completed")).toBe(true);
    expect(isTerminalSessionState("failed")).toBe(true);
    expect(isTerminalSessionState("cancelled")).toBe(true);
  });

  it("uses discriminated append-only events", () => {
    const data: SessionEventData = {
      type: "session_cancelled",
      reason: "user_cancelled",
    };
    const event: SessionEvent = {
      ...data,
      eventId: "event-3",
      sessionId: "session-1",
      sequence: 3,
      at: "2026-07-20T08:00:00.000Z",
    };

    expect(event.type).toBe("session_cancelled");
    expect(event.sequence).toBe(3);
  });

  it("defines asynchronous dependencies and final results", () => {
    expectTypeOf<SessionEventSink["append"]>().returns.toEqualTypeOf<
      Promise<SessionEvent>
    >();
    expectTypeOf<SessionEventStore["list"]>().returns.toEqualTypeOf<
      Promise<readonly SessionListItem[]>
    >();
    expectTypeOf<AgentDependencies["sessions"]>().toMatchTypeOf<
      SessionEventStore
    >();
    expectTypeOf<AgentRunner["runTurn"]>().returns.toEqualTypeOf<
      Promise<AgentTurnResult>
    >();
    expectTypeOf<AgentRunResult["steps"]>().toEqualTypeOf<number>();
    expectTypeOf<AgentRunResult["status"]>().toEqualTypeOf<TerminalSessionState>();
  });

  it("separates a continued turn from session finalization", () => {
    const options: AgentTurnOptions = {
      kind: "continue",
      sessionId: "session-1",
      message: "continue",
      limits: {
        maxSteps: 30,
        maxContextTokens: 64_000,
        maxOutputTokens: 8_000,
        timeoutMs: 300_000,
      },
      signal: new AbortController().signal,
    };

    expect(options.kind).toBe("continue");
    expectTypeOf<AgentRunner["finishSession"]>().returns.toEqualTypeOf<
      Promise<AgentRunResult>
    >();
  });
});
