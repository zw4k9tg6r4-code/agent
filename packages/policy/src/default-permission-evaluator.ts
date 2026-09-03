import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  JsonObject,
  PermissionDecision,
  PermissionEvaluator,
  PermissionMode,
  PermissionRequest,
  RiskLevel,
} from "@agent/contracts";
import {
  ExecutablePathError,
  isProtectedWorkspacePath,
  resolveExecutable as resolveNativeExecutable,
  resolveWorkspacePath,
  type ResolvedExecutable,
  WorkspacePathError,
} from "@agent/tools";

import {
  analyzeProcess,
  type ProcessRiskAnalysis,
} from "./process-risk.js";

export interface PermissionContext {
  readonly resolveExecutable: ExecutableResolver;
}

export interface ToolStrategy {
  readonly expectedRisk: RiskLevel;
  evaluate(
    request: PermissionRequest,
    context: PermissionContext,
  ): Promise<PermissionDecision>;
}

export interface DefaultPermissionEvaluatorOptions {
  readonly resolveExecutable?: ExecutableResolver;
  readonly strategies?: ReadonlyMap<string, ToolStrategy>;
}

const BUILTIN_STRATEGIES = new Map<string, ToolStrategy>([
  ["file_read", { expectedRisk: "read", evaluate: async (req) => evaluateFileRequest(req) }],
  ["file_search", { expectedRisk: "read", evaluate: async (req) => evaluateFileRequest(req) }],
  ["file_patch", { expectedRisk: "write", evaluate: async (req) => evaluateFileRequest(req) }],
  ["shell_execute", { 
    expectedRisk: "execute", 
    evaluate: async (req, ctx) => evaluateProcessRequest(req, ctx.resolveExecutable) 
  }],
]);

function deny(ruleId: string, reason: string): PermissionDecision {
  return {
    outcome: "deny",
    reason,
    ruleId,
  };
}

function executable(
  outcome: "allow" | "ask",
  ruleId: string,
  reason: string,
  resolvedArguments: JsonObject,
): PermissionDecision {
  return {
    outcome,
    reason,
    ruleId,
    resolvedArguments,
  };
}

function pathErrorDecision(error: WorkspacePathError): PermissionDecision {
  const ruleId =
    error.code === "PATH_ESCAPE"
      ? "path.escape"
      : error.code === "SENSITIVE_PATH"
        ? "path.sensitive"
        : "path.invalid";
  return deny(ruleId, error.message);
}

function pathArgument(toolName: string, input: JsonObject): string {
  const value = input["path"];
  if (value === undefined && toolName === "file_search") {
    return ".";
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  return value;
}

async function evaluateFileRequest(
  request: PermissionRequest,
): Promise<PermissionDecision> {
  try {
    const create =
      request.call.name === "file_patch" &&
      request.call.arguments["create"] === true;
    const resolved = await resolveWorkspacePath(
      request.workspaceRoot,
      pathArgument(request.call.name, request.call.arguments),
      {
        allowMissingLeaf: create,
        rejectSensitive: true,
      },
    );
    if (isProtectedWorkspacePath(resolved.relativePath)) {
      return deny(
        "path.protected",
        "Agent metadata and Git internals are protected",
      );
    }
    const resolvedArguments: JsonObject = {
      ...request.call.arguments,
      path: resolved.absolutePath,
    };

    if (
      request.call.name === "file_read" ||
      request.call.name === "file_search"
    ) {
      return executable(
        "allow",
        `${request.mode}.workspace_read`,
        "canonical workspace read is allowed",
        resolvedArguments,
      );
    }
    if (request.mode === "readonly") {
      return deny(
        "readonly.write_denied",
        "readonly mode does not permit file changes",
      );
    }
    return executable(
      "allow",
      `${request.mode}.workspace_patch`,
      "explicit patch inside the workspace is allowed",
      resolvedArguments,
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return pathErrorDecision(error);
    }
    const message =
      error instanceof Error ? error.message : "invalid file arguments";
    return deny("input.invalid", message);
  }
}

function processDecision(
  mode: PermissionMode,
  analysis: ProcessRiskAnalysis,
  resolvedArguments: JsonObject,
): PermissionDecision {
  if (analysis.denyAlways) {
    return deny(
      "process.deny_always",
      analysis.reasons.join("; "),
    );
  }
  if (mode === "readonly") {
    return analysis.impact === "read_only"
      ? executable(
          "allow",
          "readonly.process_read",
          analysis.reasons.join("; "),
          resolvedArguments,
        )
      : deny(
          "readonly.process_not_readonly",
          "readonly permits only exact read-only direct processes",
        );
  }
  if (analysis.impact === "read_only") {
    return executable(
      "allow",
      `${mode}.process_read`,
      analysis.reasons.join("; "),
      resolvedArguments,
    );
  }
  if (
    mode === "trusted" &&
    analysis.impact === "local_low_risk" &&
    !analysis.workspaceExecutable
  ) {
    return executable(
      "allow",
      "trusted.process_local_low_risk",
      analysis.reasons.join("; "),
      resolvedArguments,
    );
  }
  return executable(
    "ask",
    `${mode}.process_${analysis.impact}`,
    analysis.reasons.join("; "),
    resolvedArguments,
  );
}

type ExecutableResolver = (
  program: string,
  workspaceRoot: string,
) => Promise<ResolvedExecutable>;

function processArguments(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string")
  ) {
    throw new TypeError("args must be an array of strings");
  }
  return [...value];
}

function timeoutArgument(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  return value as number;
}

function obviousPath(argument: string): string | undefined {
  const candidate = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : argument;
  return (
    path.isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/u.test(candidate) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(candidate)
  )
    ? candidate
    : undefined;
}

async function canonicalizeProcessArguments(
  args: readonly string[],
  analysis: ProcessRiskAnalysis,
  workspaceRoot: string,
): Promise<readonly string[]> {
  const indexes = new Set(analysis.workspacePathArgumentIndexes);
  const resolved = [...args];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (indexes.has(index)) {
      const target = await resolveWorkspacePath(workspaceRoot, argument, {
        rejectSensitive: true,
      });
      if (isProtectedWorkspacePath(target.relativePath)) {
        throw new WorkspacePathError(
          "SENSITIVE_PATH",
          "protected paths cannot be process arguments",
        );
      }
      resolved[index] = target.absolutePath;
      continue;
    }
    const candidate = obviousPath(argument);
    if (candidate !== undefined) {
      await resolveWorkspacePath(workspaceRoot, candidate, {
        rejectSensitive: true,
      });
      continue;
    }
    // Best-effort symlink check for bare relative args (e.g. `link` or
    // `dir/file`): they pass obviousPath but may still resolve outside the
    // workspace via a symlink. Escapes and sensitive/protected targets are
    // denied; anything else is left as-is so bare words (branches, URLs,
    // revisions) keep working.
    if (!argument.startsWith("-")) {
      const maybePath = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argument;
      if (maybePath.length > 0 && !maybePath.startsWith("-")) {
        try {
          const target = await resolveWorkspacePath(workspaceRoot, maybePath, {
            rejectSensitive: true,
          });
          if (isProtectedWorkspacePath(target.relativePath)) {
            throw new WorkspacePathError(
              "SENSITIVE_PATH",
              "protected paths cannot be process arguments",
            );
          }
        } catch (error) {
          if (error instanceof WorkspacePathError) {
            if (
              error.code === "PATH_ESCAPE" ||
              error.code === "SENSITIVE_PATH"
            ) {
              throw error;
            }
            // PATH_NOT_FOUND / INVALID_PATH: not a workspace path, ignore.
            continue;
          }
          throw error;
        }
      }
    }
  }
  return resolved;
}

async function evaluateProcessRequest(
  request: PermissionRequest,
  executableResolver: ExecutableResolver,
): Promise<PermissionDecision> {
  try {
    const program = request.call.arguments["program"];
    if (typeof program !== "string" || program.length === 0) {
      return deny("input.invalid", "program must be a non-empty string");
    }
    const args = processArguments(request.call.arguments["args"]);
    const timeoutMs = timeoutArgument(request.call.arguments["timeoutMs"]);
    const cwdInput = request.call.arguments["cwd"] ?? ".";
    if (typeof cwdInput !== "string" || cwdInput.length === 0) {
      return deny("input.invalid", "cwd must be a non-empty string");
    }
    const cwd = await resolveWorkspacePath(
      request.workspaceRoot,
      cwdInput,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(cwd.relativePath)) {
      return deny("path.protected", "protected directories cannot be process cwd");
    }
    const details = await stat(cwd.absolutePath);
    if (!details.isDirectory()) {
      return deny("path.invalid", "process cwd must be a directory");
    }
    const executablePath = await executableResolver(
      program,
      request.workspaceRoot,
    );
    const analysis = analyzeProcess(
      executablePath.absolutePath,
      args,
      executablePath.insideWorkspace,
    );
    const canonicalArgs = await canonicalizeProcessArguments(
      args,
      analysis,
      request.workspaceRoot,
    );
    const resolvedArguments: JsonObject = {
      program: executablePath.absolutePath,
      args: [...canonicalArgs],
      cwd: cwd.absolutePath,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    return processDecision(
      request.mode,
      analysis,
      resolvedArguments,
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return pathErrorDecision(error);
    }
    if (error instanceof ExecutablePathError) {
      return deny("process.invalid_executable", error.message);
    }
    const message =
      error instanceof Error ? error.message : "invalid process arguments";
    return deny("input.invalid", message);
  }
}

export class DefaultPermissionEvaluator implements PermissionEvaluator {
  readonly #resolveExecutable: ExecutableResolver;
  readonly #strategies: ReadonlyMap<string, ToolStrategy>;

  constructor(options: DefaultPermissionEvaluatorOptions = {}) {
    this.#resolveExecutable =
      options.resolveExecutable ?? resolveNativeExecutable;
    this.#strategies = options.strategies ?? BUILTIN_STRATEGIES;
  }

  async evaluate(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (request.call.name !== request.tool.name) {
      return deny(
        "tool.identity_mismatch",
        "tool call name does not match its definition",
      );
    }
    const strategy = this.#strategies.get(request.call.name);
    if (strategy === undefined) {
      return deny("tool.unknown", "tool is not registered in the strategy registry");
    }
    if (request.tool.riskLevel !== strategy.expectedRisk) {
      return deny(
        "tool.definition_mismatch",
        "tool risk level does not match the registered strategy",
      );
    }
    return strategy.evaluate(request, {
      resolveExecutable: this.#resolveExecutable,
    });
  }
}
