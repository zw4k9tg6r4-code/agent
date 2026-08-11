import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CheckpointStore,
  ToolExecutionContext,
} from "@agent/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBuiltinTools,
  FILE_PATCH_DEFINITION,
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
} from "../src/index.js";

let workspace = "";
const checkpoints: CheckpointStore = {
  async capture() {},
  async restore() {
    return { restoredPaths: [], removedPaths: [] };
  },
};

function context(): ToolExecutionContext {
  return {
    workspaceRoot: workspace,
    sessionId: "session-builtins",
    signal: new AbortController().signal,
    checkpoints,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-builtins-"));
  await writeFile(path.join(workspace, "README.md"), "hello\n");
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("createBuiltinTools", () => {
  it("publishes four unique definitions in stable order", () => {
    const tools = createBuiltinTools();

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "file_read",
      "file_search",
      "file_patch",
      "shell_execute",
    ]);
    expect(new Set(tools.map((tool) => tool.definition.name)).size).toBe(4);
    expect(tools.map((tool) => tool.definition)).toEqual([
      FILE_READ_DEFINITION,
      FILE_SEARCH_DEFINITION,
      FILE_PATCH_DEFINITION,
      SHELL_EXECUTE_DEFINITION,
    ]);
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it("executes with the frozen ToolCall signature and preserves its ID", async () => {
    const fileRead = createBuiltinTools()[0];
    if (fileRead === undefined) {
      throw new Error("file_read is missing");
    }

    const result = await fileRead.execute(
      {
        id: "call-public-api",
        name: "file_read",
        arguments: { path: "README.md" },
      },
      context(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-public-api",
      ok: true,
      output: "hello",
    });
  });

  it("fails closed when a call reaches the wrong tool", async () => {
    const fileRead = createBuiltinTools()[0];
    if (fileRead === undefined) {
      throw new Error("file_read is missing");
    }

    const result = await fileRead.execute(
      {
        id: "call-wrong-name",
        name: "file_patch",
        arguments: { path: "README.md" },
      },
      context(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-wrong-name",
      ok: false,
      error: { code: "TOOL_IDENTITY_MISMATCH" },
    });
  });
});
