import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CheckpointStore,
  JsonObject,
  ToolCall,
  ToolExecutionContext,
} from "@agent/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runFileRead,
  runFileSearch,
} from "../src/index.js";

let workspace = "";
let outside = "";

const checkpoints: CheckpointStore = {
  async capture() {},
  async restore() {
    return {
      restoredPaths: [],
      removedPaths: [],
    };
  },
};

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    workspaceRoot: workspace,
    sessionId: "session-read-search",
    signal,
    checkpoints,
  };
}

function call(name: string, arguments_: JsonObject): ToolCall {
  return {
    id: `call-${name}`,
    name,
    arguments: arguments_,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-tools-"));
  outside = await mkdtemp(path.join(tmpdir(), "agent-outside-"));
  await mkdir(path.join(workspace, "src"));
  await writeFile(
    path.join(workspace, "src", "one.ts"),
    "first line\nneedle alpha\nlast line\n",
  );
  await writeFile(
    path.join(workspace, "src", "two.ts"),
    "needle beta\n",
  );
  await writeFile(path.join(workspace, ".env"), "API_KEY=fake-secret\n");
  await writeFile(path.join(outside, "outside.txt"), "needle outside\n");
  await symlink(
    outside,
    path.join(workspace, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
});

afterEach(async () => {
  await Promise.all([
    rm(workspace, { force: true, recursive: true }),
    rm(outside, { force: true, recursive: true }),
  ]);
});

describe("runFileRead", () => {
  it("reads an inclusive one-based line range", async () => {
    const result = await runFileRead(
      call("file_read", {
        path: "src/one.ts",
        startLine: 2,
        endLine: 3,
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: "needle alpha\nlast line",
      metadata: {
        path: path.join("src", "one.ts"),
        startLine: 2,
        endLine: 3,
      },
      toolCallId: "call-file_read",
    });
  });

  it("denies sensitive and link-escaped files", async () => {
    const sensitive = await runFileRead(
      call("file_read", { path: ".env" }),
      context(),
    );
    const escaped = await runFileRead(
      call("file_read", { path: "linked/outside.txt" }),
      context(),
    );

    expect(sensitive).toMatchObject({
      ok: false,
      error: { code: "SENSITIVE_PATH" },
    });
    expect(escaped).toMatchObject({
      ok: false,
      error: { code: "PATH_ESCAPE" },
    });
  });
});

describe("runFileSearch", () => {
  it("returns deterministic path, line, column, and text matches", async () => {
    const result = await runFileSearch(
      call("file_search", {
        query: "needle",
        path: "src",
        maxResults: 10,
      }),
      context(),
    );

    expect(result.ok).toBe(true);
    expect(result.output.split("\n")).toEqual([
      `${path.join("src", "one.ts")}:2:1:needle alpha`,
      `${path.join("src", "two.ts")}:1:1:needle beta`,
    ]);
  });

  it("does not traverse sensitive files or linked directories", async () => {
    const sensitive = await runFileSearch(
      call("file_search", { query: "fake-secret", path: "." }),
      context(),
    );
    const linked = await runFileSearch(
      call("file_search", { query: "outside", path: "." }),
      context(),
    );

    expect(sensitive).toMatchObject({
      ok: true,
      output: "",
    });
    expect(linked).toMatchObject({
      ok: true,
      output: "",
    });
  });

  it("does not traverse protected Agent or Git metadata", async () => {
    await mkdir(path.join(workspace, ".agent", "sessions"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, ".agent", "sessions", "session.jsonl"),
      "protected marker\n",
    );

    const result = await runFileSearch(
      call("file_search", { query: "protected marker" }),
      context(),
    );

    expect(result).toMatchObject({ ok: true, output: "" });
  });

  it("returns a structured cancellation failure", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runFileSearch(
      call("file_search", { query: "needle", path: "." }),
      context(controller.signal),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });
  });
});
