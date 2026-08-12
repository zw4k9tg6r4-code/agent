import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CliError,
  DEFAULT_CONFIG,
  EXIT_CODES,
  initializeWorkspace,
  loadAgentConfig,
  parseAgentConfig,
  resolveApiKey,
} from "../src/index.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("configuration and init", () => {
  it("creates commit-safe config, session/checkpoint dirs, and ignores", async () => {
    const root = await workspace();
    const result = await initializeWorkspace(root);

    expect(result).toEqual({
      configCreated: true,
      configPath: join(root, ".agent", "config.json"),
    });
    const raw = await readFile(result.configPath, "utf8");
    expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG);
    expect(raw).not.toContain("sk-test-secret");
    expect((await stat(join(root, ".agent", "sessions"))).isDirectory()).toBe(
      true,
    );
    expect(
      (await stat(join(root, ".agent", "checkpoints"))).isDirectory(),
    ).toBe(true);
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain(".agent/sessions/");
    expect(ignore).toContain(".agent/checkpoints/");
  });

  it("is idempotent and never overwrites config", async () => {
    const root = await workspace();
    await initializeWorkspace(root);
    const path = join(root, ".agent", "config.json");
    const custom = {
      ...DEFAULT_CONFIG,
      provider: { ...DEFAULT_CONFIG.provider, model: "custom-model" },
    };
    await writeFile(path, `${JSON.stringify(custom, null, 2)}\n`, "utf8");

    expect((await initializeWorkspace(root)).configCreated).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(custom);
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore.match(/\.agent\/sessions\//gu)).toHaveLength(1);
  });

  it("loads JSON and resolves only the configured environment key", async () => {
    const root = await workspace();
    await initializeWorkspace(root);
    const config = await loadAgentConfig(root);

    expect(config.limits).toEqual({
      maxSteps: 30,
      maxContextTokens: 64_000,
      maxOutputTokens: 8_000,
      timeoutMs: 300_000,
    });
    expect(config.skills).toEqual([]);
    expect(resolveApiKey({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }, {
      OPENAI_API_KEY: "sk-test",
    })).toBe("sk-test");
  });

  it("rejects unknown permission modes with an actionable path", () => {
    expect(() => parseAgentConfig({
      ...DEFAULT_CONFIG,
      permissionMode: "admin",
    })).toThrowError(
      new CliError(
        "CONFIG_ERROR",
        EXIT_CODES.usageOrConfig,
        'invalid ".agent/config.json": permissionMode must be readonly, workspace, or trusted',
      ),
    );
  });

  it("reports the missing variable name without leaking values", () => {
    expect(() => resolveApiKey({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }, {
      OTHER_KEY: "sk-do-not-print",
    })).toThrowError(
      new CliError(
        "CONFIG_ERROR",
        EXIT_CODES.usageOrConfig,
        "missing API key: set environment variable OPENAI_API_KEY",
      ),
    );
  });
});
