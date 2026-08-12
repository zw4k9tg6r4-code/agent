import { stat, readFile } from "node:fs/promises";
import { workspaceLock } from "./mutex.js";

import type {
  JsonObject,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

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

export const FILE_READ_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;

function optionalPositiveInteger(
  input: JsonObject,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return value;
}

function requestedPath(input: JsonObject): string {
  const value = input["path"];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  return value;
}

function pathFailure(
  call: ToolCall,
  error: WorkspacePathError,
): ToolResult {
  return toolFailure(call, error.code, error.message);
}

export async function runFileRead(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file read was cancelled");
    }

    const pathInput = requestedPath(call.arguments);
    const startLine =
      optionalPositiveInteger(call.arguments, "startLine") ?? 1;
    const requestedEndLine = optionalPositiveInteger(
      call.arguments,
      "endLine",
    );
    if (requestedEndLine !== undefined && requestedEndLine < startLine) {
      return toolFailure(
        call,
        "INVALID_INPUT",
        "endLine must be greater than or equal to startLine",
      );
    }

    const resolved = await resolveWorkspacePath(
      context.workspaceRoot,
      pathInput,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(resolved.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be read",
      );
    }
    const release = await workspaceLock.acquire();
    try {
      const details = await stat(resolved.absolutePath);
      if (!details.isFile()) {
        return toolFailure(
          call,
          "NOT_A_FILE",
          "path must resolve to a file",
        );
      }
      if (details.size > MAX_SOURCE_FILE_BYTES) {
        return toolFailure(
          call,
          "FILE_TOO_LARGE",
          `file exceeds ${MAX_SOURCE_FILE_BYTES} bytes`,
        );
      }

      const bytes = await readFile(resolved.absolutePath, {
        signal: context.signal,
      });

      if (bytes.includes(0)) {
        return toolFailure(
          call,
          "BINARY_FILE",
          "binary files are not available through file_read",
        );
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return toolFailure(
          call,
          "INVALID_UTF8",
          "file_read accepts UTF-8 text files only",
        );
      }

      const lines = text.replace(/\r\n/gu, "\n").split("\n");
      if (lines.at(-1) === "") {
        lines.pop();
      }
      const effectiveEnd = Math.min(
        requestedEndLine ?? lines.length,
        lines.length,
      );
      const selected =
        startLine > lines.length
          ? ""
          : lines.slice(startLine - 1, effectiveEnd).join("\n");
      const bounded = truncateUtf8(selected, FILE_READ_OUTPUT_LIMIT_BYTES);

      return toolSuccess(
        call,
        bounded.output,
        {
          path: resolved.relativePath,
          bytes: details.size,
          startLine,
          endLine: effectiveEnd,
          truncated: bounded.truncated,
          originalOutputBytes: bounded.originalBytes,
        },
      );
    } finally {
      release();
    }
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return pathFailure(call, error);
    }
    if (
      context.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return toolFailure(call, "CANCELLED", "file read was cancelled");
    }
    if (error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown file read failure";
    return toolFailure(call, "FILE_READ_FAILED", message);
  }
}
