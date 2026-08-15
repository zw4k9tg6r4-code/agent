import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import path from "node:path";

const STREAM_CAPTURE_LIMIT_BYTES = 48 * 1024;
const PREFIX_RATIO = 0.6;
const CAPTURE_MARKER = "\n...[output truncated]...\n";

function decodePrefix(buffer: Buffer): string {
  for (let trim = 0; trim <= 3 && trim <= buffer.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, buffer.length - trim),
      );
    } catch {
      continue;
    }
  }
  return "";
}

function decodeSuffix(buffer: Buffer): string {
  for (let trim = 0; trim <= 3 && trim <= buffer.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(trim),
      );
    } catch {
      continue;
    }
  }
  return "";
}

class BoundedByteCollector {
  readonly #limit: number;
  readonly #prefixLimit: number;
  readonly #suffixLimit: number;
  #prefix = Buffer.alloc(0);
  #suffix = Buffer.alloc(0);
  #totalBytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
    this.#prefixLimit = Math.floor(limit * PREFIX_RATIO);
    this.#suffixLimit = limit - this.#prefixLimit;
  }

  append(chunk: Buffer): void {
    this.#totalBytes += chunk.length;
    if (this.#prefix.length < this.#limit) {
      const remaining = this.#limit - this.#prefix.length;
      this.#prefix = Buffer.concat([
        this.#prefix,
        chunk.subarray(0, remaining),
      ]);
    }
    const combined = Buffer.concat([this.#suffix, chunk]);
    this.#suffix =
      combined.length <= this.#suffixLimit
        ? combined
        : combined.subarray(combined.length - this.#suffixLimit);
  }

  finish(): {
    readonly text: string;
    readonly totalBytes: number;
    readonly truncated: boolean;
  } {
    if (this.#totalBytes <= this.#limit) {
      return {
        text: decodePrefix(this.#prefix),
        totalBytes: this.#totalBytes,
        truncated: false,
      };
    }
    return {
      text:
        decodePrefix(this.#prefix.subarray(0, this.#prefixLimit)) +
        CAPTURE_MARKER +
        decodeSuffix(this.#suffix),
      totalBytes: this.#totalBytes,
      truncated: true,
    };
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed =
    process.platform === "win32"
      ? ["ComSpec", "PATHEXT", "PATH", "SystemRoot", "TEMP", "TMP"]
      : ["LANG", "LC_ALL", "PATH", "TMPDIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function sensitiveParentValues(): readonly string[] {
  const sensitiveName =
    /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/iu;
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        sensitiveName.test(name) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function redactExactValues(
  text: string,
  sensitiveValues: readonly string[],
): string {
  return sensitiveValues.reduce(
    (current, value) => current.replaceAll(value, "[REDACTED]"),
    text,
  );
}

function childClosed(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childClosed(child)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(childClosed(child));
    }, timeoutMs);
    timer.unref();
    child.once("close", onClose);
  });
}

async function runTaskkill(pid: number): Promise<boolean> {
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined) {
    return false;
  }
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const killer = spawn(taskkill, ["/pid", String(pid), "/t", "/f"], {
      env: minimalEnvironment(),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 2_000);
    timer.unref();
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

async function terminateWindowsTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined || childClosed(child)) {
    return true;
  }
  const taskkillSucceeded = await runTaskkill(pid);
  if (!taskkillSucceeded && !childClosed(child)) {
    child.kill();
  }
  return waitForChildClose(child, 1_500);
}

async function terminatePosixTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined || childClosed(child)) {
    return true;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForChildClose(child, 500)) {
    return true;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return waitForChildClose(child, 1_500);
}

async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  return process.platform === "win32"
    ? terminateWindowsTree(child)
    : terminatePosixTree(child);
}

export interface ExecuteProcessOptions {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface ShellProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminationFailed: boolean;
  readonly durationMs: number;
  readonly spawnError?: string;
}

export async function executeProcess(
  options: ExecuteProcessOptions,
): Promise<ShellProcessResult> {
  if (options.signal.aborted) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      timedOut: false,
      cancelled: true,
      terminationFailed: false,
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const sensitiveValues = sensitiveParentValues();
  const stdout = new BoundedByteCollector(STREAM_CAPTURE_LIMIT_BYTES);
  const stderr = new BoundedByteCollector(STREAM_CAPTURE_LIMIT_BYTES);
  const child = spawn(options.program, [...options.args], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: minimalEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise<ShellProcessResult>((resolve) => {
    let cancelled = false;
    let timedOut = false;
    let terminationFailed = false;
    let spawnError: string | undefined;
    let terminationStarted = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal.removeEventListener("abort", onAbort);
      if (terminationFailed) {
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      const stdoutResult = stdout.finish();
      const stderrResult = stderr.finish();
      const base = {
        exitCode,
        signal,
        stdout: redactExactValues(stdoutResult.text, sensitiveValues),
        stderr: redactExactValues(stderrResult.text, sensitiveValues),
        stdoutBytes: stdoutResult.totalBytes,
        stderrBytes: stderrResult.totalBytes,
        truncated: stdoutResult.truncated || stderrResult.truncated,
        timedOut,
        cancelled,
        terminationFailed,
        durationMs: Date.now() - startedAt,
      };
      resolve(
        spawnError === undefined
          ? base
          : {
              ...base,
              spawnError,
            },
      );
    };

    const terminate = (): void => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      void terminateProcessTree(child)
        .catch(() => false)
        .then((terminated) => {
        if (!terminated) {
          terminationFailed = true;
          finish(child.exitCode, child.signalCode);
        }
      });
    };
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }

    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}
