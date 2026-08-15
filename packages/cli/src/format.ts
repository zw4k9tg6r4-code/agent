import type {
  AgentRunResult,
  AgentTurnResult,
  CheckpointRestoreResult,
} from "@agent/contracts";

import { EXIT_CODES, type ExitCode } from "./errors.js";
import type { CliIO } from "./io.js";
import type { SessionDetails } from "./session-store.js";

export function sanitizeTerminal(text: string): string {
  /* eslint-disable no-control-regex */
  return text
    // Strip OSC sequences (e.g. \x1b]0;Title\x07 or \x1b]0;Title\x1b\)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    // Strip DCS sequences (\x1bP ... \x1b\)
    .replace(/\x1bP[^\x1b]*\x1b\\/gu, "")
    // Strip CSI sequences (\x1b[ ... [A-Za-z~])
    .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/gu, "")
    // Strip other ESC sequences
    .replace(/\x1b[@-Z\\-_]/gu, "")
    // Strip non-printable control characters except \t, \n, \r
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "");
  /* eslint-enable no-control-regex */
}

export function stripAnsi(text: string): string {
  return sanitizeTerminal(text);
}

export function formatSession(details: SessionDetails): string {
  const cost = details.item.usage.estimatedCostUsd === undefined
    ? "cost unknown"
    : `$${details.item.usage.estimatedCostUsd.toFixed(6)}`;
  return [
    sanitizeTerminal(details.item.sessionId),
    sanitizeTerminal(details.item.state),
    sanitizeTerminal(details.item.updatedAt),
    `${details.durationMs} ms`,
    `${details.item.usage.totalTokens} tokens`,
    cost,
    `${details.modelRequests} model requests`,
    `${details.toolCalls} tool calls`,
    sanitizeTerminal(details.item.task),
  ].join("\t");
}

export function reportTurn(
  result: AgentTurnResult,
  io: CliIO,
): ExitCode | null {
  const safeSessionId = sanitizeTerminal(result.sessionId);
  if (result.error !== undefined) {
    const message = sanitizeTerminal(result.error.message);
    if (result.error.code === "turn_cancelled") {
      io.writeError(
        `Task cancelled.\nSession: ${safeSessionId}\n`,
      );
      return EXIT_CODES.cancelled;
    }
    io.writeError(
      `${message}\nSession: ${safeSessionId}\n`,
    );
    return EXIT_CODES.runtimeFailure;
  }
  const safeOutput = sanitizeTerminal(result.output);
  if (result.status === "running") {
    io.write(`${safeOutput}\n`);
    return null;
  }
  if (result.status === "cancelled") {
    io.writeError(`Task cancelled.\nSession: ${safeSessionId}\n`);
    return EXIT_CODES.cancelled;
  }
  if (result.status === "failed") {
    io.writeError(
      `${safeOutput}\nSession: ${safeSessionId}\n`,
    );
    return EXIT_CODES.runtimeFailure;
  }
  io.write(`${safeOutput}\nSession: ${safeSessionId}\n`);
  return EXIT_CODES.success;
}

export function reportFinished(
  result: AgentRunResult,
  io: CliIO,
): ExitCode {
  const safeSessionId = sanitizeTerminal(result.sessionId);
  if (result.status === "completed") {
    io.write(`${sanitizeTerminal(result.summary)}\nSession: ${safeSessionId}\n`);
    return EXIT_CODES.success;
  }
  if (result.status === "cancelled") {
    io.writeError(`Task cancelled.\nSession: ${safeSessionId}\n`);
    return EXIT_CODES.cancelled;
  }
  const msg = result.error?.message ?? result.summary;
  io.writeError(
    `${sanitizeTerminal(msg)}\nSession: ${safeSessionId}\n`,
  );
  return EXIT_CODES.runtimeFailure;
}

export function reportRestore(
  result: CheckpointRestoreResult,
  io: CliIO,
): void {
  for (const path of result.restoredPaths) io.write(`Restored: ${sanitizeTerminal(path)}\n`);
  for (const path of result.removedPaths) io.write(`Removed: ${sanitizeTerminal(path)}\n`);
  if (result.restoredPaths.length === 0 && result.removedPaths.length === 0) {
    io.write("No checkpoint changes to restore.\n");
  }
}
