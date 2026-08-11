import {
  access,
  constants,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

const REJECTED_SCRIPT_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
]);

export type ExecutablePathErrorCode =
  | "EXECUTABLE_NOT_FOUND"
  | "EXECUTABLE_NOT_NATIVE"
  | "INVALID_EXECUTABLE";

export class ExecutablePathError extends Error {
  readonly code: ExecutablePathErrorCode;

  constructor(code: ExecutablePathErrorCode, message: string) {
    super(message);
    this.name = "ExecutablePathError";
    this.code = code;
  }
}

export interface ResolvedExecutable {
  readonly absolutePath: string;
  readonly insideWorkspace: boolean;
  readonly basename: string;
}

function comparable(value: string): string {
  return path.normalize(value).toLowerCase();
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function hasShebang(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, "r");
  try {
    const prefix = Buffer.alloc(2);
    const { bytesRead } = await handle.read(prefix, 0, 2, 0);
    return bytesRead === 2 && prefix[0] === 0x23 && prefix[1] === 0x21;
  } finally {
    await handle.close();
  }
}

async function inspectNativeExecutable(
  candidate: string,
): Promise<string> {
  const canonical = await realpath(candidate);
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new ExecutablePathError(
      "INVALID_EXECUTABLE",
      "program must resolve to a file",
    );
  }
  await access(
    canonical,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  const extension = path.extname(canonical).toLowerCase();
  if (
    REJECTED_SCRIPT_EXTENSIONS.has(extension) ||
    (process.platform === "win32" && extension !== ".exe") ||
    (await hasShebang(canonical))
  ) {
    throw new ExecutablePathError(
      "EXECUTABLE_NOT_NATIVE",
      "script shells, command wrappers, and shebang programs are not executable in the MVP",
    );
  }
  return canonical;
}

function pathCandidates(program: string): readonly string[] {
  if (path.isAbsolute(program)) {
    return [program];
  }
  if (
    program.includes("/") ||
    program.includes("\\") ||
    program.length === 0
  ) {
    throw new ExecutablePathError(
      "INVALID_EXECUTABLE",
      "program must be absolute or a bare executable name",
    );
  }
  const extension = path.extname(program).toLowerCase();
  if (REJECTED_SCRIPT_EXTENSIONS.has(extension)) {
    throw new ExecutablePathError(
      "EXECUTABLE_NOT_NATIVE",
      "script extensions are not allowed",
    );
  }
  const names =
    process.platform === "win32" && extension.length === 0
      ? [`${program}.exe`]
      : [program];
  return (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .flatMap((entry) => names.map((name) => path.join(entry, name)));
}

export async function resolveExecutable(
  program: string,
  workspaceRoot: string,
): Promise<ResolvedExecutable> {
  if (
    typeof program !== "string" ||
    program.length === 0 ||
    program.includes("\0")
  ) {
    throw new ExecutablePathError(
      "INVALID_EXECUTABLE",
      "program must be a non-empty string without NUL bytes",
    );
  }
  const workspace = await realpath(path.resolve(workspaceRoot));
  const explicitAbsolute = path.isAbsolute(program);
  for (const candidate of pathCandidates(program)) {
    try {
      const absolutePath = await inspectNativeExecutable(candidate);
      const insideWorkspace = isContained(workspace, absolutePath);
      // A bare name never resolves from a PATH entry inside the workspace.
      // An explicitly absolute workspace binary may still be confirmed.
      if (!explicitAbsolute && insideWorkspace) {
        continue;
      }
      return {
        absolutePath,
        insideWorkspace,
        basename: path.basename(absolutePath).toLowerCase(),
      };
    } catch (error: unknown) {
      if (
        error instanceof ExecutablePathError &&
        error.code === "EXECUTABLE_NOT_NATIVE"
      ) {
        throw error;
      }
      continue;
    }
  }
  throw new ExecutablePathError(
    "EXECUTABLE_NOT_FOUND",
    "program was not found in absolute PATH entries outside the workspace",
  );
}

export async function assertResolvedExecutable(
  program: string,
): Promise<string> {
  if (!path.isAbsolute(program)) {
    throw new ExecutablePathError(
      "INVALID_EXECUTABLE",
      "Policy must provide an absolute program path",
    );
  }
  const canonical = await inspectNativeExecutable(program);
  if (comparable(canonical) !== comparable(program)) {
    throw new ExecutablePathError(
      "INVALID_EXECUTABLE",
      "program changed after permission resolution",
    );
  }
  return canonical;
}
