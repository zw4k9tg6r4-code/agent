import {
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isSensitiveRelativePath,
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "../src/index.js";

const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    created.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("resolveWorkspacePath", () => {
  it("returns a canonical in-workspace file", async () => {
    const workspace = await temporaryDirectory("agent-workspace-");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "index.ts"), "export {};\n");

    const result = await resolveWorkspacePath(
      workspace,
      "src/../src/index.ts",
    );

    expect(result.relativePath).toBe(path.join("src", "index.ts"));
    expect(result.exists).toBe(true);
    expect(path.isAbsolute(result.absolutePath)).toBe(true);
  });

  it("allows one missing leaf only when explicitly requested", async () => {
    const workspace = await temporaryDirectory("agent-workspace-");
    await mkdir(path.join(workspace, "docs"));

    const result = await resolveWorkspacePath(
      workspace,
      "docs/new.md",
      { allowMissingLeaf: true },
    );

    expect(result.exists).toBe(false);
    expect(result.relativePath).toBe(path.join("docs", "new.md"));
  });

  it("accepts an absolute path only when it remains inside", async () => {
    const workspace = await temporaryDirectory("agent-workspace-");
    const inside = path.join(workspace, "inside.txt");
    const outside = path.join(
      await temporaryDirectory("agent-outside-"),
      "outside.txt",
    );
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");

    await expect(resolveWorkspacePath(workspace, inside)).resolves.toMatchObject({
      absolutePath: await realpath(inside),
      exists: true,
    });
    await expect(
      resolveWorkspacePath(workspace, outside),
    ).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });

  it("denies lexical parent traversal", async () => {
    const workspace = await temporaryDirectory("agent-workspace-");

    await expect(
      resolveWorkspacePath(workspace, "../outside.txt"),
    ).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });

  it("denies a link or Windows junction that resolves outside", async () => {
    const workspace = await temporaryDirectory("agent-workspace-");
    const outside = await temporaryDirectory("agent-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const link = path.join(workspace, "escape");
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      resolveWorkspacePath(workspace, "escape/secret.txt"),
    ).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });

  it("classifies common credential paths", () => {
    expect(isSensitiveRelativePath(".env")).toBe(true);
    expect(isSensitiveRelativePath(path.join(".ssh", "id_ed25519"))).toBe(true);
    expect(isSensitiveRelativePath(".netrc")).toBe(true);
    expect(isSensitiveRelativePath(path.join(".aws", "credentials"))).toBe(true);
    expect(isSensitiveRelativePath(path.join(".kube", "config"))).toBe(true);
    expect(
      isSensitiveRelativePath(path.join(".docker", "config.json")),
    ).toBe(true);
    expect(isSensitiveRelativePath("client-cert.p12")).toBe(true);
    expect(isSensitiveRelativePath("src/index.ts")).toBe(false);
    expect(
      isProtectedWorkspacePath(path.join(".agent", "checkpoints")),
    ).toBe(true);
    expect(isProtectedWorkspacePath(path.join(".git", "config"))).toBe(true);
    expect(isProtectedWorkspacePath("src/index.ts")).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "rejects Windows devices, alternate streams, and trailing dots",
    async () => {
      const workspace = await temporaryDirectory("agent-workspace-");

      for (const requested of ["NUL", "docs/file.txt:secret", "docs/name."]) {
        await expect(
          resolveWorkspacePath(workspace, requested, {
            allowMissingLeaf: true,
          }),
        ).rejects.toBeInstanceOf(WorkspacePathError);
      }
    },
  );
});
