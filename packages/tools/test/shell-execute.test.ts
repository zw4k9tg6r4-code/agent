import {
  mkdtemp,
  readFile,
  realpath,
  rm,
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
  runShellExecute,
  SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
} from "../src/index.js";

let workspace = "";
let nodeProgram = "";
let cwdScript = "";
let environmentScript = "";
let literalSecretScript = "";
let outputScript = "";
let waitScript = "";
const checkpoints: CheckpointStore = {
  async capture() {},
  async restore() {
    return { restoredPaths: [], removedPaths: [] };
  },
};

function call(arguments_: JsonObject): ToolCall {
  return {
    id: "call-shell",
    name: "shell_execute",
    arguments: arguments_,
  };
}

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    workspaceRoot: workspace,
    sessionId: "session-shell",
    signal,
    checkpoints,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-shell-"));
  nodeProgram = await realpath(process.execPath);
  cwdScript = path.join(workspace, "cwd.cjs");
  environmentScript = path.join(workspace, "environment.cjs");
  literalSecretScript = path.join(workspace, "literal-secret.cjs");
  outputScript = path.join(workspace, "output.cjs");
  waitScript = path.join(workspace, "wait.cjs");
  await Promise.all([
    writeFile(cwdScript, "process.stdout.write(process.cwd());\n"),
    writeFile(
      environmentScript,
      "process.stdout.write(process.env.AGENT_TEST_FAKE_API_KEY || 'missing');\n",
    ),
    writeFile(
      literalSecretScript,
      "process.stdout.write('fake-secret-never-log');\n",
    ),
    writeFile(
      outputScript,
      "process.stdout.write('BEGIN-' + 'x'.repeat(200000) + '-END');\n",
    ),
    writeFile(waitScript, "setInterval(() => {}, 1000);\n"),
  ]);
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("runShellExecute", () => {
  it("runs in the canonical workspace and preserves the call ID", async () => {
    const result = await runShellExecute(
      call({
        program: nodeProgram,
        args: [cwdScript],
        cwd: ".",
        timeoutMs: 10_000,
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      toolCallId: "call-shell",
      metadata: {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      },
    });
    expect(path.resolve(result.output.trim())).toBe(path.resolve(workspace));
  });

  it("does not inherit an injected API key", async () => {
    const previous = process.env["AGENT_TEST_FAKE_API_KEY"];
    process.env["AGENT_TEST_FAKE_API_KEY"] = "fake-secret-never-log";
    try {
      const result = await runShellExecute(
        call({
          program: nodeProgram,
          args: [environmentScript],
        }),
        context(),
      );

      expect(result.output).toContain("missing");
      expect(result.output).not.toContain("fake-secret-never-log");
    } finally {
      if (previous === undefined) {
        delete process.env["AGENT_TEST_FAKE_API_KEY"];
      } else {
        process.env["AGENT_TEST_FAKE_API_KEY"] = previous;
      }
    }
  });

  it("redacts an exact secret-named parent value from captured output", async () => {
    const previous = process.env["AGENT_TEST_FAKE_API_KEY"];
    process.env["AGENT_TEST_FAKE_API_KEY"] = "fake-secret-never-log";
    try {
      const result = await runShellExecute(
        call({
          program: nodeProgram,
          args: [literalSecretScript],
        }),
        context(),
      );

      expect(result.output).toContain("[REDACTED]");
      expect(result.output).not.toContain("fake-secret-never-log");
    } finally {
      if (previous === undefined) {
        delete process.env["AGENT_TEST_FAKE_API_KEY"];
      } else {
        process.env["AGENT_TEST_FAKE_API_KEY"] = previous;
      }
    }
  });

  it("bounds continuous stdout while keeping prefix and suffix", async () => {
    const result = await runShellExecute(
      call({
        program: nodeProgram,
        args: [outputScript],
      }),
      context(),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("BEGIN-");
    expect(result.output).toContain("-END");
    expect(result.output).toContain("...[output truncated]...");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(
      SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
    );
  });

  it("cancels a long-running command and returns a structured failure", async () => {
    const controller = new AbortController();
    const execution = runShellExecute(
      call({
        program: nodeProgram,
        args: [waitScript],
        timeoutMs: 10_000,
      }),
      context(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);

    const result = await execution;

    expect(result).toMatchObject({
      ok: false,
      toolCallId: "call-shell",
      error: { code: "CANCELLED" },
      metadata: { cancelled: true },
    });
  });

  it("times out a long-running command", async () => {
    const result = await runShellExecute(
      call({
        program: nodeProgram,
        args: [waitScript],
        timeoutMs: 100,
      }),
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROCESS_TIMEOUT" },
      metadata: { timedOut: true },
    });
  });

  it.runIf(process.platform === "win32")(
    "kills a spawned Windows child process tree",
    async () => {
      const marker = path.join(workspace, "child-survived.txt");
      const childScript = path.join(workspace, "child.cjs");
      const parentScript = path.join(workspace, "parent.cjs");
      await writeFile(
        childScript,
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
          marker,
        )}, "survived"), 1000); setInterval(() => {}, 1000);`,
      );
      await writeFile(
        parentScript,
        `require("node:child_process").spawn(process.execPath, [${JSON.stringify(
          childScript,
        )}], { detached: false }); setInterval(() => {}, 1000);`,
      );
      const controller = new AbortController();
      const execution = runShellExecute(
        call({
          program: nodeProgram,
          args: [parentScript],
          timeoutMs: 10_000,
        }),
        context(controller.signal),
      );
      setTimeout(() => controller.abort(), 150);

      const result = await execution;
      expect(result).toMatchObject({
        ok: false,
        error: { code: "CANCELLED" },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects eval flags and opaque command input", async () => {
    const evalResult = await runShellExecute(
      call({
        program: nodeProgram,
        args: ["-e", "process.exit(0)"],
      }),
      context(),
    );
    const opaqueResult = await runShellExecute(
      call({ command: "node -e \"process.exit(0)\"" }),
      context(),
    );

    expect(evalResult).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(opaqueResult).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});
