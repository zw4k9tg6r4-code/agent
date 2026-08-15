import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertResolvedExecutable,
  ExecutablePathError,
  resolveExecutable,
} from "../src/index.js";

let workspace = "";
let outside = "";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-exec-ws-"));
  outside = await mkdtemp(path.join(tmpdir(), "agent-exec-out-"));
});

afterEach(async () => {
  await Promise.all([
    rm(workspace, { force: true, recursive: true }),
    rm(outside, { force: true, recursive: true }),
  ]);
});

describe("executable-path", () => {
  it("resolves node process executable successfully", async () => {
    const nodePath = await realpath(process.execPath);
    const resolved = await resolveExecutable(nodePath, workspace);
    expect(resolved.absolutePath.toLowerCase()).toBe(nodePath.toLowerCase());
    expect(resolved.insideWorkspace).toBe(false);
    expect(resolved.basename).toBe(path.basename(nodePath).toLowerCase());
  });

  it("assertResolvedExecutable verifies canonical absolute executable", async () => {
    const nodePath = await realpath(process.execPath);
    const canonical = await assertResolvedExecutable(nodePath);
    expect(canonical.toLowerCase()).toBe(nodePath.toLowerCase());
  });

  it("assertResolvedExecutable rejects non-absolute path", async () => {
    await expect(assertResolvedExecutable("node")).rejects.toThrow(
      ExecutablePathError,
    );
  });

  it("rejects empty or NUL-byte containing program names", async () => {
    await expect(resolveExecutable("", workspace)).rejects.toThrow(
      ExecutablePathError,
    );
    await expect(resolveExecutable("node\0evil", workspace)).rejects.toThrow(
      ExecutablePathError,
    );
  });

  it("rejects relative program paths containing slashes", async () => {
    await expect(resolveExecutable("./script", workspace)).rejects.toThrow(
      ExecutablePathError,
    );
    await expect(resolveExecutable("bin/tool", workspace)).rejects.toThrow(
      ExecutablePathError,
    );
  });

  it("rejects script extensions like .bat, .cmd, .ps1, .sh", async () => {
    const script = path.join(outside, "run.bat");
    await writeFile(script, "@echo off\n");
    await expect(resolveExecutable(script, workspace)).rejects.toThrow(
      ExecutablePathError,
    );
    await expect(resolveExecutable("run.ps1", workspace)).rejects.toThrow(
      ExecutablePathError,
    );
  });

  it("rejects files with shebang headers", async () => {
    const script = path.join(outside, process.platform === "win32" ? "tool.exe" : "tool");
    await writeFile(script, "#!/usr/bin/env node\nconsole.log('hi');");
    await expect(resolveExecutable(script, workspace)).rejects.toThrow(
      ExecutablePathError,
    );
  });

  it("throws EXECUTABLE_NOT_FOUND when binary does not exist in PATH", async () => {
    await expect(
      resolveExecutable("nonexistent_binary_xyz_12345", workspace),
    ).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
    });
  });

  it("skips workspace candidates for bare names from PATH", async () => {
    const oldPath = process.env["PATH"];
    try {
      process.env["PATH"] = workspace;
      await expect(
        resolveExecutable("anytool", workspace),
      ).rejects.toMatchObject({
        code: "EXECUTABLE_NOT_FOUND",
      });
    } finally {
      process.env["PATH"] = oldPath;
    }
  });
});
