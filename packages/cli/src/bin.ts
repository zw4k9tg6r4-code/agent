#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./args.js";
import { runCommand } from "./commands.js";
import { CliError, EXIT_CODES, type ExitCode } from "./errors.js";
import { NodeCliIO, type CliIO } from "./io.js";
import {
  ProductionRuntimeFactory,
  type CliRuntimeFactory,
} from "./runtime.js";
import {
  JsonlSessionEventStore,
} from "./session-store.js";
import {
  createInterruptHandle,
  type SignalSource,
} from "./signals.js";

export const CLI_VERSION = "0.0.0";

export interface ExecuteCliContext {
  readonly workspaceRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly io: CliIO;
  readonly runtimeFactory: CliRuntimeFactory;
  readonly signalSource: SignalSource;
  readonly version: string;
}

function sanitizeErrorMessage(error: unknown, workspaceRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(workspaceRoot, "<workspace>");
}

export async function executeCli(
  argv: readonly string[],
  context: ExecuteCliContext,
): Promise<ExitCode> {
  const interrupt = createInterruptHandle(context.signalSource);
  try {
    return await runCommand(parseArgs(argv), {
      workspaceRoot: context.workspaceRoot,
      environment: context.environment,
      io: context.io,
      sessions: new JsonlSessionEventStore(
        resolve(context.workspaceRoot, ".agent", "sessions"),
      ),
      runtimeFactory: context.runtimeFactory,
      signal: interrupt.signal,
      version: context.version,
    });
  } catch (error) {
    if (error instanceof CliError) {
      context.io.writeError(`${sanitizeErrorMessage(error, context.workspaceRoot)}\n`);
      return error.exitCode;
    }
    if (
      interrupt.signal.aborted
      || (error instanceof Error && error.name === "AbortError")
    ) {
      context.io.writeError("Task cancelled.\n");
      return EXIT_CODES.cancelled;
    }
    context.io.writeError(`Unexpected error: ${sanitizeErrorMessage(error, context.workspaceRoot)}\n`);
    return EXIT_CODES.runtimeFailure;
  } finally {
    interrupt.dispose();
  }
}

export async function main(): Promise<ExitCode> {
  return executeCli(process.argv.slice(2), {
    workspaceRoot: process.cwd(),
    environment: process.env,
    io: new NodeCliIO(
      process.stdin,
      process.stdout,
      process.stderr,
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ),
    runtimeFactory: new ProductionRuntimeFactory(),
    signalSource: process,
    version: CLI_VERSION,
  });
}

const entry = process.argv[1];
if (
  entry !== undefined
  && import.meta.url === pathToFileURL(resolve(entry)).href
) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
