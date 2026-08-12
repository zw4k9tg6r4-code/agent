import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { workspaceLock } from "./mutex.js";

import type {
  JsonObject,
  JsonValue,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import { writeFileAtomic, writeFileExclusiveAtomic } from "./atomic-file.js";
import {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const FILE_PATCH_OUTPUT_LIMIT_BYTES = 16 * 1024;
const MAX_PATCHED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EDITS = 50;

interface PatchEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences: number;
}

interface ParsedPatch {
  readonly path: string;
  readonly create: boolean;
  readonly content?: string;
  readonly edits: readonly PatchEdit[];
  readonly expectedSha256?: string;
}

function objectValue(value: JsonValue, label: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function parseEdit(value: JsonValue, index: number): PatchEdit {
  const edit = objectValue(value, `edits[${index}]`);
  const oldText = edit["oldText"];
  const newText = edit["newText"];
  const expectedOccurrences = edit["expectedOccurrences"] ?? 1;

  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new TypeError(`edits[${index}].oldText must be non-empty`);
  }
  if (typeof newText !== "string") {
    throw new TypeError(`edits[${index}].newText must be a string`);
  }
  if (
    typeof expectedOccurrences !== "number" ||
    !Number.isInteger(expectedOccurrences) ||
    expectedOccurrences < 1 ||
    expectedOccurrences > 100
  ) {
    throw new TypeError(
      `edits[${index}].expectedOccurrences must be 1 through 100`,
    );
  }
  return { oldText, newText, expectedOccurrences };
}

function parsePatch(input: JsonObject): ParsedPatch {
  const pathInput = input["path"];
  const create = input["create"] ?? false;
  const content = input["content"];
  const editsInput = input["edits"];
  const expectedSha256 = input["expectedSha256"];

  if (typeof pathInput !== "string" || pathInput.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  if (typeof create !== "boolean") {
    throw new TypeError("create must be a boolean");
  }
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256))
  ) {
    throw new TypeError("expectedSha256 must be a lowercase SHA-256 digest");
  }

  if (create) {
    if (typeof content !== "string") {
      throw new TypeError("content is required when create is true");
    }
    if (editsInput !== undefined || expectedSha256 !== undefined) {
      throw new TypeError(
        "create cannot be combined with edits or expectedSha256",
      );
    }
    return {
      path: pathInput,
      create,
      content,
      edits: [],
    };
  }

  if (!Array.isArray(editsInput) || editsInput.length === 0) {
    throw new TypeError("edits must be a non-empty array");
  }
  if (editsInput.length > MAX_EDITS) {
    throw new TypeError(`edits cannot exceed ${MAX_EDITS} entries`);
  }
  if (content !== undefined) {
    throw new TypeError("content is only valid when create is true");
  }
  return {
    path: pathInput,
    create,
    edits: editsInput.map(parseEdit),
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
  };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(search, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + search.length;
  }
}

function applyEdits(
  call: ToolCall,
  original: string,
  edits: readonly PatchEdit[],
): ToolResult | string {
  let current = original;
  for (const [index, edit] of edits.entries()) {
    const occurrences = countOccurrences(current, edit.oldText);
    if (occurrences !== edit.expectedOccurrences) {
      return toolFailure(
        call,
        "PATCH_CONTEXT_MISMATCH",
        `edit ${index} expected ${edit.expectedOccurrences} occurrence(s), found ${occurrences}`,
      );
    }
    current = current.split(edit.oldText).join(edit.newText);
  }
  return current;
}

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function runFilePatch(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  const release = await workspaceLock.acquire();
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file patch was cancelled");
    }
    const parsed = parsePatch(call.arguments);
    const initial = await resolveWorkspacePath(
      context.workspaceRoot,
      parsed.path,
      {
        allowMissingLeaf: parsed.create,
        rejectSensitive: true,
      },
    );
    if (isProtectedWorkspacePath(initial.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be patched",
      );
    }
    if (parsed.create && initial.exists) {
      return toolFailure(
        call,
        "FILE_ALREADY_EXISTS",
        "create refuses to overwrite an existing file",
      );
    }
    if (!parsed.create && !initial.exists) {
      return toolFailure(
        call,
        "PATH_NOT_FOUND",
        "patch target does not exist",
      );
    }

    let original = "";
    let originalSha256: string | null = null;
    let mode: number | undefined;
    if (!parsed.create) {
      const details = await stat(initial.absolutePath);
      if (!details.isFile()) {
        return toolFailure(call, "NOT_A_FILE", "patch target must be a file");
      }
      if (details.size > MAX_PATCHED_FILE_BYTES) {
        return toolFailure(
          call,
          "FILE_TOO_LARGE",
          `patch target exceeds ${MAX_PATCHED_FILE_BYTES} bytes`,
        );
      }
      const bytes = await readFile(initial.absolutePath, {
        signal: context.signal,
      });
      if (bytes.length > MAX_PATCHED_FILE_BYTES) {
        return toolFailure(
          call,
          "FILE_TOO_LARGE",
          `patch target exceeds ${MAX_PATCHED_FILE_BYTES} bytes`,
        );
      }
      if (bytes.includes(0)) {
        return toolFailure(
          call,
          "BINARY_FILE",
          "file_patch accepts UTF-8 text files only",
        );
      }
      try {
        original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return toolFailure(
          call,
          "INVALID_UTF8",
          "file_patch accepts UTF-8 text files only",
        );
      }
      mode = details.mode & 0o777;
      originalSha256 = digest(bytes);
    }

    if (
      parsed.expectedSha256 !== undefined &&
      originalSha256 !== parsed.expectedSha256
    ) {
      return toolFailure(
        call,
        "FILE_CHANGED",
        "file content does not match expectedSha256",
      );
    }

    const next = parsed.create
      ? (parsed.content ?? "")
      : applyEdits(call, original, parsed.edits);
    if (typeof next !== "string") {
      return next;
    }
    if (next === original && !parsed.create) {
      return toolFailure(call, "NO_CHANGE", "patch does not change the file");
    }
    if (Buffer.byteLength(next, "utf8") > MAX_PATCHED_FILE_BYTES) {
      return toolFailure(
        call,
        "FILE_TOO_LARGE",
        `patched file exceeds ${MAX_PATCHED_FILE_BYTES} bytes`,
      );
    }

    await context.checkpoints.capture({
      sessionId: context.sessionId,
      workspaceRoot: initial.workspaceRoot,
      relativePath: initial.relativePath,
      signal: context.signal,
    });
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file patch was cancelled");
    }

    const finalTarget = await resolveWorkspacePath(
      initial.workspaceRoot,
      initial.relativePath,
      {
        allowMissingLeaf: parsed.create,
        rejectSensitive: true,
      },
    );
    if (
      finalTarget.absolutePath !== initial.absolutePath ||
      finalTarget.exists !== initial.exists
    ) {
      return toolFailure(
        call,
        "PATH_CHANGED",
        "patch target changed after authorization",
      );
    }
    if (!parsed.create) {
      const finalDetails = await stat(finalTarget.absolutePath);
      if (
        !finalDetails.isFile() ||
        finalDetails.size > MAX_PATCHED_FILE_BYTES
      ) {
        return toolFailure(
          call,
          "FILE_CHANGED",
          "patch target type or size changed before commit",
        );
      }
      const current = await readFile(finalTarget.absolutePath, {
        signal: context.signal,
      });
      if (
        current.length > MAX_PATCHED_FILE_BYTES ||
        digest(current) !== originalSha256
      ) {
        return toolFailure(
          call,
          "FILE_CHANGED",
          "patch target content changed before commit",
        );
      }
    }

    if (parsed.create) {
      const result = await writeFileExclusiveAtomic(finalTarget.absolutePath, next, {
        ...(mode === undefined ? {} : { mode }),
        signal: context.signal,
      });
      if (result === "exists") {
        return toolFailure(
          call,
          "FILE_ALREADY_EXISTS",
          "patch target changed before commit",
        );
      }
    } else {
      await writeFileAtomic(finalTarget.absolutePath, next, {
        ...(mode === undefined ? {} : { mode }),
        signal: context.signal,
        ...(typeof originalSha256 === "string" ? { expectedSha256: originalSha256 } : {}),
      });
    }

    return toolSuccess(
      call,
      `patched ${finalTarget.relativePath}`,
      {
        path: finalTarget.relativePath,
        created: parsed.create,
        editCount: parsed.edits.length,
        previousSha256: originalSha256,
        newSha256: digest(next),
      },
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (
      context.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return toolFailure(call, "CANCELLED", "file patch was cancelled");
    }
    if (error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown file patch failure";
    return toolFailure(call, "FILE_PATCH_FAILED", message);
  } finally {
    release();
  }
}
