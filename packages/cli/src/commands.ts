import { formatUsage, type CliCommand } from "./args.js";
import {
  loadAgentConfig,
  loadProviderProfile,
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
  const profile = await loadProviderProfile(config.provider.profileId);
  void resolveApiKey(profile, context.environment);
  const bundle = await context.runtimeFactory.create({
    config,
    sessions: context.sessions,
    confirmations: new TerminalPermissionConfirmer(context.io),
    environment: context.environment,
  });
  return { config, ...bundle };
}

async function finish(
  sessionId: string,
  runner: RuntimeBundle["runner"],
  context: CommandContext,
  token?: string,
): Promise<ExitCode> {
  return reportFinished(
    await runner.finishSession({ sessionId, signal: context.signal, ...(token !== undefined && { token }) }),
    context.io,
  );
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
  const code = reportTurn(turn, context.io);
  if (code !== null) {
    const type = code === EXIT_CODES.cancelled ? "session_cancelled" : "session_failed";
    await context.sessions.append(turn.sessionId, type === "session_failed"
      ? { type, code: turn.error?.code ?? "unknown", message: turn.error?.message ?? "Unknown error" }
      : { type, reason: "user_cancelled" }
    );
    return code;
  }
  return finish(turn.sessionId, runner, context);
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
  return context.sessions.withSessionLease(sessionId, async (token) => {
    if (await context.sessions.get(sessionId) === undefined) {
      throw new CliError(
        "SESSION_NOT_FOUND",
        EXIT_CODES.usageOrConfig,
        `session not found: ${sessionId}`,
      );
    }
    const checkpoints = await context.runtimeFactory.createCheckpointStore();

    const expectedHashes = new Map<string, string | null>();
    for await (const event of context.sessions.read(sessionId)) {
      if (
        event.type === "tool_completed" &&
        event.result.ok &&
        event.result.metadata
      ) {
        const path = event.result.metadata["path"];
        const newSha256 = event.result.metadata["newSha256"];
        if (typeof path === "string" && typeof newSha256 === "string") {
          expectedHashes.set(path, newSha256);
        } else if (typeof path === "string" && newSha256 === null) {
          expectedHashes.set(path, null);
        }
      }
    }

    reportRestore(
      await checkpoints.restore({
        sessionId,
        workspaceRoot: context.workspaceRoot,
        signal: context.signal,
        expectedHashes,
      }),
      context.io,
    );
    return EXIT_CODES.success;
  });
}

async function shouldInvokeResume(
  sessions: JsonlSessionEventStore,
  sessionId: string,
): Promise<boolean> {
  let activeTurnId: string | undefined;
  const pendingToolCallIds = new Set<string>();
  for await (const event of sessions.read(sessionId)) {
    if (event.type === "turn_started") {
      activeTurnId = event.turnId;
    } else if (
      (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_cancelled")
      && event.turnId === activeTurnId
    ) {
      activeTurnId = undefined;
    }
    if (event.type === "model_response_completed") {
      for (const call of event.message.toolCalls ?? []) {
        pendingToolCallIds.add(call.id);
      }
    } else if (event.type === "tool_requested") {
      pendingToolCallIds.add(event.call.id);
    } else if (event.type === "tool_completed" || event.type === "tool_failed") {
      pendingToolCallIds.delete(event.result.toolCallId);
    }
  }
  return activeTurnId !== undefined || pendingToolCallIds.size > 0;
}

async function interactiveLoop(
  context: CommandContext,
  initialSessionId?: string,
  resume = false,
  token?: string,
): Promise<ExitCode> {
  let sessionId = initialSessionId;
  let loaded:
    | ({ readonly config: AgentConfig } & RuntimeBundle)
    | undefined;

  if (resume) {
    const item = sessionId === undefined
      ? undefined
      : await context.sessions.get(sessionId);
    if (item === undefined) {
      throw new CliError(
        "SESSION_NOT_FOUND",
        EXIT_CODES.usageOrConfig,
        `session not found: ${sessionId ?? ""}`,
      );
    }
    if (item.state !== "running") {
      throw new CliError(
        "DATA_ERROR",
        EXIT_CODES.usageOrConfig,
        `session ${item.sessionId} is not resumable: ${item.state}`,
      );
    }
    loaded = await createRuntime(context);
    if (await shouldInvokeResume(context.sessions, item.sessionId)) {
      const resumed = await loaded.runner.runTurn({
        kind: "resume",
        sessionId: item.sessionId,
        workspaceRoot: context.workspaceRoot,
        limits: loaded.config.limits,
        signal: context.signal,
        ...(token !== undefined && { token }),
      });
      const code = reportTurn(resumed, context.io);
      if (code !== null) {
        const type = code === EXIT_CODES.cancelled ? "session_cancelled" : "session_failed";
        await context.sessions.append(item.sessionId, type === "session_failed"
          ? { type, code: resumed.error?.code ?? "unknown", message: resumed.error?.message ?? "Unknown error" }
          : { type, reason: "user_cancelled" },
          token
        );
        return code;
      }
      sessionId = resumed.sessionId;
    }
  }

  while (true) {
    const input = await context.io.readLine("agent> ", context.signal);
    if (input === null || input.trim() === "/exit") {
      if (context.signal.aborted) return EXIT_CODES.cancelled;
      if (sessionId === undefined || loaded === undefined) {
        return EXIT_CODES.success;
      }
      return finish(sessionId, loaded.runner, context, token);
    }

    const message = input.trim();
    if (message.length === 0) continue;
    loaded ??= await createRuntime(context);
    const turn = sessionId === undefined
      ? await loaded.runner.runTurn({
          kind: "new",
          task: message,
          workspaceRoot: context.workspaceRoot,
          permissionMode: loaded.config.permissionMode,
          limits: loaded.config.limits,
          signal: context.signal,
          ...(token !== undefined && { token }),
        })
      : await loaded.runner.runTurn({
          kind: "continue",
          sessionId,
          message,
          workspaceRoot: context.workspaceRoot,
          limits: loaded.config.limits,
          signal: context.signal,
          ...(token !== undefined && { token }),
        });
    const code = reportTurn(turn, context.io);
    if (code !== null) {
      const type = code === EXIT_CODES.cancelled ? "session_cancelled" : "session_failed";
      await context.sessions.append(turn.sessionId, type === "session_failed"
        ? { type, code: turn.error?.code ?? "unknown", message: turn.error?.message ?? "Unknown error" }
        : { type, reason: "user_cancelled" },
        token
      );
      return code;
    }
    sessionId = turn.sessionId;
  }
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

export async function runCommand(
  command: CliCommand,
  context: CommandContext,
): Promise<ExitCode> {
  const nonInteractive = await runNonInteractiveCommand(command, context);
  if (nonInteractive !== null) return nonInteractive;
  return command.kind === "resume"
    ? context.sessions.withSessionLease(
        command.sessionId,
        async (token) => interactiveLoop(context, command.sessionId, true, token),
      )
    : interactiveLoop(context);
}
