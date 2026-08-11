import type { ToolDefinition } from "@agent/contracts";

import { FILE_PATCH_OUTPUT_LIMIT_BYTES } from "./file-patch.js";
import { FILE_READ_OUTPUT_LIMIT_BYTES } from "./file-read.js";
import { FILE_SEARCH_OUTPUT_LIMIT_BYTES } from "./file-search.js";
import { SHELL_EXECUTE_OUTPUT_LIMIT_BYTES } from "./shell-execute.js";

export const FILE_READ_DEFINITION = {
  name: "file_read",
  description:
    "Read a UTF-8 workspace file, optionally selecting inclusive one-based lines.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  },
  riskLevel: "read",
  outputLimitBytes: FILE_READ_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const FILE_SEARCH_DEFINITION = {
  name: "file_search",
  description:
    "Search UTF-8 workspace files by literal text.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 1024 },
      path: { type: "string", minLength: 1 },
      caseSensitive: { type: "boolean" },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: 500,
      },
    },
  },
  riskLevel: "read",
  outputLimitBytes: FILE_SEARCH_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const FILE_PATCH_DEFINITION = {
  name: "file_patch",
  description:
    "Create one absent UTF-8 file or apply explicit optimistic search/replace edits with a checkpoint.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      create: { type: "boolean" },
      content: { type: "string" },
      expectedSha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText"],
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            expectedOccurrences: {
              type: "integer",
              minimum: 1,
              maximum: 100,
            },
          },
        },
      },
    },
    oneOf: [
      {
        required: ["create", "content"],
        properties: {
          create: { const: true },
        },
        not: {
          anyOf: [
            { required: ["edits"] },
            { required: ["expectedSha256"] },
          ],
        },
      },
      {
        required: ["edits"],
        not: {
          anyOf: [
            {
              required: ["create"],
              properties: { create: { const: true } },
            },
            { required: ["content"] },
          ],
        },
      },
    ],
  },
  riskLevel: "write",
  outputLimitBytes: FILE_PATCH_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const SHELL_EXECUTE_DEFINITION = {
  name: "shell_execute",
  description:
    "Execute one policy-approved local shell command inside a canonical workspace directory.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        minLength: 1,
        maxLength: 8000,
      },
      cwd: { type: "string", minLength: 1 },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
      },
    },
  },
  riskLevel: "execute",
  outputLimitBytes: SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const BUILTIN_TOOL_DEFINITIONS = Object.freeze([
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  FILE_PATCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
] as const);
