import { describe, expect, it } from "vitest";

import {
  CliError,
  EXIT_CODES,
  formatUsage,
  parseArgs,
} from "../src/index.js";

describe("CLI arguments", () => {
  it("uses interactive mode when argv is empty", () => {
    expect(parseArgs([])).toEqual({ kind: "interactive" });
  });

  it.each([
    [["init"], { kind: "init" }],
    [["sessions"], { kind: "sessions" }],
    [["run", "inspect", "this", "repo"], {
      kind: "run",
      task: "inspect this repo",
    }],
    [["resume", "session-123"], {
      kind: "resume",
      sessionId: "session-123",
    }],
    [["undo", "session-123"], {
      kind: "undo",
      sessionId: "session-123",
    }],
    [["--help"], { kind: "help" }],
    [["--version"], { kind: "version" }],
  ] as const)("parses %j", (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([
    [["run"], "agent run requires a non-empty task"],
    [["resume"], "agent resume requires exactly one session id"],
    [["resume", "one", "two"], "agent resume requires exactly one session id"],
    [["undo"], "agent undo requires exactly one session id"],
    [["unknown"], "unknown command: unknown"],
  ] as const)("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrowError(
      new CliError("USAGE_ERROR", EXIT_CODES.usageOrConfig, message),
    );
  });

  it("publishes stable codes and complete usage", () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      runtimeFailure: 1,
      usageOrConfig: 2,
      cancelled: 130,
    });
    expect(formatUsage()).toContain('agent run "<task>"');
    expect(formatUsage()).toContain("agent resume <session-id>");
    expect(formatUsage()).toContain("agent undo <session-id>");
  });
});
