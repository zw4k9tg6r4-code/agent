import type {
  AgentRunResult,
  AgentTurnResult,
  CheckpointRestoreResult,
} from "@agent/contracts";

import { EXIT_CODES, type ExitCode } from "./errors.js";
import type { CliIO } from "./io.js";
import type { SessionDetails } from "./session-store.js";

export function formatSession(details: SessionDetails): string {
  const cost = details.item.usage.estimatedCostUsd === undefined
    ? "cost unknown"
    : `$${details.item.usage.estimatedCostUsd.toFixed(6)}`;
  return [
    details.item.sessionId,
    details.item.state,
    details.item.updatedAt,
    `${details.durationMs} ms`,
    `${details.item.usage.totalTokens} tokens`,
    cost,
    `${details.modelRequests} model requests`,
    `${details.toolCalls} tool calls`,
    details.item.task,
  ].join("\t");
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function reportTurn(
  result: AgentTurnResult,
  io: CliIO,
): ExitCode | null {
  if (result.error !== undefined) {
    const message = stripAnsi(result.error.message);
    if (result.error.code === "turn_cancelled") {
      io.writeError(
        `Task cancelled.\nSession: ${result.sessionId}\n`,
      );
      return EXIT_CODES.cancelled;
    }
    io.writeError(
      `${message}\nSession: ${result.sessionId}\n`,
    );
    return EXIT_CODES.runtimeFailure;
  }
  if (result.status === "running") {
    io.write(`${result.output}\n`);
    return null;
  }
  if (result.status === "cancelled") {
    io.writeError(`Task cancelled.\nSession: ${result.sessionId}\n`);
    return EXIT_CODES.cancelled;
  }
  if (result.status === "failed") {
    io.writeError(
      `${result.output}\nSession: ${result.sessionId}\n`,
    );
    return EXIT_CODES.runtimeFailure;
  }
  io.write(`${result.output}\nSession: ${result.sessionId}\n`);
  return EXIT_CODES.success;
}

export function reportFinished(
  result: AgentRunResult,
  io: CliIO,
): ExitCode {
  if (result.status === "completed") {
    io.write(`${result.summary}\nSession: ${result.sessionId}\n`);
    return EXIT_CODES.success;
  }
  if (result.status === "cancelled") {
    io.writeError(`Task cancelled.\nSession: ${result.sessionId}\n`);
    return EXIT_CODES.cancelled;
  }
  io.writeError(
    `${result.error?.message ?? result.summary}\nSession: ${result.sessionId}\n`,
  );
  return EXIT_CODES.runtimeFailure;
}

export function reportRestore(
  result: CheckpointRestoreResult,
  io: CliIO,
): void {
  for (const path of result.restoredPaths) io.write(`Restored: ${path}\n`);
  for (const path of result.removedPaths) io.write(`Removed: ${path}\n`);
  if (result.restoredPaths.length === 0 && result.removedPaths.length === 0) {
    io.write("No checkpoint changes to restore.\n");
  }
}
