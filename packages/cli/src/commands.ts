import { formatUsage, type CliCommand } from "./args.js";
import {
  loadAgentConfig,
  resolveApiKey,
  type AgentConfig,
} from "./config.js";
import { TerminalPermissionConfirmer } from "./confirmation.js";
import { CliError, EXIT_CODES, type ExitCode } from "./errors.js";
import {
  formatSession,
  reportFinished,
  reportRestore,
  reportTurn,
} from "./format.js";
import { initializeWorkspace } from "./init.js";
import type { CliIO } from "./io.js";
import type { CliRuntimeFactory, RuntimeBundle } from "./runtime.js";
import type { JsonlSessionEventStore } from "./session-store.js";

export interface CommandContext {
  readonly workspaceRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly io: CliIO;
  readonly sessions: JsonlSessionEventStore;
  readonly runtimeFactory: CliRuntimeFactory;
  readonly signal: AbortSignal;
  readonly version: string;
}

async function createRuntime(
  context: CommandContext,
): Promise<{ readonly config: AgentConfig } & RuntimeBundle> {
  const config = await loadAgentConfig(context.workspaceRoot);
  void resolveApiKey(config, context.environment);
  const bundle = await context.runtimeFactory.create({
    config,
    sessions: context.sessions,
    confirmations: new TerminalPermissionConfirmer(context.io),
  });
  return { config, ...bundle };
}

async function runOneShot(
  task: string,
  context: CommandContext,
): Promise<ExitCode> {
  const { config, runner } = await createRuntime(context);
  const turn = await runner.runTurn({
    kind: "new",
    task,
    workspaceRoot: context.workspaceRoot,
    permissionMode: config.permissionMode,
    limits: config.limits,
    signal: context.signal,
  });
  const turnCode = reportTurn(turn, context.io);
  if (turnCode !== null) return turnCode;
  return reportFinished(
    await runner.finishSession({
      sessionId: turn.sessionId,
      signal: context.signal,
    }),
    context.io,
  );
}

async function listSessions(context: CommandContext): Promise<ExitCode> {
  const items = await context.sessions.list();
  if (items.length === 0) {
    context.io.write("No local sessions.\n");
    return EXIT_CODES.success;
  }
  for (const item of items) {
    context.io.write(
      `${formatSession(await context.sessions.details(item.sessionId))}\n`,
    );
  }
  return EXIT_CODES.success;
}

async function undoSession(
  sessionId: string,
  context: CommandContext,
): Promise<ExitCode> {
  return context.sessions.withSessionLease(sessionId, async () => {
    if (await context.sessions.get(sessionId) === undefined) {
      throw new CliError(
        "SESSION_NOT_FOUND",
        EXIT_CODES.usageOrConfig,
        `session not found: ${sessionId}`,
      );
    }
    const checkpoints = await context.runtimeFactory.createCheckpointStore();
    reportRestore(
      await checkpoints.restore({
        sessionId,
        workspaceRoot: context.workspaceRoot,
        signal: context.signal,
      }),
      context.io,
    );
    return EXIT_CODES.success;
  });
}

export async function runNonInteractiveCommand(
  command: CliCommand,
  context: CommandContext,
): Promise<ExitCode | null> {
  if (command.kind === "help") {
    context.io.write(`${formatUsage()}\n`);
    return EXIT_CODES.success;
  }
  if (command.kind === "version") {
    context.io.write(`agent ${context.version}\n`);
    return EXIT_CODES.success;
  }
  if (command.kind === "init") {
    const initialized = await initializeWorkspace(context.workspaceRoot);
    context.io.write(
      initialized.configCreated
        ? `Initialized ${initialized.configPath}\n`
        : `Already initialized ${initialized.configPath}\n`,
    );
    return EXIT_CODES.success;
  }
  if (command.kind === "sessions") return listSessions(context);
  if (command.kind === "undo") return undoSession(command.sessionId, context);
  if (command.kind === "run") return runOneShot(command.task, context);
  return null;
}
