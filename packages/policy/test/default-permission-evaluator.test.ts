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
  JsonObject,
  PermissionMode,
  PermissionRequest,
  RiskLevel,
  ToolDefinition,
} from "@agent/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DefaultPermissionEvaluator } from "../src/index.js";

let workspace = "";
let outside = "";

function fakeExecutable(program: string) {
  const insideWorkspace = program === "workspace-tool";
  const absolutePath = insideWorkspace
    ? path.join(workspace, "bin", "workspace-tool.exe")
    : path.join(path.parse(workspace).root, "agent-test-bin", `${program}.exe`);
  return {
    absolutePath,
    insideWorkspace,
    basename: path.basename(absolutePath).toLowerCase(),
  };
}

const evaluator = new DefaultPermissionEvaluator({
  resolveExecutable: async (program) => fakeExecutable(program),
});

function definition(name: string, riskLevel: RiskLevel): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    riskLevel,
    outputLimitBytes: 65_536,
    supportsCancellation: true,
  };
}

function request(
  mode: PermissionMode,
  name: string,
  riskLevel: RiskLevel,
  arguments_: JsonObject,
): PermissionRequest {
  return {
    mode,
    workspaceRoot: workspace,
    tool: definition(name, riskLevel),
    call: {
      id: `call-${name}`,
      name,
      arguments: arguments_,
    },
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-policy-"));
  outside = await mkdtemp(path.join(tmpdir(), "agent-policy-outside-"));
  await mkdir(path.join(workspace, "src"));
  await mkdir(path.join(workspace, ".agent", "checkpoints"), {
    recursive: true,
  });
  await writeFile(path.join(workspace, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(workspace, ".env"), "API_KEY=fake-secret\n");
  await writeFile(path.join(outside, "outside.txt"), "outside\n");
  await symlink(
    outside,
    path.join(workspace, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
});

afterEach(async () => {
  await Promise.all([
    rm(workspace, { force: true, recursive: true }),
    rm(outside, { force: true, recursive: true }),
  ]);
});

describe("DefaultPermissionEvaluator file policy", () => {
  it.each(["readonly", "workspace", "trusted"] as const)(
    "allows safe reads in %s with a canonical path",
    async (mode) => {
      const decision = await evaluator.evaluate(
        request(mode, "file_read", "read", {
          path: "src/../src/index.ts",
        }),
      );

      expect(decision.outcome).toBe("allow");
      if (decision.outcome === "deny") {
        throw new Error("expected executable decision");
      }
      expect(path.isAbsolute(String(decision.resolvedArguments["path"]))).toBe(
        true,
      );
    },
  );

  it("uses the file_search root default when path is omitted", async () => {
    const decision = await evaluator.evaluate(
      request("readonly", "file_search", "read", { query: "needle" }),
    );

    expect(decision.outcome).toBe("allow");
    if (decision.outcome !== "deny") {
      expect(decision.resolvedArguments["path"]).toBe(
        path.resolve(workspace),
      );
    }
  });

  it.each([
    ["readonly", "deny"],
    ["workspace", "allow"],
    ["trusted", "allow"],
  ] as const)("makes file_patch %s => %s", async (mode, outcome) => {
    const decision = await evaluator.evaluate(
      request(mode, "file_patch", "write", {
        path: "src/index.ts",
        edits: [{ oldText: "export {}", newText: "export const x = 1" }],
      }),
    );

    expect(decision.outcome).toBe(outcome);
  });

  it.each(["readonly", "workspace", "trusted"] as const)(
    "denies sensitive, protected, and link-escaped paths in %s",
    async (mode) => {
      const sensitive = await evaluator.evaluate(
        request(mode, "file_read", "read", { path: ".env" }),
      );
      const protectedPath = await evaluator.evaluate(
        request(mode, "file_read", "read", {
          path: ".agent/checkpoints",
        }),
      );
      const escaped = await evaluator.evaluate(
        request(mode, "file_read", "read", {
          path: "escape/outside.txt",
        }),
      );

      expect(sensitive).toMatchObject({ outcome: "deny" });
      expect(protectedPath).toMatchObject({
        outcome: "deny",
        ruleId: "path.protected",
      });
      expect(escaped).toMatchObject({
        outcome: "deny",
        ruleId: "path.escape",
      });
    },
  );
});

describe("DefaultPermissionEvaluator direct-process matrix", () => {
  it.each([
    ["readonly", "node", ["--version"], "allow"],
    ["readonly", "node", ["--check", "src/index.ts"], "deny"],
    ["workspace", "node", ["--check", "src/index.ts"], "ask"],
    ["trusted", "node", ["--check", "src/index.ts"], "allow"],
    ["workspace", "node", ["src/index.ts"], "ask"],
    ["trusted", "workspace-tool", [], "ask"],
    ["workspace", "npm", ["install", "left-pad"], "ask"],
    ["workspace", "curl", ["https://example.com"], "ask"],
    ["workspace", "git", ["push", "origin", "main"], "ask"],
    ["workspace", "rm", ["-r", "build"], "ask"],
    ["trusted", "rm", ["-rf", "/"], "deny"],
    ["trusted", "node", ["-e", "process.exit(0)"], "deny"],
  ] as const)(
    "%s maps %s %j to %s",
    async (mode, program, args, outcome) => {
      const decision = await evaluator.evaluate(
        request(mode, "shell_execute", "execute", {
          program,
          args: [...args],
          cwd: ".",
        }),
      );

      expect(decision.outcome).toBe(outcome);
      if (decision.outcome !== "deny") {
        expect(path.isAbsolute(String(decision.resolvedArguments["program"]))).toBe(
          true,
        );
        expect(
          path.isAbsolute(String(decision.resolvedArguments["cwd"])),
        ).toBe(true);
      }
    },
  );

  it("denies opaque command strings and obvious workspace escapes", async () => {
    const opaque = await evaluator.evaluate(
      request("trusted", "shell_execute", "execute", {
        command: "node --version",
      }),
    );
    const escaped = await evaluator.evaluate(
      request("trusted", "shell_execute", "execute", {
        program: "node",
        args: ["../outside.js"],
        cwd: ".",
      }),
    );
    const escapedMidPath = await evaluator.evaluate(
      request("trusted", "shell_execute", "execute", {
        program: "node",
        args: ["subdir/../../outside.js"],
        cwd: ".",
      }),
    );
    const escapedOutputArg = await evaluator.evaluate(
      request("trusted", "shell_execute", "execute", {
        program: "node",
        args: ["--output=subdir/../../outside.txt"],
        cwd: ".",
      }),
    );

    expect(opaque).toMatchObject({ outcome: "deny", ruleId: "input.invalid" });
    expect(escaped).toMatchObject({ outcome: "deny", ruleId: "path.escape" });
    expect(escapedMidPath).toMatchObject({ outcome: "deny", ruleId: "path.escape" });
    expect(escapedOutputArg).toMatchObject({ outcome: "deny", ruleId: "path.escape" });
  });

  it("denies every eval spelling for node and python", async () => {
    const cases: readonly JsonObject[] = [
      { program: "node", args: ["--eval=process.exit(1)"] },
      { program: "node", args: ["--print=process.version"] },
      { program: "node", args: ["-e=process.exit(1)"] },
      { program: "python", args: ["-cprint(1)"] },
      { program: "python3", args: ["-c", "print(1)"] },
    ];
    for (const arguments_ of cases) {
      const decision = await evaluator.evaluate(
        request("trusted", "shell_execute", "execute", {
          cwd: ".",
          ...arguments_,
        }),
      );
      expect(decision).toMatchObject({
        outcome: "deny",
        ruleId: "process.deny_always",
      });
    }
  });

  it("denies bare relative args that escape via symlink", async () => {
    const escaped = await evaluator.evaluate(
      request("trusted", "shell_execute", "execute", {
        program: "node",
        args: ["escape/outside.txt"],
        cwd: ".",
      }),
    );
    expect(escaped).toMatchObject({
      outcome: "deny",
      ruleId: "path.escape",
    });

    const inside = await evaluator.evaluate(
      request("trusted", "shell_execute", "execute", {
        program: "node",
        args: ["src/index.ts"],
        cwd: ".",
      }),
    );
    expect(inside.outcome).not.toBe("deny");
  });

  it("denies a call/definition mismatch and an unknown tool", async () => {
    const mismatch = await evaluator.evaluate({
      mode: "workspace",
      workspaceRoot: workspace,
      tool: definition("file_read", "read"),
      call: {
        id: "mismatch",
        name: "file_patch",
        arguments: { path: "src/index.ts" },
      },
    });
    const unknown = await evaluator.evaluate(
      request("trusted", "unknown_tool", "read", {}),
    );

    expect(mismatch).toMatchObject({
      outcome: "deny",
      ruleId: "tool.identity_mismatch",
    });
    expect(unknown).toMatchObject({
      outcome: "deny",
      ruleId: "tool.unknown",
    });
  });
});
