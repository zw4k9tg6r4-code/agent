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
  loadProviderProfile,
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

  it("validates skill names and limits", () => {
    const valid = parseAgentConfig({
      ...DEFAULT_CONFIG,
      skills: ["review", "test.v1", "build-step_1"],
    });
    expect(valid.skills).toEqual(["review", "test.v1", "build-step_1"]);

    expect(() => parseAgentConfig({
      ...DEFAULT_CONFIG,
      skills: ["invalid skill with spaces"],
    })).toThrowError(/skills\[0\]/);

    expect(() => parseAgentConfig({
      ...DEFAULT_CONFIG,
      skills: Array.from({ length: 51 }, (_, i) => `skill${i}`),
    })).toThrowError(/skills array length exceeds maximum limit/);
  });

  it("validates numerical limit ceilings", () => {
    expect(() => parseAgentConfig({
      ...DEFAULT_CONFIG,
      limits: { ...DEFAULT_CONFIG.limits, maxSteps: 10001 },
    })).toThrowError(/limits.maxSteps/);

    expect(() => parseAgentConfig({
      ...DEFAULT_CONFIG,
      limits: { ...DEFAULT_CONFIG.limits, maxContextTokens: 3000000 },
    })).toThrowError(/limits.maxContextTokens/);

    expect(() => parseAgentConfig({
      ...DEFAULT_CONFIG,
      limits: { ...DEFAULT_CONFIG.limits, timeoutMs: 90000000 },
    })).toThrowError(/limits.timeoutMs/);
  });

  it("loads provider profile from the new location and the legacy fallback", async () => {
    const testHome = await workspace();
    const agentHome = join(testHome, ".agent");
    const legacyHome = join(testHome, ".gemini", "agent");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(agentHome, { recursive: true });
    await mkdir(legacyHome, { recursive: true });

    const originalHome = process.env["AGENT_HOME"];
    process.env["AGENT_HOME"] = testHome;

    try {
      // New location takes precedence when both exist.
      await writeFile(
        join(agentHome, "profiles.json"),
        JSON.stringify({
          default: {
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
          },
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            apiKeyEnv: "ANTHROPIC_API_KEY",
          },
        }),
      );
      await writeFile(
        join(legacyHome, "profiles.json"),
        JSON.stringify({
          default: {
            baseUrl: "https://legacy.example.com/v1",
            apiKeyEnv: "LEGACY_API_KEY",
          },
        }),
      );

      const profile = await loadProviderProfile("default");
      expect(profile).toEqual({
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      });

      const anthropicProfile = await loadProviderProfile("anthropic");
      expect(anthropicProfile).toEqual({
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      });

      await expect(loadProviderProfile("nonexistent")).rejects.toThrow(CliError);

      // Removing the new location falls back to the legacy file.
      const { rm } = await import("node:fs/promises");
      await rm(join(agentHome, "profiles.json"));
      const legacyProfile = await loadProviderProfile("default");
      expect(legacyProfile).toEqual({
        baseUrl: "https://legacy.example.com/v1",
        apiKeyEnv: "LEGACY_API_KEY",
      });

      // The legacy file still supports the v1 flat format.
      await writeFile(
        join(legacyHome, "profiles.json"),
        JSON.stringify({
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
        }),
      );

      const flatProfile = await loadProviderProfile("default");
      expect(flatProfile).toEqual({
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      });
    } finally {
      if (originalHome !== undefined) {
        process.env["AGENT_HOME"] = originalHome;
      } else {
        delete process.env["AGENT_HOME"];
      }
    }
  });
});
