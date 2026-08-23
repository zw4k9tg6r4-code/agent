import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";

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
  isSensitiveRelativePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const FILE_SEARCH_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "checkpoints",
  "coverage",
  "dist",
  "node_modules",
  "sessions",
]);

interface SearchInput {
  readonly query: string;
  readonly path: string;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
}

interface SearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

interface SearchBudget {
  files: number;
  totalBytes: number;
}

class SearchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchLimitError";
  }
}

function accountSearchFile(budget: SearchBudget, size: number): void {
  budget.files += 1;
  budget.totalBytes += size;
  if (
    budget.files > MAX_SEARCH_FILES ||
    budget.totalBytes > MAX_SEARCH_TOTAL_BYTES
  ) {
    throw new SearchLimitError(
      `search exceeds ${MAX_SEARCH_FILES} files or ${MAX_SEARCH_TOTAL_BYTES} bytes`,
    );
  }
}

function parseSearchInput(input: JsonObject): SearchInput {
  const query = input["query"];
  const pathInput = input["path"] ?? ".";
  const caseSensitive = input["caseSensitive"] ?? false;
  const maxResults = input["maxResults"] ?? DEFAULT_MAX_RESULTS;

  if (
    typeof query !== "string" ||
    query.length === 0 ||
    query.length > 1_024
  ) {
    throw new TypeError("query must contain 1 through 1024 characters");
  }
  if (typeof pathInput !== "string" || pathInput.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  if (typeof caseSensitive !== "boolean") {
    throw new TypeError("caseSensitive must be a boolean");
  }
  if (
    typeof maxResults !== "number" ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > MAX_RESULTS
  ) {
    throw new TypeError(
      `maxResults must be an integer between 1 and ${MAX_RESULTS}`,
    );
  }

  return {
    query,
    path: pathInput,
    caseSensitive,
    maxResults,
  };
}

function matcherFor(input: SearchInput): RegExp {
  const source = input.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(source, input.caseSensitive ? "u" : "iu");
}

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function collectFiles(
  absolutePath: string,
  relativePath: string,
  signal: AbortSignal,
  budget: SearchBudget,
): Promise<readonly { absolutePath: string; relativePath: string }[]> {
  if (signal.aborted) {
    throw new DOMException("search cancelled", "AbortError");
  }

  const details = await stat(absolutePath);
  if (details.isFile()) {
    accountSearchFile(budget, details.size);
    return [{ absolutePath, relativePath }];
  }
  if (!details.isDirectory()) {
    return [];
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files: { absolutePath: string; relativePath: string }[] = [];

  for (const entry of entries) {
    if (signal.aborted) {
      throw new DOMException("search cancelled", "AbortError");
    }
    // Directory entries are real names from the filesystem and symlinks are
    // skipped, so joining onto the already-canonical start path can never
    // escape the workspace; no per-entry canonicalization is needed.
    if (
      entry.isSymbolicLink() ||
      SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())
    ) {
      continue;
    }

    const childRelative = path.join(relativePath, entry.name);
    if (
      isSensitiveRelativePath(childRelative) ||
      isProtectedWorkspacePath(childRelative)
    ) {
      continue;
    }
    const childAbsolute = path.join(absolutePath, entry.name);

    try {
      if (entry.isDirectory()) {
        files.push(
          ...(await collectFiles(
            childAbsolute,
            childRelative,
            signal,
            budget,
          )),
        );
      } else if (entry.isFile()) {
        const childDetails = await stat(childAbsolute);
        accountSearchFile(budget, childDetails.size);
        files.push({
          absolutePath: childAbsolute,
          relativePath: childRelative,
        });
      }
    } catch (error) {
      if (!isENOENT(error)) {
        throw error;
      }
    }
  }

  return files;
}

async function matchesInFile(
  file: { readonly absolutePath: string; readonly relativePath: string },
  matcher: RegExp,
  remaining: number,
  signal: AbortSignal,
): Promise<readonly SearchMatch[]> {
  const details = await stat(file.absolutePath);
  if (details.size > MAX_SEARCH_FILE_BYTES) {
    return [];
  }
  const bytes = await readFile(file.absolutePath, { signal });
  if (bytes.includes(0)) {
    return [];
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
  }

  const matches: SearchMatch[] = [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const match = matcher.exec(line);
    if (match !== null) {
      matches.push({
        relativePath: file.relativePath,
        line: index + 1,
        column: match.index + 1,
        text: line,
      });
    }
    if (matches.length >= remaining) {
      break;
    }
  }
  return matches;
}

export async function runFileSearch(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file search was cancelled");
    }
    const parsed = parseSearchInput(call.arguments);
    const matcher = matcherFor(parsed);
    const start = await resolveWorkspacePath(
      context.workspaceRoot,
      parsed.path,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(start.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be searched",
      );
    }
    const budget: SearchBudget = { files: 0, totalBytes: 0 };
    const files = await collectFiles(
      start.absolutePath,
      start.relativePath,
      context.signal,
      budget,
    );
    const matches: SearchMatch[] = [];

    for (const file of files) {
      if (matches.length >= parsed.maxResults) {
        break;
      }
      matches.push(
        ...(await matchesInFile(
          file,
          matcher,
          parsed.maxResults - matches.length,
          context.signal,
        )),
      );
    }

    const rendered = matches
      .map(
        (match) =>
          `${match.relativePath}:${match.line}:${match.column}:${match.text}`,
      )
      .join("\n");
    const bounded = truncateUtf8(rendered, FILE_SEARCH_OUTPUT_LIMIT_BYTES);

    return toolSuccess(
      call,
      bounded.output,
      {
        matchCount: matches.length,
        maxResults: parsed.maxResults,
        scannedFiles: budget.files,
        scannedBytes: budget.totalBytes,
        truncated: bounded.truncated,
        originalOutputBytes: bounded.originalBytes,
      },
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (error instanceof SearchLimitError) {
      return toolFailure(call, "SEARCH_LIMIT_EXCEEDED", error.message);
    }
    if (
      context.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return toolFailure(call, "CANCELLED", "file search was cancelled");
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown file search failure";
    return toolFailure(call, "FILE_SEARCH_FAILED", message);
  }
}
