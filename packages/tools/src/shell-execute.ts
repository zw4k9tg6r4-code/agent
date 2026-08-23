import type {
  JsonObject,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import path from "node:path";
import {
  executeProcess,
  type ShellProcessResult,
} from "./shell-process.js";
import {
  assertResolvedExecutable,
  ExecutablePathError,
} from "./executable-path.js";
import {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
import { truncateUtf8 } from "./output.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const SHELL_EXECUTE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
export const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4_096;
const FORBIDDEN_ARGUMENT_SYNTAX =
  /(?:&&|\|\||[|;<>`\r\n]|\$\(|(?:^|\s)&(?:\s|$))/u;
const FORBIDDEN_PROGRAMS = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "cscript",
  "cscript.exe",
  "fish",
  "mshta",
  "mshta.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "wscript",
  "wscript.exe",
  "zsh",
]);

/**
 * Matches every form of the Node eval/print flags, including the inline
 * `--eval=code` / `--print=code` spellings, so no eval variant slips past
 * the direct-process boundary checks.
 */
export function isNodeEvalArgument(argument: string): boolean {
  return (
    argument === "-e" ||
    argument === "--eval" ||
    argument === "-p" ||
    argument === "--print" ||
    argument.startsWith("--eval=") ||
    argument.startsWith("--print=") ||
    argument.startsWith("-e=") ||
    argument.startsWith("-p=")
  );
}

interface ShellInput {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

function parseShellInput(input: JsonObject): ShellInput {
  if ("command" in input) {
    throw new TypeError(
      "opaque command strings are not accepted; use program and args",
    );
  }
  const program = input["program"];
  const argsInput = input["args"] ?? [];
  const cwd = input["cwd"] ?? ".";
  const timeoutMs = input["timeoutMs"] ?? DEFAULT_TIMEOUT_MS;

  if (
    typeof program !== "string" ||
    program.length === 0 ||
    !path.isAbsolute(program)
  ) {
    throw new TypeError("program must be a canonical absolute path");
  }
  if (!Array.isArray(argsInput) || argsInput.length > MAX_ARGUMENTS) {
    throw new TypeError(`args must contain at most ${MAX_ARGUMENTS} strings`);
  }
  const args = argsInput.map((value, index) => {
    if (
      typeof value !== "string" ||
      value.length > MAX_ARGUMENT_LENGTH ||
      value.includes("\0") ||
      FORBIDDEN_ARGUMENT_SYNTAX.test(value)
    ) {
      throw new TypeError(
        `args[${index}] contains invalid, compound, or redirected syntax`,
      );
    }
    return value;
  });
  const basename = path.basename(program).toLowerCase();
  if (
    FORBIDDEN_PROGRAMS.has(basename) ||
    [".bat", ".cmd", ".ps1", ".sh"].includes(
      path.extname(basename),
    ) ||
    ((basename === "node" || basename === "node.exe") &&
      args.some((argument) => isNodeEvalArgument(argument)))
  ) {
    throw new TypeError(
      "shell interpreters, script wrappers, and eval flags are not accepted",
    );
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("cwd must be a non-empty string");
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}`,
    );
  }
  return {
    program,
    args,
    cwd,
    timeoutMs,
  };
}

function renderProcessOutput(result: ShellProcessResult): string {
  const sections: string[] = [];
  if (result.stdout.length > 0) {
    sections.push(result.stdout);
  }
  if (result.stderr.length > 0) {
    sections.push(`[stderr]\n${result.stderr}`);
  }
  return sections.join("\n");
}

export async function runShellExecute(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "process was cancelled", {
        metadata: {
          exitCode: null,
          timedOut: false,
          cancelled: true,
        },
      });
    }
    const parsed = parseShellInput(call.arguments);
    const program = await assertResolvedExecutable(parsed.program);
    const cwd = await resolveWorkspacePath(
      context.workspaceRoot,
      parsed.cwd,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(cwd.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "protected directories cannot be process cwd",
      );
    }
    const result = await executeProcess({
      program,
      args: parsed.args,
      cwd: cwd.absolutePath,
      timeoutMs: parsed.timeoutMs,
      signal: context.signal,
    });
    const bounded = truncateUtf8(
      renderProcessOutput(result),
      SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
    );
    const metadata: JsonObject = {
      program,
      args: parsed.args,
      cwd: cwd.relativePath,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      truncated: result.truncated || bounded.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      terminationFailed: result.terminationFailed,
    };

    if (result.terminationFailed) {
      return toolFailure(
        call,
        "PROCESS_TERMINATION_FAILED",
        "process tree did not terminate within the bounded kill deadline",
        {
          output: bounded.output,
          metadata,
        },
      );
    }
    if (result.cancelled) {
      return toolFailure(call, "CANCELLED", "process was cancelled", {
        output: bounded.output,
        metadata,
      });
    }
    if (result.timedOut) {
      return toolFailure(
        call,
        "PROCESS_TIMEOUT",
        `process exceeded ${parsed.timeoutMs} ms`,
        {
          output: bounded.output,
          metadata,
        },
      );
    }
    if (result.spawnError !== undefined) {
      return toolFailure(call, "PROCESS_SPAWN_FAILED", result.spawnError, {
        output: bounded.output,
        metadata,
      });
    }
    if (result.exitCode !== 0) {
      return toolFailure(
        call,
        "PROCESS_FAILED",
        `process exited with code ${String(result.exitCode)}`,
        {
          output: bounded.output,
          metadata,
        },
      );
    }
    return toolSuccess(call, bounded.output, metadata);
  } catch (error: unknown) {
    if (error instanceof ExecutablePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (error instanceof WorkspacePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown process failure";
    return toolFailure(call, "SHELL_EXECUTE_FAILED", message);
  }
}
