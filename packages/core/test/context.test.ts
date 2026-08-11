import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextError,
  NodeProjectContextLoader,
  compactModelMessages,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "agent-core-context-"));
  temporaryDirectories.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) => rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("NodeProjectContextLoader", () => {
  it("orders safety, AGENTS.md, and enabled Skills", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "AGENTS.md"), "PROJECT-RULE", "utf8");
    await mkdir(join(workspace, ".agent", "skills", "review"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agent", "skills", "review", "SKILL.md"),
      "SKILL-RULE",
      "utf8",
    );

    const loader = new NodeProjectContextLoader("SAFETY-RULE");
    const result = await loader.load({
      workspaceRoot: workspace,
      enabledSkills: ["review"],
      skillsDirectory: ".agent/skills",
      maxContextTokens: 1_000,
      signal: new AbortController().signal,
    });

    expect(result.systemPrompt.indexOf("SAFETY-RULE")).toBeLessThan(
      result.systemPrompt.indexOf("PROJECT-RULE"),
    );
    expect(result.systemPrompt.indexOf("PROJECT-RULE")).toBeLessThan(
      result.systemPrompt.indexOf("SKILL-RULE"),
    );
    expect(result.sources).toEqual([
      "AGENTS.md",
      ".agent/skills/review/SKILL.md",
    ]);
    expect(result.compacted).toBe(false);
  });

  it("loads only explicitly enabled Skills and compacts lowest priority first", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "AGENTS.md"), "KEEP-PROJECT", "utf8");
    for (const name of ["first", "second"]) {
      await mkdir(join(workspace, ".agent", "skills", name), {
        recursive: true,
      });
      await writeFile(
        join(workspace, ".agent", "skills", name, "SKILL.md"),
        `${name}-${"x".repeat(600)}`,
        "utf8",
      );
    }

    const loader = new NodeProjectContextLoader("KEEP-SAFETY");
    const result = await loader.load({
      workspaceRoot: workspace,
      enabledSkills: ["first", "second"],
      skillsDirectory: ".agent/skills",
      maxContextTokens: 210,
      signal: new AbortController().signal,
    });

    expect(result.systemPrompt).toContain("KEEP-SAFETY");
    expect(result.systemPrompt).toContain("KEEP-PROJECT");
    expect(result.systemPrompt).toContain("first-");
    expect(result.systemPrompt).not.toContain("second-");
    expect(result.systemPrompt).toContain("Compacted Skills: second");
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThanOrEqual(210);
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens);
  });

  it("rejects traversal names and Skill symlinks that escape the workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "SKILL.md"), "outside", "utf8");
    await mkdir(join(workspace, ".agent", "skills"), { recursive: true });

    await expect(
      new NodeProjectContextLoader("safe").load({
        workspaceRoot: workspace,
        enabledSkills: ["../outside"],
        skillsDirectory: ".agent/skills",
        maxContextTokens: 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_skill_name" });

    const link = join(workspace, ".agent", "skills", "escaped");
    try {
      await symlink(outside, link, "junction");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }

    await expect(
      new NodeProjectContextLoader("safe").load({
        workspaceRoot: workspace,
        enabledSkills: ["escaped"],
        skillsDirectory: ".agent/skills",
        maxContextTokens: 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "context_path_escape" });
  });

  it("fails instead of discarding safety or project instructions", async () => {
    const workspace = await makeWorkspace();
    await writeFile(
      join(workspace, "AGENTS.md"),
      `critical-${"x".repeat(2_000)}`,
      "utf8",
    );

    await expect(
      new NodeProjectContextLoader("safety").load({
        workspaceRoot: workspace,
        enabledSkills: [],
        skillsDirectory: ".agent/skills",
        maxContextTokens: 20,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ContextError>>({
        code: "required_context_exceeds_limit",
      }),
    );
  });
});

describe("compactModelMessages", () => {
  it("preserves system and user goals while removing old assistant detail", () => {
    const result = compactModelMessages(
      [
        { role: "system", content: "SAFETY" },
        { role: "user", content: "ORIGINAL-GOAL" },
        { role: "assistant", content: "old-detail-".repeat(100) },
        { role: "user", content: "LATEST-INSTRUCTION" },
      ],
      30,
    );

    expect(result.messages.map((message) => message.content).join("\n"))
      .toContain("SAFETY");
    expect(result.messages.map((message) => message.content).join("\n"))
      .toContain("ORIGINAL-GOAL");
    expect(result.messages.map((message) => message.content).join("\n"))
      .toContain("LATEST-INSTRUCTION");
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThanOrEqual(30);
  });
});
