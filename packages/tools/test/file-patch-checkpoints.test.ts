import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
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
  FileCheckpointStore,
  runFilePatch,
} from "../src/index.js";

let workspace = "";
let outside = "";
let checkpoints: CheckpointStore;

function call(arguments_: JsonObject): ToolCall {
  return {
    id: "call-file-patch",
    name: "file_patch",
    arguments: arguments_,
  };
}

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    workspaceRoot: workspace,
    sessionId: "session-patch",
    signal,
    checkpoints,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-patch-"));
  outside = await mkdtemp(path.join(tmpdir(), "agent-patch-outside-"));
  checkpoints = new FileCheckpointStore();
  await writeFile(path.join(workspace, "existing.txt"), "alpha alpha\n");
});

afterEach(async () => {
  await Promise.all([
    rm(workspace, { force: true, recursive: true }),
    rm(outside, { force: true, recursive: true }),
  ]);
});

describe("runFilePatch and FileCheckpointStore", () => {
  it("applies explicit optimistic edits and restores the first pre-image", async () => {
    const first = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [
          {
            oldText: "alpha",
            newText: "beta",
            expectedOccurrences: 2,
          },
        ],
      }),
      context(),
    );
    const second = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [
          {
            oldText: "beta",
            newText: "gamma",
            expectedOccurrences: 2,
          },
        ],
      }),
      context(),
    );
    expect(first).toMatchObject({
      ok: true,
      toolCallId: "call-file-patch",
      metadata: { editCount: 1, created: false },
    });
    expect(second.ok).toBe(true);
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe(
      "gamma gamma\n",
    );

    const restored = await checkpoints.restore({
      sessionId: "session-patch",
      workspaceRoot: workspace,
      signal: new AbortController().signal,
    });

    expect(restored).toEqual({
      restoredPaths: ["existing.txt"],
      removedPaths: [],
    });
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe(
      "alpha alpha\n",
    );
  });

  it("creates only an absent file and removes it during restore", async () => {
    const result = await runFilePatch(
      call({
        path: "created.md",
        create: true,
        content: "# created\n",
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      metadata: { created: true },
    });
    expect(await readFile(path.join(workspace, "created.md"), "utf8")).toBe(
      "# created\n",
    );

    const restored = await checkpoints.restore({
      sessionId: "session-patch",
      workspaceRoot: workspace,
      signal: new AbortController().signal,
    });

    expect(restored).toEqual({
      restoredPaths: [],
      removedPaths: ["created.md"],
    });
    await expect(
      readFile(path.join(workspace, "created.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write when optimistic context is stale", async () => {
    const result = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [
          {
            oldText: "missing text",
            newText: "replacement",
          },
        ],
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PATCH_CONTEXT_MISMATCH" },
    });
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe(
      "alpha alpha\n",
    );
  });

  it("rechecks content after checkpoint capture before committing", async () => {
    const store = new FileCheckpointStore();
    checkpoints = {
      async capture(request) {
        await store.capture(request);
        await writeFile(
          path.join(workspace, "existing.txt"),
          "concurrent user change\n",
        );
      },
      restore: store.restore.bind(store),
    };

    const result = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [{ oldText: "alpha", newText: "beta", expectedOccurrences: 2 }],
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "FILE_CHANGED" },
    });
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe(
      "concurrent user change\n",
    );
  });

  it("recovers an orphan first-preimage blob after interruption", async () => {
    const first = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [{ oldText: "alpha", newText: "beta", expectedOccurrences: 2 }],
      }),
      context(),
    );
    expect(first.ok).toBe(true);
    const stem = createHash("sha256").update("existing.txt").digest("hex");
    await unlink(
      path.join(
        workspace,
        ".agent",
        "checkpoints",
        "session-patch",
        `${stem}.json`,
      ),
    );

    const second = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [{ oldText: "beta", newText: "gamma", expectedOccurrences: 2 }],
      }),
      context(),
    );
    expect(second.ok).toBe(true);

    await checkpoints.restore({
      sessionId: "session-patch",
      workspaceRoot: workspace,
      signal: new AbortController().signal,
    });
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe(
      "alpha alpha\n",
    );
  });

  it("rejects a linked checkpoint root before writing any pre-image", async () => {
    await mkdir(path.join(outside, "captured"));
    await symlink(
      path.join(outside, "captured"),
      path.join(workspace, ".agent"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await runFilePatch(
      call({
        path: "existing.txt",
        edits: [{ oldText: "alpha", newText: "beta", expectedOccurrences: 2 }],
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PATH_ESCAPE" },
    });
    expect(await readFile(path.join(workspace, "existing.txt"), "utf8")).toBe(
      "alpha alpha\n",
    );
  });

  it("returns cancellation without creating a checkpoint or file", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runFilePatch(
      call({
        path: "cancelled.md",
        create: true,
        content: "not written",
      }),
      context(controller.signal),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });
    await expect(
      readFile(path.join(workspace, "cancelled.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
