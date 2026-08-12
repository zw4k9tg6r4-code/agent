import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "./config.js";
import { assertSafeRoot } from "./session-store.js";

const IGNORES = [".agent/sessions/", ".agent/checkpoints/"] as const;

export interface InitializeResult {
  readonly configCreated: boolean;
  readonly configPath: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as any).code === code;
}

async function ensureIgnored(workspaceRoot: string): Promise<void> {
  const path = join(workspaceRoot, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const normalized = existing.replace(/\r\n/gu, "\n");
  const lines = new Set(normalized.split("\n"));
  const missing = IGNORES.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  const separator =
    normalized.length === 0 || normalized.endsWith("\n") ? "" : "\n";
  await writeFile(
    path,
    `${normalized}${separator}${missing.join("\n")}\n`,
    "utf8",
  );
}

export async function initializeWorkspace(
  workspaceRoot: string,
): Promise<InitializeResult> {
  const root = join(workspaceRoot, ".agent");
  const configPath = join(root, "config.json");
  await assertSafeRoot(workspaceRoot);
  await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "checkpoints"), { recursive: true, mode: 0o700 });

  let configCreated = false;
  try {
    await writeFile(
      configPath,
      `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    configCreated = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await ensureIgnored(workspaceRoot);
  return { configCreated, configPath };
}
