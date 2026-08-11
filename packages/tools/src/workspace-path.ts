import {
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

const WINDOWS_DEVICE =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "_netrc",
  "application_default_credentials.json",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "login data",
  "token",
  "token.json",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".cer",
  ".crt",
  ".der",
  ".key",
  ".kdbx",
  ".p12",
  ".pem",
  ".pfx",
]);
const PROTECTED_PATHS = [
  ".git",
  path.join(".agent", "checkpoints"),
  path.join(".agent", "sessions"),
] as const;

export type WorkspacePathErrorCode =
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "PATH_NOT_FOUND"
  | "SENSITIVE_PATH"
  | "WORKSPACE_NOT_DIRECTORY";

export class WorkspacePathError extends Error {
  readonly code: WorkspacePathErrorCode;

  constructor(code: WorkspacePathErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
  }
}

export interface ResolveWorkspacePathOptions {
  readonly allowMissingLeaf?: boolean;
  readonly rejectSensitive?: boolean;
}

export interface ResolvedWorkspacePath {
  readonly workspaceRoot: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly sensitive: boolean;
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

function validatePortableSegments(requestedPath: string): void {
  if (requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new WorkspacePathError(
      "INVALID_PATH",
      "path must be a non-empty string without NUL bytes",
    );
  }

  const root = path.parse(requestedPath).root;
  const withoutRoot =
    root.length === 0 ? requestedPath : requestedPath.slice(root.length);

  for (const segment of withoutRoot.split(/[\\/]+/u)) {
    if (segment === "" || segment === "." || segment === "..") {
      continue;
    }
    if (
      WINDOWS_DEVICE.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      segment.includes(":")
    ) {
      throw new WorkspacePathError(
        "INVALID_PATH",
        `path contains a non-portable segment: ${segment}`,
      );
    }
  }
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const segments = relativePath
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? "";
  const extension = path.extname(basename);

  return (
    segments.includes(".ssh") ||
    segments.includes(".gnupg") ||
    segments.includes(".aws") ||
    segments.includes(".azure") ||
    segments.includes(".docker") ||
    segments.includes(".kube") ||
    (segments.includes(".config") && segments.includes("gcloud")) ||
    SENSITIVE_BASENAMES.has(basename) ||
    SENSITIVE_EXTENSIONS.has(extension) ||
    basename.startsWith(".env.")
  );
}

export function isProtectedWorkspacePath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath);
  // This intentionally case-folds on every platform. It is conservative on
  // case-sensitive filesystems and safe on Windows and default macOS volumes.
  const comparable = normalized.toLowerCase();
  return PROTECTED_PATHS.some((protectedPath) => {
    const protectedNormalized = path.normalize(protectedPath);
    const protectedComparable = protectedNormalized.toLowerCase();
    return (
      comparable === protectedComparable ||
      comparable.startsWith(`${protectedComparable}${path.sep}`)
    );
  });
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const canonical = await realpath(path.resolve(workspaceRoot));
  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new WorkspacePathError(
      "WORKSPACE_NOT_DIRECTORY",
      "workspaceRoot must resolve to a directory",
    );
  }
  return canonical;
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  options: ResolveWorkspacePathOptions = {},
): Promise<ResolvedWorkspacePath> {
  validatePortableSegments(requestedPath);
  const canonicalRoot = await canonicalWorkspaceRoot(workspaceRoot);
  const lexicalTarget = path.resolve(canonicalRoot, requestedPath);

  if (!isContained(canonicalRoot, lexicalTarget)) {
    throw new WorkspacePathError(
      "PATH_ESCAPE",
      "requested path resolves outside the workspace",
    );
  }

  let absolutePath: string;
  let exists = true;

  try {
    await lstat(lexicalTarget);
    absolutePath = await realpath(lexicalTarget);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT" || options.allowMissingLeaf !== true) {
      throw new WorkspacePathError(
        "PATH_NOT_FOUND",
        "requested path does not exist",
      );
    }

    const lexicalParent = path.dirname(lexicalTarget);
    const canonicalParent = await realpath(lexicalParent).catch(() => {
      throw new WorkspacePathError(
        "PATH_NOT_FOUND",
        "parent directory does not exist",
      );
    });
    absolutePath = path.join(canonicalParent, path.basename(lexicalTarget));
    exists = false;
  }

  if (!isContained(canonicalRoot, absolutePath)) {
    throw new WorkspacePathError(
      "PATH_ESCAPE",
      "requested path follows a link outside the workspace",
    );
  }

  const relativePath = path.relative(canonicalRoot, absolutePath);
  const sensitive = isSensitiveRelativePath(relativePath);
  if (sensitive && options.rejectSensitive === true) {
    throw new WorkspacePathError(
      "SENSITIVE_PATH",
      "sensitive credential paths are not available to tools",
    );
  }

  return {
    workspaceRoot: canonicalRoot,
    absolutePath,
    relativePath,
    exists,
    sensitive,
  };
}
