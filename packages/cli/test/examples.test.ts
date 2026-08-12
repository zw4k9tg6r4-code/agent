import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAgentConfig } from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

async function example(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, "examples", path), "utf8");
}

describe("examples", () => {
  it("ships a valid config with an environment reference and enabled Skill", async () => {
    const raw = await example("config.json");
    const config = parseAgentConfig(JSON.parse(raw) as unknown);

    expect(config.provider.profileId).toBe("default");
    expect(config.skills).toEqual(["review"]);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/u);
  });

  it("ships complete AGENTS and Skill examples", async () => {
    expect(await example("AGENTS.md")).toContain("Verification");
    const skill = await example("skills/review/SKILL.md");
    expect(skill).toContain("name: review");
    expect(skill).toContain("## Workflow");
  });

  it("documents Windows npm, all commands, cancellation, and local data", async () => {
    const readme = await example("README.md");
    expect(readme).toContain("npm.cmd");
    expect(readme).toContain("agent run");
    expect(readme).toContain("agent resume");
    expect(readme).toContain("agent undo");
    expect(readme).toContain("Ctrl+C");
    expect(readme).toContain(".agent/sessions/");
    expect(readme).not.toContain(".env");
  });
});
