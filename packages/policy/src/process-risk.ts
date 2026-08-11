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
