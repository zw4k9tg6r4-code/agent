# Agent Tools and Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build four cancellable, bounded-output local tools plus a deny-by-default permission engine that keeps file actions inside the approved workspace and executes only explicitly resolved, direct processes on Windows, macOS, and Linux.

**Architecture:** `@agent/tools` owns filesystem/direct-process execution, canonical workspace-path resolution, output bounding, and the frozen `CheckpointStore` implementation. `@agent/policy` consumes public `@agent/tools` path and executable-resolution APIs plus frozen `@agent/contracts` permission types; Core evaluates permission, preserves the original `ToolCall.id`, and passes only `resolvedArguments` to `Tool.execute`. `shell_execute` never invokes a shell: Policy resolves `program` without searching the workspace or current directory, writes its canonical absolute path into `resolvedArguments`, and Tools spawns it with `shell: false`. All dangerous classifications fail closed, and tools repeat the relevant canonical checks immediately before I/O.

**Tech Stack:** Node.js 22+, TypeScript 7.0.2 strict mode, npm Workspaces, Vitest 4.1.10, Node `fs/promises`, `child_process`, `crypto`, and ESM/NodeNext.

## Frozen Contract Gate

- This plan consumes the post-review foundation signatures exactly: `Tool.execute(call: ToolCall, context: ToolExecutionContext)`, `ToolExecutionContext.checkpoints`, `CheckpointStore`, `PermissionRequest.call`, and discriminated allow/ask decisions with `resolvedArguments`.
- `ToolResult.toolCallId` is always copied from the original `ToolCall.id`.
- Policy writes canonical absolute file paths, a canonical absolute executable, and normalized argument arrays into `resolvedArguments`; Core must preserve `ToolCall.id` while replacing only `ToolCall.arguments` before execution.
- `file_patch` captures the first pre-image through the injected frozen `CheckpointStore`.
- There are no remaining blocking contract gaps for `packages/tools/**` or `packages/policy/**`.
- A residual time-of-check/time-of-use window remains if a hostile local process swaps a directory after policy resolution and before tool I/O. Tools repeat canonical resolution immediately before I/O, but the MVP must not claim OS-level hostile-process isolation.

## Global Constraints

- TypeScript strict mode is mandatory.
- Node.js 22 is the minimum supported runtime; the local verification runtime is Node.js 24.18.0.
- Windows commands shown to the user must use `npm.cmd`; do not change the PowerShell execution policy.
- Runtime source uses ESM and `NodeNext` module resolution.
- `@agent/tools` and `@agent/policy` import shared interface types only from `@agent/contracts`; no package may import another package's internal `src/` path.
- Root `package.json`, root TypeScript/Vitest configuration, `package-lock.json`, `packages/contracts/`, `tests/integration/`, `benchmarks/`, and the approved design remain owned by the main task.
- Public implementation-package entry points are `@agent/tools` and `@agent/policy`; `@agent/policy` may consume the public path resolver from `@agent/tools`, never its internals.
- There are no third-party runtime dependencies; use Node.js standard-library APIs.
- Every path is made absolute, `..` is resolved, symlinks or Windows reparse points are resolved with `realpath`, and containment is checked before authorization and again before I/O.
- Sensitive files such as `.env`, private keys, certificates, credential stores, and common token files are denied even in `trusted`.
- `readonly` permits workspace reads/search only; `workspace` permits patch writes and low-risk local commands; `trusted` reduces confirmation but never permits workspace escape, credential reads, broad destructive deletion, or unapproved upload.
- Ambiguous command syntax fails closed to `ask` in `workspace` and `trusted`, and to `deny` in `readonly`.
- `shell_execute` accepts `{ program, args, cwd?, timeoutMs? }`; an opaque command string, `.cmd`, `.bat`, `.ps1`, `.sh`, shebang script, shell interpreter, eval flag, compound token, or redirection token is rejected.
- `workspace` silently allows only an extremely small exact read-only native-process allowlist. Project scripts, Git operations that may run hooks or filters, and all other direct processes require confirmation. `trusted` additionally allows only exact, recognized low-risk direct-process shapes; install, network, Git remote mutation, deletion, and unknown processes still require confirmation.
- Every process has an explicit positive timeout and supports `AbortSignal`; cancellation verifies process-tree termination on Windows as well as POSIX and returns a bounded termination failure instead of hanging.
- Tool output limits are measured in UTF-8 bytes and preserve a prefix, suffix, and explicit truncation marker.
- `shell_execute` does not inherit secret-named environment variables and redacts exact secret-named parent values from captured stdout/stderr; Core still performs generic recursive redaction before model feedback or event persistence.
- `file_patch` accepts explicit, optimistic search/replace edits or explicit new-file content; it never silently overwrites an unknown existing file.
- File writes create a per-session pre-image checkpoint before mutation and use temp-file-plus-rename replacement in the same directory.
- All metadata crossing the contract boundary is `JsonObject`-safe.
- Every implementation task follows red-green TDD and ends in an independently reviewable commit.
- The approved design is `docs/superpowers/specs/2026-07-20-general-agent-runtime-design.md`.

---

## Locked File Map

| Path | Responsibility |
| --- | --- |
| `packages/tools/package.json` | `@agent/tools` metadata and package-local commands. |
| `packages/tools/tsconfig.json` | Strict source/test type-checking. |
| `packages/tools/tsconfig.build.json` | ESM build and declaration output. |
| `packages/tools/src/tool-result.ts` | Exact `ToolResult` success/failure construction with call-ID preservation and bounded metadata. |
| `packages/tools/src/output.ts` | UTF-8 byte-aware prefix/suffix output truncation. |
| `packages/tools/src/workspace-path.ts` | Canonical path resolution, link/reparse-point containment, portable path checks, and sensitive-path detection. |
| `packages/tools/src/file-read.ts` | Validated bounded text-file reads. |
| `packages/tools/src/file-search.ts` | Deterministic recursive text search that skips links and sensitive/binary files. |
| `packages/tools/src/atomic-file.ts` | Same-directory temp-file, fsync, rename, and cleanup helper. |
| `packages/tools/src/checkpoints.ts` | Atomic per-session pre-image creation, listing, and restore. |
| `packages/tools/src/file-patch.ts` | Explicit optimistic edits and atomic file replacement. |
| `packages/tools/src/executable-path.ts` | Resolve direct executables from absolute PATH entries without searching `cwd`, and reject script shells. |
| `packages/tools/src/shell-process.ts` | Cross-platform direct-process spawning, timeout/cancellation, verified tree termination, and bounded capture. |
| `packages/tools/src/shell-execute.ts` | Validated structured process operation using the internal process runner. |
| `packages/tools/src/builtin-tools.ts` | Frozen adapters from the four public definitions to their runners. |
| `packages/tools/src/definitions.ts` | Exact `ToolDefinition` values and JSON schemas for the four built-ins. |
| `packages/tools/src/index.ts` | Public tools exports; Task 8 adds `createBuiltinTools`. |
| `packages/tools/test/*.test.ts` | Unit and Windows-aware security tests for tool behavior. |
| `packages/policy/package.json` | `@agent/policy` metadata and package-local commands. |
| `packages/policy/tsconfig.json` | Strict source/test type-checking. |
| `packages/policy/tsconfig.build.json` | ESM build and declaration output. |
| `packages/policy/vitest.config.ts` | Package-local V8 coverage scope and enforced branch threshold. |
| `packages/policy/src/process-risk.ts` | Conservative structured-process classification and exact argument-shape facts. |
| `packages/policy/src/default-permission-evaluator.ts` | Exact `readonly`/`workspace`/`trusted` allow/ask/deny matrix. |
| `packages/policy/src/index.ts` | Public policy exports. |
| `packages/policy/test/*.test.ts` | Branch and security matrix tests. |

No task in this plan edits a main-task-owned path.

### Task 1: Bootstrap both packages and implement bounded UTF-8 output

**Files:**

- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/tsconfig.build.json`
- Create: `packages/policy/package.json`
- Create: `packages/policy/tsconfig.json`
- Create: `packages/policy/tsconfig.build.json`
- Create: `packages/policy/vitest.config.ts`
- Create: `packages/tools/test/output.test.ts`
- Create after RED: `packages/tools/src/output.ts`
- Create after RED: `packages/tools/src/tool-result.ts`
- Create after RED: `packages/tools/src/index.ts`
- Create: `packages/policy/src/index.ts`

**Interfaces:**

- Consumes frozen `JsonObject`, `ToolCall`, `ToolError`, and `ToolResult` from `@agent/contracts`.
- Produces `truncateUtf8(text: string, limitBytes: number): TruncatedText`.
- Produces exact `toolSuccess(call, output, metadata?)` and `toolFailure(call, code, message, retryable?)` constructors.

- [ ] **Step 1: Create package-local configuration**

Create `packages/tools/package.json`:

```json
{
  "name": "@agent/tools",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "dependencies": {
    "@agent/contracts": "0.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run test --config vitest.config.ts"
  }
}
```

Create `packages/tools/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": [
      "node",
      "vitest/globals"
    ]
  },
  "include": [
    "src/**/*.ts",
    "test/**/*.ts"
  ]
}
```

Create `packages/tools/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "incremental": true,
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": [
    "src/**/*.ts"
  ],
  "exclude": [
    "test/**/*.ts"
  ]
}
```

Create `packages/policy/package.json`:

```json
{
  "name": "@agent/policy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "dependencies": {
    "@agent/contracts": "0.0.0",
    "@agent/tools": "0.0.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run test"
  }
}
```

Create `packages/policy/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": [
      "node",
      "vitest/globals"
    ]
  },
  "include": [
    "src/**/*.ts",
    "test/**/*.ts"
  ]
}
```

Create `packages/policy/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "incremental": true,
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": [
    "src/**/*.ts"
  ],
  "exclude": [
    "test/**/*.ts"
  ]
}
```

Create `packages/policy/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        branches: 80,
      },
    },
  },
});
```

Create `packages/policy/src/index.ts`:

```ts
export {};
```

- [ ] **Step 2: Link the new workspaces without changing the root-owned lockfile**

Run:

```powershell
npm.cmd install --package-lock=false --ignore-scripts
git diff --exit-code -- package-lock.json
npm.cmd run build --workspace @agent/contracts
Test-Path packages/contracts/dist/index.d.ts
```

Expected: every command exits `0`; npm creates local workspace links under ignored `node_modules`, `package-lock.json` remains unchanged, and the frozen Contracts declarations exist before either new package is type-checked. A new Git worktree must not rely on ignored `dist/` files from another worktree.

- [ ] **Step 3: Write the failing byte-boundary tests**

Create `packages/tools/test/output.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { truncateUtf8 } from "../src/index.js";

describe("truncateUtf8", () => {
  it("returns short text unchanged", () => {
    expect(truncateUtf8("hello", 64)).toEqual({
      output: "hello",
      originalBytes: 5,
      outputBytes: 5,
      truncated: false,
    });
  });

  it("keeps the prefix, suffix, marker, and byte limit", () => {
    const result = truncateUtf8(
      `BEGIN-${"中".repeat(80)}-END`,
      96,
    );

    expect(result.truncated).toBe(true);
    expect(result.output.startsWith("BEGIN-")).toBe(true);
    expect(result.output.endsWith("-END")).toBe(true);
    expect(result.output).toContain("...[output truncated]...");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(96);
    expect(result.output).not.toContain("\uFFFD");
  });

  it("rejects unusable byte limits", () => {
    expect(() => truncateUtf8("hello", 31)).toThrow(
      "limitBytes must be an integer of at least 32",
    );
  });
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- packages/tools/test/output.test.ts
```

Expected: FAIL because `packages/tools/src/index.ts` does not export `truncateUtf8`.

- [ ] **Step 5: Implement complete byte-aware truncation**

Create `packages/tools/src/output.ts`:

```ts
const TRUNCATION_MARKER = "\n...[output truncated]...\n";
const MINIMUM_LIMIT_BYTES = 32;

export interface TruncatedText {
  readonly output: string;
  readonly originalBytes: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
}

function takeStartByBytes(text: string, budget: number): string {
  let used = 0;
  let result = "";

  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > budget) {
      break;
    }
    result += character;
    used += bytes;
  }

  return result;
}

function takeEndByBytes(text: string, budget: number): string {
  const characters = Array.from(text);
  let used = 0;
  let result = "";

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (character === undefined) {
      continue;
    }
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > budget) {
      break;
    }
    result = character + result;
    used += bytes;
  }

  return result;
}

export function truncateUtf8(
  text: string,
  limitBytes: number,
): TruncatedText {
  if (!Number.isInteger(limitBytes) || limitBytes < MINIMUM_LIMIT_BYTES) {
    throw new RangeError("limitBytes must be an integer of at least 32");
  }

  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= limitBytes) {
    return {
      output: text,
      originalBytes,
      outputBytes: originalBytes,
      truncated: false,
    };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const contentBudget = limitBytes - markerBytes;
  const prefixBudget = Math.ceil(contentBudget * 0.6);
  const suffixBudget = contentBudget - prefixBudget;
  const output =
    takeStartByBytes(text, prefixBudget) +
    TRUNCATION_MARKER +
    takeEndByBytes(text, suffixBudget);

  return {
    output,
    originalBytes,
    outputBytes: Buffer.byteLength(output, "utf8"),
    truncated: true,
  };
}
```

Create `packages/tools/src/tool-result.ts`:

```ts
import type {
  JsonObject,
  ToolCall,
  ToolFailure,
  ToolSuccess,
} from "@agent/contracts";

export function toolFailure(
  call: ToolCall,
  code: string,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly output?: string;
    readonly metadata?: JsonObject;
  } = {},
): ToolFailure {
  const result: ToolFailure = {
    toolCallId: call.id,
    ok: false,
    output: options.output ?? "",
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
    },
    ...(options.metadata === undefined
      ? {}
      : { metadata: options.metadata }),
  };
  return result;
}

export function toolSuccess(
  call: ToolCall,
  output: string,
  metadata?: JsonObject,
): ToolSuccess {
  return metadata === undefined
    ? {
        toolCallId: call.id,
        ok: true,
        output,
      }
    : {
        toolCallId: call.id,
        ok: true,
        output,
        metadata,
      };
}
```

Create `packages/tools/src/index.ts`:

```ts
export {
  truncateUtf8,
  type TruncatedText,
} from "./output.js";
export {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
```

- [ ] **Step 6: Run package checks and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd test -- packages/tools/test/output.test.ts
npm.cmd run build --workspace @agent/tools
```

Expected: all commands exit `0`; three tests pass; `packages/tools/dist/index.js` and declarations are emitted.

- [ ] **Step 7: Commit package bootstrap and output bounding**

```powershell
git add packages/tools packages/policy
git commit -m "build: bootstrap tools and policy packages"
```

### Task 2: Canonicalize workspace paths and deny links, reparse escapes, and credentials

**Files:**

- Create: `packages/tools/test/workspace-path.test.ts`
- Create after RED: `packages/tools/src/workspace-path.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**

- Produces `resolveWorkspacePath(workspaceRoot, requestedPath, options): Promise<ResolvedWorkspacePath>`.
- Produces `isSensitiveRelativePath(relativePath): boolean`.
- Produces error codes `INVALID_PATH`, `WORKSPACE_NOT_DIRECTORY`, `PATH_NOT_FOUND`, `PATH_ESCAPE`, `SENSITIVE_PATH`.
- Windows behavior includes case-insensitive reserved device names, trailing dots/spaces, alternate data streams, junctions, and directory symlinks.

- [ ] **Step 1: Write failing boundary and secret tests**

Create `packages/tools/test/workspace-path.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the path test and verify RED**

Run:

```powershell
npm.cmd test -- packages/tools/test/workspace-path.test.ts
```

Expected: FAIL because the workspace-path exports do not exist.

- [ ] **Step 3: Implement canonical containment and sensitive-path classification**

Create `packages/tools/src/workspace-path.ts`:

```ts
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
```

Append to `packages/tools/src/index.ts`:

```ts
export {
  isProtectedWorkspacePath,
  isSensitiveRelativePath,
  resolveWorkspacePath,
  WorkspacePathError,
  type ResolvedWorkspacePath,
  type ResolveWorkspacePathOptions,
  type WorkspacePathErrorCode,
} from "./workspace-path.js";
```

- [ ] **Step 4: Run boundary verification and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd test -- packages/tools/test/workspace-path.test.ts
```

Expected: all tests pass; on Windows the junction and Windows-specific cases run, while other platforms skip only the Windows device-name case.

- [ ] **Step 5: Commit canonical workspace boundaries**

```powershell
git add packages/tools/src packages/tools/test/workspace-path.test.ts
git commit -m "feat: enforce canonical workspace paths"
```

### Task 3: Read and search workspace text without leaking sensitive or linked content

**Files:**

- Create: `packages/tools/test/file-read-search.test.ts`
- Create after RED: `packages/tools/src/file-read.ts`
- Create after RED: `packages/tools/src/file-search.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**

- Produces `runFileRead(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>`.
- Produces `runFileSearch(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>`.
- Consumes exact frozen `ToolCall` and `ToolExecutionContext { workspaceRoot; sessionId; signal; checkpoints }`.
- Both functions preserve `call.id` in every success/failure and do not throw expected user/input/path errors.

- [ ] **Step 1: Write failing read/search behavior and leak-prevention tests**

Create `packages/tools/test/file-read-search.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- packages/tools/test/file-read-search.test.ts
```

Expected: FAIL because `runFileRead` and `runFileSearch` are not exported.

- [ ] **Step 3: Implement the bounded file-read operation**

Create `packages/tools/src/file-read.ts`:

```ts
import { stat, readFile } from "node:fs/promises";

import type {
  JsonObject,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
import { truncateUtf8 } from "./output.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const FILE_READ_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;

function optionalPositiveInteger(
  input: JsonObject,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return value;
}

function requestedPath(input: JsonObject): string {
  const value = input["path"];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  return value;
}

function pathFailure(
  call: ToolCall,
  error: WorkspacePathError,
): ToolResult {
  return toolFailure(call, error.code, error.message);
}

export async function runFileRead(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file read was cancelled");
    }

    const pathInput = requestedPath(call.arguments);
    const startLine =
      optionalPositiveInteger(call.arguments, "startLine") ?? 1;
    const requestedEndLine = optionalPositiveInteger(
      call.arguments,
      "endLine",
    );
    if (requestedEndLine !== undefined && requestedEndLine < startLine) {
      return toolFailure(
        call,
        "INVALID_INPUT",
        "endLine must be greater than or equal to startLine",
      );
    }

    const resolved = await resolveWorkspacePath(
      context.workspaceRoot,
      pathInput,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(resolved.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be read",
      );
    }
    const details = await stat(resolved.absolutePath);
    if (!details.isFile()) {
      return toolFailure(
        call,
        "NOT_A_FILE",
        "path must resolve to a file",
      );
    }
    if (details.size > MAX_SOURCE_FILE_BYTES) {
      return toolFailure(
        call,
        "FILE_TOO_LARGE",
        `file exceeds ${MAX_SOURCE_FILE_BYTES} bytes`,
      );
    }

    const bytes = await readFile(resolved.absolutePath, {
      signal: context.signal,
    });
    if (bytes.includes(0)) {
      return toolFailure(
        call,
        "BINARY_FILE",
        "binary files are not available through file_read",
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return toolFailure(
        call,
        "INVALID_UTF8",
        "file_read accepts UTF-8 text files only",
      );
    }

    const lines = text.replace(/\r\n/gu, "\n").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    const effectiveEnd = Math.min(
      requestedEndLine ?? lines.length,
      lines.length,
    );
    const selected =
      startLine > lines.length
        ? ""
        : lines.slice(startLine - 1, effectiveEnd).join("\n");
    const bounded = truncateUtf8(selected, FILE_READ_OUTPUT_LIMIT_BYTES);

    return toolSuccess(
      call,
      bounded.output,
      {
        path: resolved.relativePath,
        bytes: details.size,
        startLine,
        endLine: effectiveEnd,
        truncated: bounded.truncated,
        originalOutputBytes: bounded.originalBytes,
      },
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return pathFailure(call, error);
    }
    if (
      context.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return toolFailure(call, "CANCELLED", "file read was cancelled");
    }
    if (error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown file read failure";
    return toolFailure(call, "FILE_READ_FAILED", message);
  }
}
```

- [ ] **Step 4: Implement deterministic recursive text search**

Create `packages/tools/src/file-search.ts`:

```ts
import {
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";

import type {
  JsonObject,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
import { truncateUtf8 } from "./output.js";
import {
  isProtectedWorkspacePath,
  isSensitiveRelativePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const FILE_SEARCH_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "checkpoints",
  "coverage",
  "dist",
  "node_modules",
  "sessions",
]);

interface SearchInput {
  readonly query: string;
  readonly path: string;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
}

interface SearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

interface SearchBudget {
  files: number;
  totalBytes: number;
}

class SearchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchLimitError";
  }
}

function accountSearchFile(budget: SearchBudget, size: number): void {
  budget.files += 1;
  budget.totalBytes += size;
  if (
    budget.files > MAX_SEARCH_FILES ||
    budget.totalBytes > MAX_SEARCH_TOTAL_BYTES
  ) {
    throw new SearchLimitError(
      `search exceeds ${MAX_SEARCH_FILES} files or ${MAX_SEARCH_TOTAL_BYTES} bytes`,
    );
  }
}

function parseSearchInput(input: JsonObject): SearchInput {
  const query = input["query"];
  const pathInput = input["path"] ?? ".";
  const caseSensitive = input["caseSensitive"] ?? false;
  const maxResults = input["maxResults"] ?? DEFAULT_MAX_RESULTS;

  if (
    typeof query !== "string" ||
    query.length === 0 ||
    query.length > 1_024
  ) {
    throw new TypeError("query must contain 1 through 1024 characters");
  }
  if (typeof pathInput !== "string" || pathInput.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  if (typeof caseSensitive !== "boolean") {
    throw new TypeError("caseSensitive must be a boolean");
  }
  if (
    typeof maxResults !== "number" ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > MAX_RESULTS
  ) {
    throw new TypeError(
      `maxResults must be an integer between 1 and ${MAX_RESULTS}`,
    );
  }

  return {
    query,
    path: pathInput,
    caseSensitive,
    maxResults,
  };
}

function matcherFor(input: SearchInput): RegExp {
  const source = input.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(source, input.caseSensitive ? "u" : "iu");
}

async function collectFiles(
  absolutePath: string,
  relativePath: string,
  workspaceRoot: string,
  signal: AbortSignal,
  budget: SearchBudget,
): Promise<readonly { absolutePath: string; relativePath: string }[]> {
  if (signal.aborted) {
    throw new DOMException("search cancelled", "AbortError");
  }

  const details = await stat(absolutePath);
  if (details.isFile()) {
    accountSearchFile(budget, details.size);
    return [{ absolutePath, relativePath }];
  }
  if (!details.isDirectory()) {
    return [];
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files: { absolutePath: string; relativePath: string }[] = [];

  for (const entry of entries) {
    if (signal.aborted) {
      throw new DOMException("search cancelled", "AbortError");
    }
    if (
      entry.isSymbolicLink() ||
      SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())
    ) {
      continue;
    }

    const childRelative = path.join(relativePath, entry.name);
    if (
      isSensitiveRelativePath(childRelative) ||
      isProtectedWorkspacePath(childRelative)
    ) {
      continue;
    }
    const child = await resolveWorkspacePath(workspaceRoot, childRelative, {
      rejectSensitive: true,
    }).catch((error: unknown) => {
      if (error instanceof WorkspacePathError) {
        return undefined;
      }
      throw error;
    });
    if (child === undefined) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(
        ...(await collectFiles(
          child.absolutePath,
          child.relativePath,
          workspaceRoot,
          signal,
          budget,
        )),
      );
    } else if (entry.isFile()) {
      const childDetails = await stat(child.absolutePath);
      accountSearchFile(budget, childDetails.size);
      files.push({
        absolutePath: child.absolutePath,
        relativePath: child.relativePath,
      });
    }
  }

  return files;
}

async function matchesInFile(
  file: { readonly absolutePath: string; readonly relativePath: string },
  matcher: RegExp,
  remaining: number,
  signal: AbortSignal,
): Promise<readonly SearchMatch[]> {
  const details = await stat(file.absolutePath);
  if (details.size > MAX_SEARCH_FILE_BYTES) {
    return [];
  }
  const bytes = await readFile(file.absolutePath, { signal });
  if (bytes.includes(0)) {
    return [];
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
  }

  const matches: SearchMatch[] = [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const match = matcher.exec(line);
    if (match !== null) {
      matches.push({
        relativePath: file.relativePath,
        line: index + 1,
        column: match.index + 1,
        text: line,
      });
    }
    if (matches.length >= remaining) {
      break;
    }
  }
  return matches;
}

export async function runFileSearch(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file search was cancelled");
    }
    const parsed = parseSearchInput(call.arguments);
    const matcher = matcherFor(parsed);
    const start = await resolveWorkspacePath(
      context.workspaceRoot,
      parsed.path,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(start.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be searched",
      );
    }
    const budget: SearchBudget = { files: 0, totalBytes: 0 };
    const files = await collectFiles(
      start.absolutePath,
      start.relativePath,
      start.workspaceRoot,
      context.signal,
      budget,
    );
    const matches: SearchMatch[] = [];

    for (const file of files) {
      if (matches.length >= parsed.maxResults) {
        break;
      }
      matches.push(
        ...(await matchesInFile(
          file,
          matcher,
          parsed.maxResults - matches.length,
          context.signal,
        )),
      );
    }

    const rendered = matches
      .map(
        (match) =>
          `${match.relativePath}:${match.line}:${match.column}:${match.text}`,
      )
      .join("\n");
    const bounded = truncateUtf8(rendered, FILE_SEARCH_OUTPUT_LIMIT_BYTES);

    return toolSuccess(
      call,
      bounded.output,
      {
        matchCount: matches.length,
        maxResults: parsed.maxResults,
        scannedFiles: budget.files,
        scannedBytes: budget.totalBytes,
        truncated: bounded.truncated,
        originalOutputBytes: bounded.originalBytes,
      },
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (error instanceof SearchLimitError) {
      return toolFailure(call, "SEARCH_LIMIT_EXCEEDED", error.message);
    }
    if (
      context.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return toolFailure(call, "CANCELLED", "file search was cancelled");
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown file search failure";
    return toolFailure(call, "FILE_SEARCH_FAILED", message);
  }
}
```

Append to `packages/tools/src/index.ts`:

```ts
export {
  FILE_READ_OUTPUT_LIMIT_BYTES,
  runFileRead,
} from "./file-read.js";
export {
  FILE_SEARCH_OUTPUT_LIMIT_BYTES,
  runFileSearch,
} from "./file-search.js";
```

- [ ] **Step 5: Run read/search checks and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd test -- packages/tools/test/file-read-search.test.ts
```

Expected: six tests pass; neither `fake-secret`, `needle outside`, nor protected session content appears in test output. Search traversal is capped at 10,000 files and 64 MiB of candidate file metadata before any file content is accumulated.

- [ ] **Step 6: Commit safe file reads and searches**

```powershell
git add packages/tools/src packages/tools/test/file-read-search.test.ts
git commit -m "feat: add safe file read and search operations"
```

### Task 4: Capture first pre-images, apply explicit patches atomically, and restore sessions

**Files:**

- Create: `packages/tools/test/file-patch-checkpoints.test.ts`
- Create after RED: `packages/tools/src/atomic-file.ts`
- Create after RED: `packages/tools/src/checkpoints.ts`
- Create after RED: `packages/tools/src/file-patch.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**

- Produces exact frozen `FileCheckpointStore implements CheckpointStore`.
- Produces `runFilePatch(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>`.
- `capture(request: CheckpointCaptureRequest): Promise<void>` keeps only the first pre-image per session/path.
- `restore(request: CheckpointRestoreRequest): Promise<CheckpointRestoreResult>` rewrites original files and removes files that did not originally exist.
- `file_patch` accepts either `{ path, create: true, content }` or `{ path, edits, expectedSha256? }`; the two forms are mutually exclusive.
- Checkpoint components are direct, canonical directories rather than links/reparse escapes; first-preimage blobs use atomic no-replace publication, and an orphan blob left by interruption reconstructs its missing record.
- Restore treats every persisted field as untrusted, validates record/blob size, shape, checksum, filename, and correspondence, and re-applies sensitive/protected-path policy.

- [ ] **Step 1: Write failing patch/checkpoint tests**

Create `packages/tools/test/file-patch-checkpoints.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- packages/tools/test/file-patch-checkpoints.test.ts
```

Expected: FAIL because `FileCheckpointStore` and `runFilePatch` do not exist.

- [ ] **Step 3: Implement atomic same-directory replacement**

Create `packages/tools/src/atomic-file.ts`:

```ts
import {
  link,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function writeFileAtomic(
  absolutePath: string,
  content: Uint8Array | string,
  options: {
    readonly mode?: number;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  if (options.signal.aborted) {
    throw new DOMException("write cancelled", "AbortError");
  }

  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.signal.aborted) {
      throw new DOMException("write cancelled", "AbortError");
    }
    // The requested mode was applied when the temporary file was opened.
    // Rename is the commit point; no fallible operation may turn a committed
    // write into a reported failure.
    await rename(temporaryPath, absolutePath);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeFileExclusiveAtomic(
  absolutePath: string,
  content: Uint8Array | string,
  options: {
    readonly mode?: number;
    readonly signal: AbortSignal;
  },
): Promise<"created" | "exists"> {
  if (options.signal.aborted) {
    throw new DOMException("write cancelled", "AbortError");
  }

  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.signal.aborted) {
      throw new DOMException("write cancelled", "AbortError");
    }

    // Publishing a hard link is atomic and refuses to replace an existing
    // first-preimage file. Both paths are in the same checked directory.
    await link(temporaryPath, absolutePath);
    // The final link is already durable enough for this process boundary;
    // cleanup cannot change the reported publication result.
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return "created";
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return "exists";
    }
    throw error;
  }
}
```

- [ ] **Step 4: Implement the frozen checkpoint store**

Create `packages/tools/src/checkpoints.ts`:

```ts
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import type {
  CheckpointCaptureRequest,
  CheckpointRestoreRequest,
  CheckpointRestoreResult,
  CheckpointStore,
} from "@agent/contracts";

import {
  writeFileAtomic,
  writeFileExclusiveAtomic,
} from "./atomic-file.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

const MAX_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHECKPOINT_BLOB_BYTES =
  Math.ceil((MAX_CHECKPOINT_FILE_BYTES * 4) / 3) + 16 * 1024;
const MAX_CHECKPOINT_RECORD_BYTES = 16 * 1024;
const MAX_CHECKPOINT_RECORDS = 10_000;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/u;
const BLOB_NAME = /^[a-f0-9]{64}\.blob\.json$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

interface CheckpointRecord {
  readonly version: 1;
  readonly relativePath: string;
  readonly existed: boolean;
  readonly mode?: number;
  readonly blobName: string;
  readonly sha256?: string;
  readonly createdAt: string;
}

interface CheckpointBlob {
  readonly version: 1;
  readonly relativePath: string;
  readonly existed: boolean;
  readonly mode?: number;
  readonly contentBase64?: string;
  readonly sha256?: string;
  readonly createdAt: string;
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(sessionId)) {
    throw new TypeError(
      "sessionId must contain only letters, digits, dot, underscore, or dash",
    );
  }
}

function recordStem(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex");
}

function blobNameFor(relativePath: string): string {
  return `${recordStem(relativePath)}.blob.json`;
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

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

async function ensureDirectDirectory(
  workspaceRoot: string,
  parent: string,
  name: string,
): Promise<string> {
  const candidate = path.join(parent, name);
  await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  });
  const details = await lstat(candidate);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new WorkspacePathError(
      "PATH_ESCAPE",
      "checkpoint storage cannot contain links or non-directories",
    );
  }
  const canonical = await realpath(candidate);
  if (
    !isContained(workspaceRoot, canonical) ||
    comparable(path.dirname(canonical)) !== comparable(parent)
  ) {
    throw new WorkspacePathError(
      "PATH_ESCAPE",
      "checkpoint storage resolves outside its direct workspace parent",
    );
  }
  return canonical;
}

async function checkpointDirectory(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const canonicalRoot = await realpath(path.resolve(workspaceRoot));
  const rootDetails = await stat(canonicalRoot);
  if (!rootDetails.isDirectory()) {
    throw new WorkspacePathError(
      "WORKSPACE_NOT_DIRECTORY",
      "workspaceRoot must resolve to a directory",
    );
  }
  let current = canonicalRoot;
  for (const name of [".agent", "checkpoints", sessionId]) {
    current = await ensureDirectDirectory(canonicalRoot, current, name);
  }
  return current;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validMode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0o777
  );
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseRecord(text: string): CheckpointRecord {
  const value = objectValue(JSON.parse(text), "checkpoint record");
  const relativePath = value["relativePath"];
  const existed = value["existed"];
  const mode = value["mode"];
  const blobName = value["blobName"];
  const sha256 = value["sha256"];
  const createdAt = value["createdAt"];
  if (
    value["version"] !== 1 ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    typeof existed !== "boolean" ||
    typeof blobName !== "string" ||
    !BLOB_NAME.test(blobName) ||
    blobName !== blobNameFor(relativePath) ||
    !validDate(createdAt) ||
    (mode !== undefined && !validMode(mode)) ||
    (sha256 !== undefined &&
      (typeof sha256 !== "string" || !SHA256.test(sha256))) ||
    (existed && (mode === undefined || sha256 === undefined)) ||
    (!existed && (mode !== undefined || sha256 !== undefined))
  ) {
    throw new Error("invalid checkpoint record");
  }
  return {
    version: 1,
    relativePath,
    existed,
    blobName,
    createdAt,
    ...(mode === undefined ? {} : { mode }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function parseBlob(text: string): CheckpointBlob {
  const value = objectValue(JSON.parse(text), "checkpoint blob");
  const relativePath = value["relativePath"];
  const existed = value["existed"];
  const mode = value["mode"];
  const contentBase64 = value["contentBase64"];
  const sha256 = value["sha256"];
  const createdAt = value["createdAt"];
  if (
    value["version"] !== 1 ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    typeof existed !== "boolean" ||
    !validDate(createdAt) ||
    (mode !== undefined && !validMode(mode)) ||
    (sha256 !== undefined &&
      (typeof sha256 !== "string" || !SHA256.test(sha256))) ||
    (contentBase64 !== undefined && typeof contentBase64 !== "string") ||
    (existed &&
      (mode === undefined ||
        sha256 === undefined ||
        contentBase64 === undefined)) ||
    (!existed &&
      (mode !== undefined ||
        sha256 !== undefined ||
        contentBase64 !== undefined))
  ) {
    throw new Error("invalid checkpoint blob");
  }
  if (contentBase64 !== undefined) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        contentBase64,
      )
    ) {
      throw new Error("checkpoint blob is not canonical base64");
    }
    const content = Buffer.from(contentBase64, "base64");
    if (
      content.length > MAX_CHECKPOINT_FILE_BYTES ||
      createHash("sha256").update(content).digest("hex") !== sha256
    ) {
      throw new Error("checkpoint blob checksum or size is invalid");
    }
  }
  return {
    version: 1,
    relativePath,
    existed,
    createdAt,
    ...(mode === undefined ? {} : { mode }),
    ...(contentBase64 === undefined ? {} : { contentBase64 }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

async function readBoundedText(
  absolutePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const details = await stat(absolutePath);
  if (!details.isFile() || details.size > maxBytes) {
    throw new Error(`checkpoint metadata exceeds ${maxBytes} bytes`);
  }
  const bytes = await readFile(absolutePath, { signal });
  if (bytes.length > maxBytes) {
    throw new Error(`checkpoint metadata exceeds ${maxBytes} bytes`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readOptionalRecord(
  absolutePath: string,
  signal: AbortSignal,
): Promise<CheckpointRecord | undefined> {
  try {
    return parseRecord(
      await readBoundedText(
        absolutePath,
        MAX_CHECKPOINT_RECORD_BYTES,
        signal,
      ),
    );
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readBlob(
  absolutePath: string,
  signal: AbortSignal,
): Promise<CheckpointBlob> {
  return parseBlob(
    await readBoundedText(absolutePath, MAX_CHECKPOINT_BLOB_BYTES, signal),
  );
}

function recordFromBlob(blob: CheckpointBlob): CheckpointRecord {
  return {
    version: 1,
    relativePath: blob.relativePath,
    existed: blob.existed,
    blobName: blobNameFor(blob.relativePath),
    createdAt: blob.createdAt,
    ...(blob.mode === undefined ? {} : { mode: blob.mode }),
    ...(blob.sha256 === undefined ? {} : { sha256: blob.sha256 }),
  };
}

function validateRecordBlob(
  record: CheckpointRecord,
  blob: CheckpointBlob,
): void {
  if (
    record.relativePath !== blob.relativePath ||
    record.existed !== blob.existed ||
    record.mode !== blob.mode ||
    record.sha256 !== blob.sha256 ||
    record.createdAt !== blob.createdAt ||
    record.blobName !== blobNameFor(blob.relativePath)
  ) {
    throw new Error("checkpoint record does not match its blob");
  }
}

async function readRecords(
  directory: string,
  signal: AbortSignal,
): Promise<CheckpointRecord[]> {
  const names = (await readdir(directory)).filter((name) =>
    RECORD_NAME.test(name),
  );
  if (names.length > MAX_CHECKPOINT_RECORDS) {
    throw new Error(
      `checkpoint session exceeds ${MAX_CHECKPOINT_RECORDS} records`,
    );
  }
  const records = await Promise.all(
    names.map(async (name) => {
      const record = parseRecord(
        await readBoundedText(
          path.join(directory, name),
          MAX_CHECKPOINT_RECORD_BYTES,
          signal,
        ),
      );
      if (name !== `${recordStem(record.relativePath)}.json`) {
        throw new Error("checkpoint record filename does not match its path");
      }
      return record;
    }),
  );
  records.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
  return records;
}

export class FileCheckpointStore implements CheckpointStore {
  async capture(request: CheckpointCaptureRequest): Promise<void> {
    validateSessionId(request.sessionId);
    if (request.signal.aborted) {
      throw new DOMException("checkpoint capture cancelled", "AbortError");
    }

    const target = await resolveWorkspacePath(
      request.workspaceRoot,
      request.relativePath,
      {
        allowMissingLeaf: true,
        rejectSensitive: true,
      },
    );
    if (isProtectedWorkspacePath(target.relativePath)) {
      throw new WorkspacePathError(
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be checkpoint targets",
      );
    }
    const directory = await checkpointDirectory(
      target.workspaceRoot,
      request.sessionId,
    );
    const stem = recordStem(target.relativePath);
    const recordPath = path.join(directory, `${stem}.json`);
    const blobPath = path.join(directory, blobNameFor(target.relativePath));
    const existingRecord = await readOptionalRecord(
      recordPath,
      request.signal,
    );
    if (existingRecord !== undefined) {
      const existingBlob = await readBlob(blobPath, request.signal);
      validateRecordBlob(existingRecord, existingBlob);
      return;
    }

    const createdAt = new Date().toISOString();
    let proposedBlob: CheckpointBlob;
    if (target.exists) {
      const [content, details] = await Promise.all([
        readFile(target.absolutePath, { signal: request.signal }),
        stat(target.absolutePath),
      ]);
      if (!details.isFile()) {
        throw new Error("checkpoint targets must be files");
      }
      if (
        details.size > MAX_CHECKPOINT_FILE_BYTES ||
        content.length > MAX_CHECKPOINT_FILE_BYTES
      ) {
        throw new Error(
          `checkpoint target exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes`,
        );
      }
      proposedBlob = {
        version: 1,
        relativePath: target.relativePath,
        existed: true,
        mode: details.mode & 0o777,
        contentBase64: content.toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
        createdAt,
      };
    } else {
      proposedBlob = {
        version: 1,
        relativePath: target.relativePath,
        existed: false,
        createdAt,
      };
    }

    const blobPublish = await writeFileExclusiveAtomic(
      blobPath,
      `${JSON.stringify(proposedBlob)}\n`,
      { mode: 0o600, signal: request.signal },
    );
    // A blob without a record is a recoverable interrupted capture. The first
    // exclusively published blob remains authoritative.
    const authoritativeBlob =
      blobPublish === "created"
        ? proposedBlob
        : await readBlob(blobPath, request.signal);
    if (authoritativeBlob.relativePath !== target.relativePath) {
      throw new Error("orphan checkpoint blob belongs to another path");
    }
    const record = recordFromBlob(authoritativeBlob);
    const recordPublish = await writeFileExclusiveAtomic(
      recordPath,
      `${JSON.stringify(record)}\n`,
      { mode: 0o600, signal: request.signal },
    );
    if (recordPublish === "exists") {
      const winner = await readOptionalRecord(recordPath, request.signal);
      if (winner === undefined) {
        throw new Error("checkpoint record disappeared during capture");
      }
      validateRecordBlob(winner, authoritativeBlob);
    }
  }

  async restore(
    request: CheckpointRestoreRequest,
  ): Promise<CheckpointRestoreResult> {
    validateSessionId(request.sessionId);
    const workspace = await resolveWorkspacePath(
      request.workspaceRoot,
      ".",
    );
    const directory = await checkpointDirectory(
      workspace.workspaceRoot,
      request.sessionId,
    );
    const records = await readRecords(directory, request.signal);
    const restoredPaths: string[] = [];
    const removedPaths: string[] = [];

    for (const record of records) {
      if (request.signal.aborted) {
        throw new DOMException("checkpoint restore cancelled", "AbortError");
      }
      const target = await resolveWorkspacePath(
        workspace.workspaceRoot,
        record.relativePath,
        {
          allowMissingLeaf: true,
          rejectSensitive: true,
        },
      );
      if (isProtectedWorkspacePath(target.relativePath)) {
        throw new WorkspacePathError(
          "SENSITIVE_PATH",
          "Agent metadata and Git internals cannot be restore targets",
        );
      }
      if (target.relativePath !== record.relativePath) {
        throw new Error(
          `checkpoint target changed after capture: ${record.relativePath}`,
        );
      }

      if (!BLOB_NAME.test(record.blobName)) {
        throw new Error("checkpoint blob name is invalid");
      }
      const blob = await readBlob(
        path.join(directory, record.blobName),
        request.signal,
      );
      validateRecordBlob(record, blob);

      if (record.existed) {
        if (
          blob.contentBase64 === undefined ||
          record.sha256 === undefined
        ) {
          throw new Error("checkpoint blob metadata is missing");
        }
        const content = Buffer.from(blob.contentBase64, "base64");
        const digest = createHash("sha256").update(content).digest("hex");
        if (digest !== record.sha256) {
          throw new Error(`checkpoint checksum failed: ${record.relativePath}`);
        }
        await writeFileAtomic(target.absolutePath, content, {
          mode: record.mode,
          signal: request.signal,
        });
        restoredPaths.push(record.relativePath);
      } else {
        await rm(target.absolutePath, { force: true });
        removedPaths.push(record.relativePath);
      }
    }

    return {
      restoredPaths,
      removedPaths,
    };
  }
}
```

- [ ] **Step 5: Implement explicit optimistic file patches**

Create `packages/tools/src/file-patch.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type {
  JsonObject,
  JsonValue,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import { writeFileAtomic } from "./atomic-file.js";
import {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const FILE_PATCH_OUTPUT_LIMIT_BYTES = 16 * 1024;
const MAX_PATCHED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EDITS = 50;

interface PatchEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly expectedOccurrences: number;
}

interface ParsedPatch {
  readonly path: string;
  readonly create: boolean;
  readonly content?: string;
  readonly edits: readonly PatchEdit[];
  readonly expectedSha256?: string;
}

function objectValue(value: JsonValue, label: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function parseEdit(value: JsonValue, index: number): PatchEdit {
  const edit = objectValue(value, `edits[${index}]`);
  const oldText = edit["oldText"];
  const newText = edit["newText"];
  const expectedOccurrences = edit["expectedOccurrences"] ?? 1;

  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new TypeError(`edits[${index}].oldText must be non-empty`);
  }
  if (typeof newText !== "string") {
    throw new TypeError(`edits[${index}].newText must be a string`);
  }
  if (
    typeof expectedOccurrences !== "number" ||
    !Number.isInteger(expectedOccurrences) ||
    expectedOccurrences < 1 ||
    expectedOccurrences > 100
  ) {
    throw new TypeError(
      `edits[${index}].expectedOccurrences must be 1 through 100`,
    );
  }
  return { oldText, newText, expectedOccurrences };
}

function parsePatch(input: JsonObject): ParsedPatch {
  const pathInput = input["path"];
  const create = input["create"] ?? false;
  const content = input["content"];
  const editsInput = input["edits"];
  const expectedSha256 = input["expectedSha256"];

  if (typeof pathInput !== "string" || pathInput.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  if (typeof create !== "boolean") {
    throw new TypeError("create must be a boolean");
  }
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256))
  ) {
    throw new TypeError("expectedSha256 must be a lowercase SHA-256 digest");
  }

  if (create) {
    if (typeof content !== "string") {
      throw new TypeError("content is required when create is true");
    }
    if (editsInput !== undefined || expectedSha256 !== undefined) {
      throw new TypeError(
        "create cannot be combined with edits or expectedSha256",
      );
    }
    return {
      path: pathInput,
      create,
      content,
      edits: [],
    };
  }

  if (!Array.isArray(editsInput) || editsInput.length === 0) {
    throw new TypeError("edits must be a non-empty array");
  }
  if (editsInput.length > MAX_EDITS) {
    throw new TypeError(`edits cannot exceed ${MAX_EDITS} entries`);
  }
  if (content !== undefined) {
    throw new TypeError("content is only valid when create is true");
  }
  return {
    path: pathInput,
    create,
    edits: editsInput.map(parseEdit),
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
  };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(search, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + search.length;
  }
}

function applyEdits(
  call: ToolCall,
  original: string,
  edits: readonly PatchEdit[],
): ToolResult | string {
  let current = original;
  for (const [index, edit] of edits.entries()) {
    const occurrences = countOccurrences(current, edit.oldText);
    if (occurrences !== edit.expectedOccurrences) {
      return toolFailure(
        call,
        "PATCH_CONTEXT_MISMATCH",
        `edit ${index} expected ${edit.expectedOccurrences} occurrence(s), found ${occurrences}`,
      );
    }
    current = current.split(edit.oldText).join(edit.newText);
  }
  return current;
}

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function runFilePatch(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file patch was cancelled");
    }
    const parsed = parsePatch(call.arguments);
    const initial = await resolveWorkspacePath(
      context.workspaceRoot,
      parsed.path,
      {
        allowMissingLeaf: parsed.create,
        rejectSensitive: true,
      },
    );
    if (isProtectedWorkspacePath(initial.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be patched",
      );
    }
    if (parsed.create && initial.exists) {
      return toolFailure(
        call,
        "FILE_ALREADY_EXISTS",
        "create refuses to overwrite an existing file",
      );
    }
    if (!parsed.create && !initial.exists) {
      return toolFailure(
        call,
        "PATH_NOT_FOUND",
        "patch target does not exist",
      );
    }

    let original = "";
    let originalSha256: string | null = null;
    let mode: number | undefined;
    if (!parsed.create) {
      const details = await stat(initial.absolutePath);
      if (!details.isFile()) {
        return toolFailure(call, "NOT_A_FILE", "patch target must be a file");
      }
      if (details.size > MAX_PATCHED_FILE_BYTES) {
        return toolFailure(
          call,
          "FILE_TOO_LARGE",
          `patch target exceeds ${MAX_PATCHED_FILE_BYTES} bytes`,
        );
      }
      const bytes = await readFile(initial.absolutePath, {
        signal: context.signal,
      });
      if (bytes.length > MAX_PATCHED_FILE_BYTES) {
        return toolFailure(
          call,
          "FILE_TOO_LARGE",
          `patch target exceeds ${MAX_PATCHED_FILE_BYTES} bytes`,
        );
      }
      if (bytes.includes(0)) {
        return toolFailure(
          call,
          "BINARY_FILE",
          "file_patch accepts UTF-8 text files only",
        );
      }
      try {
        original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return toolFailure(
          call,
          "INVALID_UTF8",
          "file_patch accepts UTF-8 text files only",
        );
      }
      mode = details.mode & 0o777;
      originalSha256 = digest(bytes);
    }

    if (
      parsed.expectedSha256 !== undefined &&
      originalSha256 !== parsed.expectedSha256
    ) {
      return toolFailure(
        call,
        "FILE_CHANGED",
        "file content does not match expectedSha256",
      );
    }

    const next = parsed.create
      ? (parsed.content ?? "")
      : applyEdits(call, original, parsed.edits);
    if (typeof next !== "string") {
      return next;
    }
    if (next === original && !parsed.create) {
      return toolFailure(call, "NO_CHANGE", "patch does not change the file");
    }
    if (Buffer.byteLength(next, "utf8") > MAX_PATCHED_FILE_BYTES) {
      return toolFailure(
        call,
        "FILE_TOO_LARGE",
        `patched file exceeds ${MAX_PATCHED_FILE_BYTES} bytes`,
      );
    }

    await context.checkpoints.capture({
      sessionId: context.sessionId,
      workspaceRoot: initial.workspaceRoot,
      relativePath: initial.relativePath,
      signal: context.signal,
    });
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "file patch was cancelled");
    }

    const finalTarget = await resolveWorkspacePath(
      initial.workspaceRoot,
      initial.relativePath,
      {
        allowMissingLeaf: parsed.create,
        rejectSensitive: true,
      },
    );
    if (
      finalTarget.absolutePath !== initial.absolutePath ||
      finalTarget.exists !== initial.exists
    ) {
      return toolFailure(
        call,
        "PATH_CHANGED",
        "patch target changed after authorization",
      );
    }
    if (!parsed.create) {
      const finalDetails = await stat(finalTarget.absolutePath);
      if (
        !finalDetails.isFile() ||
        finalDetails.size > MAX_PATCHED_FILE_BYTES
      ) {
        return toolFailure(
          call,
          "FILE_CHANGED",
          "patch target type or size changed before commit",
        );
      }
      const current = await readFile(finalTarget.absolutePath, {
        signal: context.signal,
      });
      if (
        current.length > MAX_PATCHED_FILE_BYTES ||
        digest(current) !== originalSha256
      ) {
        return toolFailure(
          call,
          "FILE_CHANGED",
          "patch target content changed before commit",
        );
      }
    }

    await writeFileAtomic(finalTarget.absolutePath, next, {
      ...(mode === undefined ? {} : { mode }),
      signal: context.signal,
    });

    return toolSuccess(
      call,
      `patched ${finalTarget.relativePath}`,
      {
        path: finalTarget.relativePath,
        created: parsed.create,
        editCount: parsed.edits.length,
        previousSha256: originalSha256,
        newSha256: digest(next),
      },
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (
      context.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return toolFailure(call, "CANCELLED", "file patch was cancelled");
    }
    if (error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown file patch failure";
    return toolFailure(call, "FILE_PATCH_FAILED", message);
  }
}
```

Append to `packages/tools/src/index.ts`:

```ts
export { FileCheckpointStore } from "./checkpoints.js";
export {
  FILE_PATCH_OUTPUT_LIMIT_BYTES,
  runFilePatch,
} from "./file-patch.js";
```

- [ ] **Step 6: Run patch/checkpoint checks and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd test -- packages/tools/test/file-patch-checkpoints.test.ts
```

Expected: seven tests pass; the second edit does not replace the first checkpoint, orphan metadata is reconstructed from the exclusively published blob, linked checkpoint storage is rejected, a concurrent content change is not overwritten, and restore rewrites `existing.txt` or removes `created.md` as appropriate.

- [ ] **Step 7: Commit checkpoints and explicit patching**

```powershell
git add packages/tools/src packages/tools/test/file-patch-checkpoints.test.ts
git commit -m "feat: add checkpointed file patch operation"
```

### Task 5: Execute bounded direct processes with timeout, cancellation, and verified tree termination

**Files:**

- Create: `packages/tools/test/shell-execute.test.ts`
- Create after RED: `packages/tools/src/executable-path.ts`
- Create after RED: `packages/tools/src/shell-process.ts`
- Create after RED: `packages/tools/src/shell-execute.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**

- Produces `runShellExecute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>`.
- Produces public `resolveExecutable(program, workspaceRoot): Promise<ResolvedExecutable>` for Policy and internal `assertResolvedExecutable(program)` for defense in depth.
- Tool input is `{ program: string, args?: string[], cwd?: string, timeoutMs?: number }`; there is no opaque command string, caller-supplied environment, or shell parsing.
- Default timeout is `120000` ms; accepted range is `100` through `300000` ms.
- `program` reaching the Tool must already be a canonical absolute non-script executable; Tools revalidate it and use `spawn(program, args, { shell: false })`.
- Windows uses the absolute System32 `taskkill.exe /pid <pid> /t /f` with a checked exit code and bounded fallback; POSIX uses a detached process group with bounded TERM/KILL phases and no surviving timer.

- [ ] **Step 1: Write failing execution, redaction, truncation, and cancellation tests**

Create `packages/tools/test/shell-execute.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused shell test and verify RED**

Run:

```powershell
npm.cmd test -- packages/tools/test/shell-execute.test.ts
```

Expected: FAIL because the shell exports do not exist.

- [ ] **Step 3: Resolve native executables without searching the workspace or `cwd`**

Create `packages/tools/src/executable-path.ts`:

```ts
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
```

- [ ] **Step 4: Implement bounded capture and cross-platform process-tree termination**

Create `packages/tools/src/shell-process.ts`:

```ts
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
      void terminateProcessTree(child).then((terminated) => {
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
```

- [ ] **Step 5: Implement the structured direct-process tool operation**

Create `packages/tools/src/shell-execute.ts`:

```ts
import type {
  JsonObject,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import path from "node:path";
import {
  executeProcess,
  type ShellProcessResult,
} from "./shell-process.js";
import {
  assertResolvedExecutable,
  ExecutablePathError,
} from "./executable-path.js";
import {
  toolFailure,
  toolSuccess,
} from "./tool-result.js";
import { truncateUtf8 } from "./output.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

export const SHELL_EXECUTE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4_096;
const FORBIDDEN_ARGUMENT_SYNTAX =
  /(?:&&|\|\||[|;<>`\r\n]|\$\(|(?:^|\s)&(?:\s|$))/u;
const FORBIDDEN_PROGRAMS = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "cscript",
  "cscript.exe",
  "fish",
  "mshta",
  "mshta.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "wscript",
  "wscript.exe",
  "zsh",
]);

interface ShellInput {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

function parseShellInput(input: JsonObject): ShellInput {
  if ("command" in input) {
    throw new TypeError(
      "opaque command strings are not accepted; use program and args",
    );
  }
  const program = input["program"];
  const argsInput = input["args"] ?? [];
  const cwd = input["cwd"] ?? ".";
  const timeoutMs = input["timeoutMs"] ?? DEFAULT_TIMEOUT_MS;

  if (
    typeof program !== "string" ||
    program.length === 0 ||
    !path.isAbsolute(program)
  ) {
    throw new TypeError("program must be a canonical absolute path");
  }
  if (!Array.isArray(argsInput) || argsInput.length > MAX_ARGUMENTS) {
    throw new TypeError(`args must contain at most ${MAX_ARGUMENTS} strings`);
  }
  const args = argsInput.map((value, index) => {
    if (
      typeof value !== "string" ||
      value.length > MAX_ARGUMENT_LENGTH ||
      value.includes("\0") ||
      FORBIDDEN_ARGUMENT_SYNTAX.test(value)
    ) {
      throw new TypeError(
        `args[${index}] contains invalid, compound, or redirected syntax`,
      );
    }
    return value;
  });
  const basename = path.basename(program).toLowerCase();
  if (
    FORBIDDEN_PROGRAMS.has(basename) ||
    [".bat", ".cmd", ".ps1", ".sh"].includes(
      path.extname(basename),
    ) ||
    ((basename === "node" || basename === "node.exe") &&
      args.some((argument) =>
        ["-e", "--eval", "-p", "--print"].includes(argument),
      ))
  ) {
    throw new TypeError(
      "shell interpreters, script wrappers, and eval flags are not accepted",
    );
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("cwd must be a non-empty string");
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}`,
    );
  }
  return {
    program,
    args,
    cwd,
    timeoutMs,
  };
}

function renderProcessOutput(result: ShellProcessResult): string {
  const sections: string[] = [];
  if (result.stdout.length > 0) {
    sections.push(result.stdout);
  }
  if (result.stderr.length > 0) {
    sections.push(`[stderr]\n${result.stderr}`);
  }
  return sections.join("\n");
}

export async function runShellExecute(
  call: ToolCall,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (context.signal.aborted) {
      return toolFailure(call, "CANCELLED", "process was cancelled", {
        metadata: {
          exitCode: null,
          timedOut: false,
          cancelled: true,
        },
      });
    }
    const parsed = parseShellInput(call.arguments);
    const program = await assertResolvedExecutable(parsed.program);
    const cwd = await resolveWorkspacePath(
      context.workspaceRoot,
      parsed.cwd,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(cwd.relativePath)) {
      return toolFailure(
        call,
        "SENSITIVE_PATH",
        "protected directories cannot be process cwd",
      );
    }
    const result = await executeProcess({
      program,
      args: parsed.args,
      cwd: cwd.absolutePath,
      timeoutMs: parsed.timeoutMs,
      signal: context.signal,
    });
    const bounded = truncateUtf8(
      renderProcessOutput(result),
      SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
    );
    const metadata: JsonObject = {
      program,
      args: parsed.args,
      cwd: cwd.relativePath,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      truncated: result.truncated || bounded.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      terminationFailed: result.terminationFailed,
    };

    if (result.terminationFailed) {
      return toolFailure(
        call,
        "PROCESS_TERMINATION_FAILED",
        "process tree did not terminate within the bounded kill deadline",
        {
          output: bounded.output,
          metadata,
        },
      );
    }
    if (result.cancelled) {
      return toolFailure(call, "CANCELLED", "process was cancelled", {
        output: bounded.output,
        metadata,
      });
    }
    if (result.timedOut) {
      return toolFailure(
        call,
        "PROCESS_TIMEOUT",
        `process exceeded ${parsed.timeoutMs} ms`,
        {
          output: bounded.output,
          metadata,
        },
      );
    }
    if (result.spawnError !== undefined) {
      return toolFailure(call, "PROCESS_SPAWN_FAILED", result.spawnError, {
        output: bounded.output,
        metadata,
      });
    }
    if (result.exitCode !== 0) {
      return toolFailure(
        call,
        "PROCESS_FAILED",
        `process exited with code ${String(result.exitCode)}`,
        {
          output: bounded.output,
          metadata,
        },
      );
    }
    return toolSuccess(call, bounded.output, metadata);
  } catch (error: unknown) {
    if (error instanceof ExecutablePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (error instanceof WorkspacePathError) {
      return toolFailure(call, error.code, error.message);
    }
    if (error instanceof TypeError) {
      return toolFailure(call, "INVALID_INPUT", error.message);
    }
    const message =
      error instanceof Error ? error.message : "unknown process failure";
    return toolFailure(call, "SHELL_EXECUTE_FAILED", message);
  }
}
```

Append to `packages/tools/src/index.ts`:

```ts
export {
  ExecutablePathError,
  resolveExecutable,
  type ExecutablePathErrorCode,
  type ResolvedExecutable,
} from "./executable-path.js";
export {
  runShellExecute,
  SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
} from "./shell-execute.js";
```

- [ ] **Step 6: Run direct-process checks and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd test -- packages/tools/test/shell-execute.test.ts
```

Expected: seven cross-platform tests pass; on Windows the eighth process-tree test also passes; direct eval and opaque command input are rejected, the injected fake key never appears, and no raw process runner is exported by `@agent/tools`.

- [ ] **Step 7: Commit cancellable bounded direct-process execution**

```powershell
git add packages/tools/src packages/tools/test/shell-execute.test.ts
git commit -m "feat: add cancellable direct process execution"
```

### Task 6: Classify canonical direct processes without parsing shell syntax

**Files:**

- Create: `packages/policy/test/process-risk.test.ts`
- Create after RED: `packages/policy/src/process-risk.ts`
- Modify: `packages/policy/src/index.ts`

**Interfaces:**

- Produces `analyzeProcess(program, args, insideWorkspace): ProcessRiskAnalysis`.
- Produces impact union `read_only | local_low_risk | install | network | git_remote | delete | destructive | ambiguous`.
- Classification sees an already canonical executable and a literal argument array. Script shells, eval modes, credential paths, compound/redirection tokens, and broad destructive targets are deny-grade; project programs and processes capable of running project hooks or scripts never receive silent allow.

- [ ] **Step 1: Write the failing cross-platform direct-process matrix**

Create `packages/policy/test/process-risk.test.ts`:

```ts
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
```

- [ ] **Step 2: Run process-risk tests and verify RED**

Run:

```powershell
npm.cmd test -- packages/policy/test/process-risk.test.ts
```

Expected: FAIL because `analyzeProcess` is not exported.

- [ ] **Step 3: Implement conservative structured-process analysis**

Create `packages/policy/src/process-risk.ts`:

```ts
import path from "node:path";

export type ProcessImpact =
  | "read_only"
  | "local_low_risk"
  | "install"
  | "network"
  | "git_remote"
  | "delete"
  | "destructive"
  | "ambiguous";

export interface ProcessRiskAnalysis {
  readonly impact: ProcessImpact;
  readonly reasons: readonly string[];
  readonly denyAlways: boolean;
  readonly network: boolean;
  readonly install: boolean;
  readonly gitRemote: boolean;
  readonly deletes: boolean;
  readonly workspaceExecutable: boolean;
  readonly workspacePathArgumentIndexes: readonly number[];
}

const CREDENTIAL_PATTERN =
  /(?:^|[\\/=:])(?:\.env(?:\.[^\\/]*)?|\.netrc|_netrc|\.npmrc|\.pypirc|credentials(?:\.json)?|application_default_credentials\.json|auth\.json|token(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[\\/])|(?:^|[\\/=:])(?:\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.config[\\/]gcloud)(?:$|[\\/])|\/etc\/(?:shadow|passwd|sudoers)(?:$|[\\/])|[A-Za-z]:[\\/]Windows[\\/]System32[\\/]config[\\/](?:SAM|SECURITY|SYSTEM)(?:$|[\\/])/iu;
const FORBIDDEN_ARGUMENT_SYNTAX =
  /(?:&&|\|\||[|;<>`\r\n]|\$\(|(?:^|\s)&(?:\s|$))/u;
const SHELL_PROGRAMS = new Set([
  "bash",
  "cmd",
  "cscript",
  "fish",
  "mshta",
  "powershell",
  "pwsh",
  "sh",
  "wscript",
  "zsh",
]);
const INSTALL_PROGRAMS = new Set([
  "apt",
  "apt-get",
  "brew",
  "choco",
  "npm",
  "pip",
  "pip3",
  "pnpm",
  "scoop",
  "winget",
  "yarn",
]);
const NETWORK_PROGRAMS = new Set([
  "curl",
  "ftp",
  "nc",
  "ncat",
  "scp",
  "sftp",
  "ssh",
  "telnet",
  "wget",
]);
const DELETE_PROGRAMS = new Set([
  "del",
  "erase",
  "rm",
  "rmdir",
  "unlink",
]);
const ALWAYS_DESTRUCTIVE_PROGRAMS = new Set([
  "diskpart",
  "fdisk",
  "format",
  "mkfs",
  "reboot",
  "shutdown",
]);

function executableName(program: string): string {
  return path.basename(program).toLowerCase().replace(/\.exe$/u, "");
}

function exactArgs(
  args: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    args.length === expected.length &&
    args.every((value, index) => value === expected[index])
  );
}

function isRootTarget(argument: string): boolean {
  const normalized = argument.trim().replace(/[\\*]+$/u, "\\");
  return (
    normalized === "/" ||
    normalized === "~" ||
    /^[A-Za-z]:[\\/]?$/u.test(normalized)
  );
}

function result(
  impact: ProcessImpact,
  reasons: readonly string[],
  flags: Partial<Omit<ProcessRiskAnalysis, "impact" | "reasons">> = {},
): ProcessRiskAnalysis {
  return {
    impact,
    reasons,
    denyAlways: flags.denyAlways ?? false,
    network: flags.network ?? false,
    install: flags.install ?? false,
    gitRemote: flags.gitRemote ?? false,
    deletes: flags.deletes ?? false,
    workspaceExecutable: flags.workspaceExecutable ?? false,
    workspacePathArgumentIndexes:
      flags.workspacePathArgumentIndexes ?? [],
  };
}

export function analyzeProcess(
  program: string,
  args: readonly string[],
  insideWorkspace: boolean,
): ProcessRiskAnalysis {
  const name = executableName(program);
  const lowerArgs = args.map((argument) => argument.toLowerCase());
  const joinedArguments = args.join("/");
  const evalMode =
    (name === "node" &&
      lowerArgs.some((argument) =>
        ["-e", "--eval", "-p", "--print"].includes(argument),
      )) ||
    ((name === "python" || name === "python3") &&
      lowerArgs.includes("-c"));
  const broadDelete =
    ALWAYS_DESTRUCTIVE_PROGRAMS.has(name) ||
    (DELETE_PROGRAMS.has(name) && args.some(isRootTarget));
  if (
    !path.isAbsolute(program) ||
    SHELL_PROGRAMS.has(name) ||
    evalMode ||
    args.some(
      (argument) =>
        argument.includes("\0") ||
        FORBIDDEN_ARGUMENT_SYNTAX.test(argument),
    ) ||
    CREDENTIAL_PATTERN.test(joinedArguments) ||
    broadDelete
  ) {
    return result(
      "destructive",
      [
        "process uses a shell/eval form, credential path, compound token, or broad destructive target",
      ],
      { denyAlways: true, deletes: broadDelete },
    );
  }

  const gitRemote =
    name === "git" &&
    ["push", "pull", "fetch", "clone", "ls-remote"].includes(
      lowerArgs[0] ?? "",
    );
  if (gitRemote) {
    return result("git_remote", ["Git remote operation requires confirmation"], {
      gitRemote: true,
      network: true,
      workspaceExecutable: insideWorkspace,
    });
  }
  const install =
    INSTALL_PROGRAMS.has(name) &&
    ["add", "i", "install", "ci"].includes(lowerArgs[0] ?? "");
  if (install) {
    return result("install", ["software installation requires confirmation"], {
      install: true,
      network: true,
      workspaceExecutable: insideWorkspace,
    });
  }
  if (NETWORK_PROGRAMS.has(name)) {
    return result("network", ["network client requires confirmation"], {
      network: true,
      workspaceExecutable: insideWorkspace,
    });
  }
  if (
    DELETE_PROGRAMS.has(name) ||
    (name === "git" &&
      (lowerArgs[0] === "clean" ||
        (lowerArgs[0] === "reset" && lowerArgs.includes("--hard"))))
  ) {
    return result("delete", ["scoped deletion requires confirmation"], {
      deletes: true,
      workspaceExecutable: insideWorkspace,
    });
  }

  if (insideWorkspace) {
    return result(
      "ambiguous",
      ["workspace executable can contain arbitrary project code"],
      { workspaceExecutable: true },
    );
  }
  if (
    ((name === "node" || name === "git") &&
      exactArgs(args, ["--version"])) ||
    ((name === "pwd" || name === "whoami") && args.length === 0)
  ) {
    return result("read_only", ["exact native information query"]);
  }
  if (
    name === "node" &&
    args.length === 2 &&
    args[0] === "--check"
  ) {
    return result(
      "local_low_risk",
      ["node syntax check reads one canonical workspace file without executing it"],
      { workspacePathArgumentIndexes: [1] },
    );
  }
  if (name === "git") {
    return result(
      "ambiguous",
      ["Git project operations may invoke hooks, filters, or helpers"],
    );
  }
  return result(
    "ambiguous",
    ["direct process is not an exact safe shape"],
  );
}
```

Replace `packages/policy/src/index.ts` with:

```ts
export {
  analyzeProcess,
  type ProcessImpact,
  type ProcessRiskAnalysis,
} from "./process-risk.js";
```

- [ ] **Step 4: Run policy checks and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/policy
npm.cmd test -- packages/policy/test/process-risk.test.ts
```

Expected: all table cases pass; shell/eval forms, broad deletes, compound/redirection tokens, and credential paths are `denyAlways`; Git project operations and workspace executables are never silently classified safe.

- [ ] **Step 5: Commit direct-process risk classification**

```powershell
git add packages/policy/src packages/policy/test/process-risk.test.ts
git commit -m "feat: classify direct process risk"
```

### Task 7: Enforce readonly, workspace, and trusted decisions with canonical resolved arguments

**Files:**

- Create: `packages/policy/test/default-permission-evaluator.test.ts`
- Create after RED: `packages/policy/src/default-permission-evaluator.ts`
- Modify: `packages/policy/src/index.ts`

**Interfaces:**

- Produces exact frozen `DefaultPermissionEvaluator implements PermissionEvaluator`.
- Consumes exact `PermissionRequest { mode; tool; call; workspaceRoot }`.
- Every `allow` or `ask` returns canonical `resolvedArguments`; every `deny` omits them as required by the frozen discriminated union.
- Rule IDs are stable test/audit identifiers.

- [ ] **Step 1: Write the failing path and permission-mode matrix**

Create `packages/policy/test/default-permission-evaluator.test.ts`:

```ts
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

    expect(opaque).toMatchObject({ outcome: "deny", ruleId: "input.invalid" });
    expect(escaped).toMatchObject({ outcome: "deny", ruleId: "path.escape" });
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
```

- [ ] **Step 2: Build the public tools dependency, run policy test, and verify RED**

Run:

```powershell
npm.cmd run build --workspace @agent/tools
npm.cmd test -- packages/policy/test/default-permission-evaluator.test.ts
```

Expected: tools build exits `0`; the test FAILS because `DefaultPermissionEvaluator` is not exported.

- [ ] **Step 3: Implement exact discriminated decisions and path policy**

Create `packages/policy/src/default-permission-evaluator.ts`:

```ts
import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  JsonObject,
  PermissionDecision,
  PermissionEvaluator,
  PermissionMode,
  PermissionRequest,
  RiskLevel,
} from "@agent/contracts";
import {
  ExecutablePathError,
  isProtectedWorkspacePath,
  resolveExecutable as resolveNativeExecutable,
  resolveWorkspacePath,
  type ResolvedExecutable,
  WorkspacePathError,
} from "@agent/tools";

import {
  analyzeProcess,
  type ProcessRiskAnalysis,
} from "./process-risk.js";

const EXPECTED_RISK: Readonly<Record<string, RiskLevel>> = {
  file_read: "read",
  file_search: "read",
  file_patch: "write",
  shell_execute: "execute",
};

function deny(ruleId: string, reason: string): PermissionDecision {
  return {
    outcome: "deny",
    reason,
    ruleId,
  };
}

function executable(
  outcome: "allow" | "ask",
  ruleId: string,
  reason: string,
  resolvedArguments: JsonObject,
): PermissionDecision {
  return {
    outcome,
    reason,
    ruleId,
    resolvedArguments,
  };
}

function pathErrorDecision(error: WorkspacePathError): PermissionDecision {
  const ruleId =
    error.code === "PATH_ESCAPE"
      ? "path.escape"
      : error.code === "SENSITIVE_PATH"
        ? "path.sensitive"
        : "path.invalid";
  return deny(ruleId, error.message);
}

function pathArgument(toolName: string, input: JsonObject): string {
  const value = input["path"];
  if (value === undefined && toolName === "file_search") {
    return ".";
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  return value;
}

async function evaluateFileRequest(
  request: PermissionRequest,
): Promise<PermissionDecision> {
  try {
    const create =
      request.call.name === "file_patch" &&
      request.call.arguments["create"] === true;
    const resolved = await resolveWorkspacePath(
      request.workspaceRoot,
      pathArgument(request.call.name, request.call.arguments),
      {
        allowMissingLeaf: create,
        rejectSensitive: true,
      },
    );
    if (isProtectedWorkspacePath(resolved.relativePath)) {
      return deny(
        "path.protected",
        "Agent metadata and Git internals are protected",
      );
    }
    const resolvedArguments: JsonObject = {
      ...request.call.arguments,
      path: resolved.absolutePath,
    };

    if (
      request.call.name === "file_read" ||
      request.call.name === "file_search"
    ) {
      return executable(
        "allow",
        `${request.mode}.workspace_read`,
        "canonical workspace read is allowed",
        resolvedArguments,
      );
    }
    if (request.mode === "readonly") {
      return deny(
        "readonly.write_denied",
        "readonly mode does not permit file changes",
      );
    }
    return executable(
      "allow",
      `${request.mode}.workspace_patch`,
      "explicit patch inside the workspace is allowed",
      resolvedArguments,
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return pathErrorDecision(error);
    }
    const message =
      error instanceof Error ? error.message : "invalid file arguments";
    return deny("input.invalid", message);
  }
}

function processDecision(
  mode: PermissionMode,
  analysis: ProcessRiskAnalysis,
  resolvedArguments: JsonObject,
): PermissionDecision {
  if (analysis.denyAlways) {
    return deny(
      "process.deny_always",
      analysis.reasons.join("; "),
    );
  }
  if (mode === "readonly") {
    return analysis.impact === "read_only"
      ? executable(
          "allow",
          "readonly.process_read",
          analysis.reasons.join("; "),
          resolvedArguments,
        )
      : deny(
          "readonly.process_not_readonly",
          "readonly permits only exact read-only direct processes",
        );
  }
  if (analysis.impact === "read_only") {
    return executable(
      "allow",
      `${mode}.process_read`,
      analysis.reasons.join("; "),
      resolvedArguments,
    );
  }
  if (
    mode === "trusted" &&
    analysis.impact === "local_low_risk" &&
    !analysis.workspaceExecutable
  ) {
    return executable(
      "allow",
      "trusted.process_local_low_risk",
      analysis.reasons.join("; "),
      resolvedArguments,
    );
  }
  return executable(
    "ask",
    `${mode}.process_${analysis.impact}`,
    analysis.reasons.join("; "),
    resolvedArguments,
  );
}

type ExecutableResolver = (
  program: string,
  workspaceRoot: string,
) => Promise<ResolvedExecutable>;

export interface DefaultPermissionEvaluatorOptions {
  readonly resolveExecutable?: ExecutableResolver;
}

function processArguments(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string")
  ) {
    throw new TypeError("args must be an array of strings");
  }
  return [...value];
}

function timeoutArgument(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  return value as number;
}

function obviousPath(argument: string): string | undefined {
  const candidate = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : argument;
  return (
    path.isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/u.test(candidate) ||
    candidate === ".." ||
    candidate.startsWith("../") ||
    candidate.startsWith("..\\")
  )
    ? candidate
    : undefined;
}

async function canonicalizeProcessArguments(
  args: readonly string[],
  analysis: ProcessRiskAnalysis,
  workspaceRoot: string,
): Promise<readonly string[]> {
  const indexes = new Set(analysis.workspacePathArgumentIndexes);
  const resolved = [...args];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (indexes.has(index)) {
      const target = await resolveWorkspacePath(workspaceRoot, argument, {
        rejectSensitive: true,
      });
      if (isProtectedWorkspacePath(target.relativePath)) {
        throw new WorkspacePathError(
          "SENSITIVE_PATH",
          "protected paths cannot be process arguments",
        );
      }
      resolved[index] = target.absolutePath;
      continue;
    }
    const candidate = obviousPath(argument);
    if (candidate !== undefined) {
      await resolveWorkspacePath(workspaceRoot, candidate, {
        rejectSensitive: true,
      });
    }
  }
  return resolved;
}

async function evaluateProcessRequest(
  request: PermissionRequest,
  executableResolver: ExecutableResolver,
): Promise<PermissionDecision> {
  try {
    const program = request.call.arguments["program"];
    if (typeof program !== "string" || program.length === 0) {
      return deny("input.invalid", "program must be a non-empty string");
    }
    const args = processArguments(request.call.arguments["args"]);
    const timeoutMs = timeoutArgument(request.call.arguments["timeoutMs"]);
    const cwdInput = request.call.arguments["cwd"] ?? ".";
    if (typeof cwdInput !== "string" || cwdInput.length === 0) {
      return deny("input.invalid", "cwd must be a non-empty string");
    }
    const cwd = await resolveWorkspacePath(
      request.workspaceRoot,
      cwdInput,
      { rejectSensitive: true },
    );
    if (isProtectedWorkspacePath(cwd.relativePath)) {
      return deny("path.protected", "protected directories cannot be process cwd");
    }
    const details = await stat(cwd.absolutePath);
    if (!details.isDirectory()) {
      return deny("path.invalid", "process cwd must be a directory");
    }
    const executablePath = await executableResolver(
      program,
      request.workspaceRoot,
    );
    const analysis = analyzeProcess(
      executablePath.absolutePath,
      args,
      executablePath.insideWorkspace,
    );
    const canonicalArgs = await canonicalizeProcessArguments(
      args,
      analysis,
      request.workspaceRoot,
    );
    const resolvedArguments: JsonObject = {
      program: executablePath.absolutePath,
      args: [...canonicalArgs],
      cwd: cwd.absolutePath,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    return processDecision(
      request.mode,
      analysis,
      resolvedArguments,
    );
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) {
      return pathErrorDecision(error);
    }
    if (error instanceof ExecutablePathError) {
      return deny("process.invalid_executable", error.message);
    }
    const message =
      error instanceof Error ? error.message : "invalid process arguments";
    return deny("input.invalid", message);
  }
}

export class DefaultPermissionEvaluator implements PermissionEvaluator {
  readonly #resolveExecutable: ExecutableResolver;

  constructor(options: DefaultPermissionEvaluatorOptions = {}) {
    this.#resolveExecutable =
      options.resolveExecutable ?? resolveNativeExecutable;
  }

  async evaluate(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (request.call.name !== request.tool.name) {
      return deny(
        "tool.identity_mismatch",
        "tool call name does not match its definition",
      );
    }
    const expectedRisk = EXPECTED_RISK[request.call.name];
    if (expectedRisk === undefined) {
      return deny("tool.unknown", "tool is not a built-in MVP tool");
    }
    if (request.tool.riskLevel !== expectedRisk) {
      return deny(
        "tool.definition_mismatch",
        "tool risk level does not match the frozen built-in definition",
      );
    }
    return request.call.name === "shell_execute"
      ? evaluateProcessRequest(request, this.#resolveExecutable)
      : evaluateFileRequest(request);
  }
}
```

Append to `packages/policy/src/index.ts`:

```ts
export {
  DefaultPermissionEvaluator,
  type DefaultPermissionEvaluatorOptions,
} from "./default-permission-evaluator.js";
```

- [ ] **Step 4: Run permission tests with coverage and verify GREEN**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/policy
npm.cmd test -- packages/policy/test/default-permission-evaluator.test.ts
npm.cmd exec -- vitest --config packages/policy/vitest.config.ts run packages/policy/test --coverage
```

Expected:

- All permission tests pass.
- Every `ask` contains canonical `resolvedArguments`.
- Every deny omits `resolvedArguments`.
- `packages/policy/src/**` branch coverage is at least `80%`.

- [ ] **Step 5: Commit the permission engine**

```powershell
git add packages/policy/src packages/policy/test/default-permission-evaluator.test.ts
git commit -m "feat: enforce agent permission modes"
```

### Task 8: Publish exact built-in definitions and the Tool registry

**Files:**

- Create: `packages/tools/test/builtin-tools.test.ts`
- Create after RED: `packages/tools/src/definitions.ts`
- Create after RED: `packages/tools/src/builtin-tools.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**

- Produces `FILE_READ_DEFINITION`, `FILE_SEARCH_DEFINITION`, `FILE_PATCH_DEFINITION`, and `SHELL_EXECUTE_DEFINITION`.
- Produces `createBuiltinTools(): readonly Tool[]`.
- Every returned object implements frozen `Tool.execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>`.
- Registry order is stable: `file_read`, `file_search`, `file_patch`, `shell_execute`.

- [ ] **Step 1: Write the failing public registry test**

Create `packages/tools/test/builtin-tools.test.ts`:

```ts
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CheckpointStore,
  ToolExecutionContext,
} from "@agent/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBuiltinTools,
  FILE_PATCH_DEFINITION,
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
} from "../src/index.js";

let workspace = "";
const checkpoints: CheckpointStore = {
  async capture() {},
  async restore() {
    return { restoredPaths: [], removedPaths: [] };
  },
};

function context(): ToolExecutionContext {
  return {
    workspaceRoot: workspace,
    sessionId: "session-builtins",
    signal: new AbortController().signal,
    checkpoints,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "agent-builtins-"));
  await writeFile(path.join(workspace, "README.md"), "hello\n");
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("createBuiltinTools", () => {
  it("publishes four unique definitions in stable order", () => {
    const tools = createBuiltinTools();

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "file_read",
      "file_search",
      "file_patch",
      "shell_execute",
    ]);
    expect(new Set(tools.map((tool) => tool.definition.name)).size).toBe(4);
    expect(tools.map((tool) => tool.definition)).toEqual([
      FILE_READ_DEFINITION,
      FILE_SEARCH_DEFINITION,
      FILE_PATCH_DEFINITION,
      SHELL_EXECUTE_DEFINITION,
    ]);
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it("executes with the frozen ToolCall signature and preserves its ID", async () => {
    const fileRead = createBuiltinTools()[0];
    if (fileRead === undefined) {
      throw new Error("file_read is missing");
    }

    const result = await fileRead.execute(
      {
        id: "call-public-api",
        name: "file_read",
        arguments: { path: "README.md" },
      },
      context(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-public-api",
      ok: true,
      output: "hello",
    });
  });

  it("fails closed when a call reaches the wrong tool", async () => {
    const fileRead = createBuiltinTools()[0];
    if (fileRead === undefined) {
      throw new Error("file_read is missing");
    }

    const result = await fileRead.execute(
      {
        id: "call-wrong-name",
        name: "file_patch",
        arguments: { path: "README.md" },
      },
      context(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-wrong-name",
      ok: false,
      error: { code: "TOOL_IDENTITY_MISMATCH" },
    });
  });
});
```

- [ ] **Step 2: Run registry tests and verify RED**

Run:

```powershell
npm.cmd test -- packages/tools/test/builtin-tools.test.ts
```

Expected: FAIL because definitions and `createBuiltinTools` do not exist.

- [ ] **Step 3: Define exact JSON schemas and risk metadata**

Create `packages/tools/src/definitions.ts`:

```ts
import type { ToolDefinition } from "@agent/contracts";

import { FILE_PATCH_OUTPUT_LIMIT_BYTES } from "./file-patch.js";
import { FILE_READ_OUTPUT_LIMIT_BYTES } from "./file-read.js";
import { FILE_SEARCH_OUTPUT_LIMIT_BYTES } from "./file-search.js";
import { SHELL_EXECUTE_OUTPUT_LIMIT_BYTES } from "./shell-execute.js";

export const FILE_READ_DEFINITION = {
  name: "file_read",
  description:
    "Read a UTF-8 workspace file, optionally selecting inclusive one-based lines.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  },
  riskLevel: "read",
  outputLimitBytes: FILE_READ_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const FILE_SEARCH_DEFINITION = {
  name: "file_search",
  description:
    "Search UTF-8 workspace files by literal text.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 1024 },
      path: { type: "string", minLength: 1 },
      caseSensitive: { type: "boolean" },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: 500,
      },
    },
  },
  riskLevel: "read",
  outputLimitBytes: FILE_SEARCH_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const FILE_PATCH_DEFINITION = {
  name: "file_patch",
  description:
    "Create one absent UTF-8 file or apply explicit optimistic search/replace edits with a checkpoint.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      create: { type: "boolean" },
      content: { type: "string" },
      expectedSha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText"],
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            expectedOccurrences: {
              type: "integer",
              minimum: 1,
              maximum: 100,
            },
          },
        },
      },
    },
    oneOf: [
      {
        required: ["create", "content"],
        properties: {
          create: { const: true },
        },
        not: {
          anyOf: [
            { required: ["edits"] },
            { required: ["expectedSha256"] },
          ],
        },
      },
      {
        required: ["edits"],
        not: {
          anyOf: [
            {
              required: ["create"],
              properties: { create: { const: true } },
            },
            { required: ["content"] },
          ],
        },
      },
    ],
  },
  riskLevel: "write",
  outputLimitBytes: FILE_PATCH_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const SHELL_EXECUTE_DEFINITION = {
  name: "shell_execute",
  description:
    "Execute one policy-approved local shell command inside a canonical workspace directory.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        minLength: 1,
        maxLength: 8000,
      },
      cwd: { type: "string", minLength: 1 },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
      },
    },
  },
  riskLevel: "execute",
  outputLimitBytes: SHELL_EXECUTE_OUTPUT_LIMIT_BYTES,
  supportsCancellation: true,
} as const satisfies ToolDefinition;

export const BUILTIN_TOOL_DEFINITIONS = Object.freeze([
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  FILE_PATCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
] as const);
```

- [ ] **Step 4: Implement exact frozen Tool adapters**

Create `packages/tools/src/builtin-tools.ts`:

```ts
import type {
  Tool,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent/contracts";

import {
  BUILTIN_TOOL_DEFINITIONS,
  FILE_PATCH_DEFINITION,
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
} from "./definitions.js";
import { runFilePatch } from "./file-patch.js";
import { runFileRead } from "./file-read.js";
import { runFileSearch } from "./file-search.js";
import { runShellExecute } from "./shell-execute.js";
import { toolFailure } from "./tool-result.js";

type ToolRunner = (
  call: ToolCall,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

function createTool(
  definition: ToolDefinition,
  runner: ToolRunner,
): Tool {
  return {
    definition,
    async execute(
      call: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      if (call.name !== definition.name) {
        return toolFailure(
          call,
          "TOOL_IDENTITY_MISMATCH",
          `call for ${call.name} reached ${definition.name}`,
        );
      }
      return runner(call, context);
    },
  };
}

export function createBuiltinTools(): readonly Tool[] {
  const tools = [
    createTool(FILE_READ_DEFINITION, runFileRead),
    createTool(FILE_SEARCH_DEFINITION, runFileSearch),
    createTool(FILE_PATCH_DEFINITION, runFilePatch),
    createTool(SHELL_EXECUTE_DEFINITION, runShellExecute),
  ];
  if (
    tools.some(
      (tool, index) =>
        tool.definition !== BUILTIN_TOOL_DEFINITIONS[index],
    )
  ) {
    throw new Error("built-in tool order does not match definitions");
  }
  return Object.freeze(tools);
}
```

Append to `packages/tools/src/index.ts`:

```ts
export { createBuiltinTools } from "./builtin-tools.js";
export {
  BUILTIN_TOOL_DEFINITIONS,
  FILE_PATCH_DEFINITION,
  FILE_READ_DEFINITION,
  FILE_SEARCH_DEFINITION,
  SHELL_EXECUTE_DEFINITION,
} from "./definitions.js";
```

- [ ] **Step 5: Run registry and public package verification**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd test -- packages/tools/test/builtin-tools.test.ts
npm.cmd run build --workspace @agent/tools
```

Expected: all commands exit `0`; three registry tests pass; the declarations expose `createBuiltinTools` and `FileCheckpointStore`.

- [ ] **Step 6: Commit the public tools registry**

```powershell
git add packages/tools/src packages/tools/test/builtin-tools.test.ts
git commit -m "feat: publish built-in agent tools"
```

## Final Safety Acceptance

- [ ] **Gate 1: Run all package tests, strict type-checking, and builds**

Run:

```powershell
npm.cmd run typecheck --workspace @agent/tools
npm.cmd run typecheck --workspace @agent/policy
npm.cmd test -- packages/tools/test packages/policy/test
npm.cmd run build --workspace @agent/tools
npm.cmd run build --workspace @agent/policy
```

Expected:

- Every command exits `0`.
- All four built-in tool suites and both policy suites pass.
- Generated declarations consume the frozen `@agent/contracts` signatures without casts or declaration errors.

- [ ] **Gate 2: Prove Policy branch coverage is at least 80%**

Run:

```powershell
npm.cmd exec -- vitest --config packages/policy/vitest.config.ts run packages/policy/test --coverage
```

Expected: the V8 summary reports at least `80%` branch coverage for `packages/policy/src/**`; no threshold is waived.

- [ ] **Gate 3: Re-run the Windows-first security cases**

Run on Windows:

```powershell
npm.cmd test -- packages/tools/test/workspace-path.test.ts packages/tools/test/shell-execute.test.ts packages/policy/test/default-permission-evaluator.test.ts
```

Expected:

- Junction/reparse-point escape is denied.
- `NUL`, alternate data streams, and trailing-dot paths are rejected.
- Command cancellation kills the Windows child tree.
- `rm -rf /`, `Remove-Item -Recurse -Force C:\`, encoded PowerShell, and credential reads are denied.
- Install, network, Git remote, scoped delete, and ambiguous commands return `ask` in `workspace` and `trusted`.

- [ ] **Gate 4: Confirm test output does not leak the injected fake key**

Run:

```powershell
$agentToolsTestLog = Join-Path $env:TEMP 'agent-tools-policy-test.log'
npm.cmd test -- packages/tools/test packages/policy/test 2>&1 | Tee-Object -FilePath $agentToolsTestLog
if (Select-String -LiteralPath $agentToolsTestLog -SimpleMatch 'fake-secret-never-log' -Quiet) { throw 'fake key leaked into test output' }
Remove-Item -LiteralPath $agentToolsTestLog -Force
```

Expected: tests exit `0`; the explicit leak check does not throw; only the temporary test log is removed.

- [ ] **Gate 5: Inspect public composition exports**

Run:

```powershell
node -e "Promise.all([import('./packages/tools/dist/index.js'), import('./packages/policy/dist/index.js')]).then(([tools, policy]) => { const builtins = tools.createBuiltinTools(); if (builtins.length !== 4) process.exit(1); if (typeof tools.FileCheckpointStore !== 'function') process.exit(1); if (typeof policy.DefaultPermissionEvaluator !== 'function') process.exit(1); console.log('tools-policy-ok'); })"
```

Expected:

```text
tools-policy-ok
```

- [ ] **Gate 6: Verify ownership and whitespace**

Run:

```powershell
git diff --check
git status --short
git diff --name-only main...HEAD
```

Expected:

- `git diff --check` exits `0`.
- Implementation changes are limited to `packages/tools/**` and `packages/policy/**`.
- The worktree does not modify root configuration, `package-lock.json`, `packages/contracts/**`, `tests/integration/**`, `benchmarks/**`, or the approved design.

## Main-Task Integration Handoff

After this branch is reviewed and merged, the main task—not this worktree—must:

1. Run `npm.cmd install` once to add the new workspace packages and their local dependency edge to the root-owned `package-lock.json`.
2. Compose one `FileCheckpointStore`, `createBuiltinTools()`, and `DefaultPermissionEvaluator` with Core while preserving `ToolCall.id` and using only `PermissionDecision.resolvedArguments`.
3. Run `npm.cmd run verify`, integration tests, CLI tests, and the 20-task evaluation set from the integrated state.
4. Confirm no permission `ask` path reaches `Tool.execute` before `PermissionConfirmer` returns `true`.
5. Confirm a returned `ToolResult.toolCallId` mismatch is treated as a Core failure.

## Plan Self-Review

- **Spec coverage:** Tasks 2-8 cover path normalization, `..`, symlink/junction escape, sensitive paths, all four tools, checkpoints/restore, timeout, cancellation, output truncation, command danger classification, all three permission modes, Windows process trees, and exact allow/ask/deny results.
- **Contract consistency:** Every tool consumes `ToolCall`, preserves `call.id`, uses `ToolExecutionContext.checkpoints`, and returns frozen `ToolResult`; every executable permission decision contains `resolvedArguments`, while deny decisions do not.
- **Boundary consistency:** Only the two owned package trees appear in implementation commits; main-owned integration files are deferred explicitly.
- **Residual risk:** The plan does not claim OS-level sandboxing. Canonical paths are checked by Policy and checked again by Tools, but a hostile concurrent local process can still race filesystem changes.
- **Placeholder scan:** The final plan contains no deferred implementation markers or instructions to imitate another task; every test and implementation step includes exact code, commands, and expected outcomes.

## Completion Gate

Do not report the Tools/Policy worktree complete until:

1. Tasks 1-8 have one independently reviewable commit each.
2. Every Final Safety Acceptance gate passes on Windows.
3. Policy branch coverage is at least `80%`.
4. No fake key appears in test output.
5. The public import check prints `tools-policy-ok`.
6. `git diff --check` exits `0`.
7. Only `packages/tools/**` and `packages/policy/**` changed.
