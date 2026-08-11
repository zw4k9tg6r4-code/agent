import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeProcess } from "../src/index.js";

function program(name: string): string {
  return path.join(path.parse(process.cwd()).root, "system", name);
}

describe("analyzeProcess", () => {
  it.each([
    ["node", ["--version"], false, "read_only"],
    ["whoami", [], false, "read_only"],
    ["node", ["--check", "src/index.js"], false, "local_low_risk"],
    ["git", ["status", "--short"], false, "ambiguous"],
    ["node", ["src/test.js"], false, "ambiguous"],
    ["npm", ["install", "left-pad"], false, "install"],
    ["curl", ["https://example.com"], false, "network"],
    ["git", ["push", "origin", "main"], false, "git_remote"],
    ["rm", ["-r", "build"], false, "delete"],
    ["unknown", ["value"], false, "ambiguous"],
  ] as const)(
    "classifies %s %j insideWorkspace=%s as %s",
    (name, args, insideWorkspace, expected) => {
      expect(
        analyzeProcess(program(name), args, insideWorkspace).impact,
      ).toBe(expected);
    },
  );

  it.each([
    ["node", ["-e", "process.exit(0)"]],
    ["powershell.exe", ["-Command", "Get-ChildItem"]],
    ["node", ["src/test.js", "&&", "curl"]],
    ["git", ["show", ".env"]],
    ["rm", ["-rf", "/"]],
    ["rm", ["--recursive", "--force", "C:\\"]],
  ] as const)("marks shell, credential, or broad destruction deny-grade", (
    name,
    args,
  ) => {
    expect(analyzeProcess(program(name), args, false)).toMatchObject({
      impact: "destructive",
      denyAlways: true,
    });
  });

  it("never silently trusts an executable located in the workspace", () => {
    expect(analyzeProcess(program("node"), ["--version"], true)).toMatchObject({
      impact: "ambiguous",
      workspaceExecutable: true,
    });
  });
});
