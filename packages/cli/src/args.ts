import { CliError, EXIT_CODES } from "./errors.js";

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "init" }
  | { readonly kind: "interactive" }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "run"; readonly task: string }
  | { readonly kind: "sessions" }
  | { readonly kind: "undo"; readonly sessionId: string }
  | { readonly kind: "version" };

function exactlyOneSessionId(
  command: "resume" | "undo",
  values: readonly string[],
): string {
  if (values.length !== 1 || values[0]?.trim().length === 0) {
    throw new CliError(
      "USAGE_ERROR",
      EXIT_CODES.usageOrConfig,
      `agent ${command} requires exactly one session id`,
    );
  }
  return values[0] as string;
}

export function parseArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined) return { kind: "interactive" };
  if (command === "--help" || command === "-h") return { kind: "help" };
  if (command === "--version" || command === "-v") return { kind: "version" };
  if (command === "init" && rest.length === 0) return { kind: "init" };
  if (command === "sessions" && rest.length === 0) return { kind: "sessions" };

  if (command === "run") {
    const task = rest.join(" ").trim();
    if (task.length === 0) {
      throw new CliError(
        "USAGE_ERROR",
        EXIT_CODES.usageOrConfig,
        "agent run requires a non-empty task",
      );
    }
    return { kind: "run", task };
  }

  if (command === "resume") {
    return { kind: "resume", sessionId: exactlyOneSessionId(command, rest) };
  }
  if (command === "undo") {
    return { kind: "undo", sessionId: exactlyOneSessionId(command, rest) };
  }

  throw new CliError(
    "USAGE_ERROR",
    EXIT_CODES.usageOrConfig,
    `unknown command: ${command}`,
  );
}

export function formatUsage(): string {
  return [
    "Usage:",
    "  agent init",
    "  agent",
    '  agent run "<task>"',
    "  agent sessions",
    "  agent resume <session-id>",
    "  agent undo <session-id>",
    "  agent --help",
    "  agent --version",
  ].join("\n");
}
