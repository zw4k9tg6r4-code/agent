import type {
  PermissionConfirmer,
  PermissionDecision,
  PermissionRequest,
} from "@agent/contracts";

import type { CliIO } from "./io.js";

export class TerminalPermissionConfirmer implements PermissionConfirmer {
  readonly #io: CliIO;

  constructor(io: CliIO) {
    this.#io = io;
  }

  async confirm(
    request: PermissionRequest,
    decision: PermissionDecision,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (decision.outcome === "allow") return true;
    if (decision.outcome === "deny" || signal.aborted) return false;

    this.#io.write([
      "\nPermission confirmation required\n",
      `Tool: ${request.tool.name}\n`,
      `Risk: ${request.tool.riskLevel}\n`,
      `Mode: ${request.mode}\n`,
      `Rule: ${decision.ruleId}\n`,
      `Reason: ${decision.reason}\n`,
      `Resolved arguments:\n${JSON.stringify(
        decision.resolvedArguments,
        null,
        2,
      )}\n`,
    ].join(""));
    const answer = await this.#io.readLine("Allow once? [y/N] ", signal);
    return answer !== null && /^(?:y|yes)$/iu.test(answer.trim());
  }
}
