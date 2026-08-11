import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ModelMessage } from "@agent/contracts";

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;

export interface ProjectContextLoadInput {
  readonly workspaceRoot: string;
  readonly enabledSkills: readonly string[];
  readonly skillsDirectory: string;
  readonly maxContextTokens: number;
  readonly signal: AbortSignal;
}

export interface LoadedProjectContext {
  readonly systemPrompt: string;
  readonly sources: readonly string[];
  readonly compacted: boolean;
  readonly beforeTokens: number;
  readonly afterTokens: number;
}

export interface ProjectContextLoader {
  load(input: ProjectContextLoadInput): Promise<LoadedProjectContext>;
}

export interface CompactedMessages {
  readonly messages: readonly ModelMessage[];
  readonly compacted: boolean;
  readonly beforeTokens: number;
  readonly afterTokens: number;
}

export class ContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROXIMATE_CHARACTERS_PER_TOKEN));
}

export function estimateMessagesTokens(
  messages: readonly ModelMessage[],
): number {
  return messages.reduce(
    (total, message) => total + estimateTextTokens(message.content) + 4,
    0,
  );
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

async function resolveOptionalPath(
  path: string,
): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function resolveContainedFile(
  boundary: string,
  candidate: string,
): Promise<string | undefined> {
  const canonical = await resolveOptionalPath(candidate);
  if (canonical === undefined) {
    return undefined;
  }
  if (!isInside(boundary, canonical)) {
    throw new ContextError(
      "context_path_escape",
      `Context file resolves outside its allowed boundary: ${candidate}`,
    );
  }
  return readFile(canonical, "utf8");
}

function renderPrompt(
  baseInstructions: string,
  agents: string | undefined,
  skills: readonly { readonly name: string; readonly content: string }[],
  compactedSkillNames: readonly string[],
): string {
  const sections = [`# Agent Safety Instructions\n\n${baseInstructions}`];
  if (agents !== undefined) {
    sections.push(`# Project AGENTS.md\n\n${agents}`);
  }
  for (const skill of skills) {
    sections.push(`# Skill: ${skill.name}\n\n${skill.content}`);
  }
  if (compactedSkillNames.length > 0) {
    sections.push(`Compacted Skills: ${compactedSkillNames.join(", ")}`);
  }
  return sections.join("\n\n");
}

export class NodeProjectContextLoader implements ProjectContextLoader {
  readonly #baseInstructions: string;

  constructor(baseInstructions: string) {
    this.#baseInstructions = baseInstructions;
  }

  async load(input: ProjectContextLoadInput): Promise<LoadedProjectContext> {
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    if (!Number.isInteger(input.maxContextTokens) || input.maxContextTokens < 1) {
      throw new ContextError(
        "invalid_context_limit",
        "maxContextTokens must be a positive integer.",
      );
    }

    const workspace = await realpath(input.workspaceRoot);
    const configuredSkillsRoot = resolve(workspace, input.skillsDirectory);
    if (!isInside(workspace, configuredSkillsRoot)) {
      throw new ContextError(
        "context_path_escape",
        "The configured Skills directory escapes the workspace.",
      );
    }

    const agentsPath = resolve(workspace, "AGENTS.md");
    const agents = await resolveContainedFile(workspace, agentsPath);
    const loadedSkills: { name: string; content: string }[] = [];
    const sources: string[] = [];
    if (agents !== undefined) {
      sources.push("AGENTS.md");
    }

    for (const name of input.enabledSkills) {
      if (input.signal.aborted) {
        throw input.signal.reason;
      }
      if (!SAFE_SKILL_NAME.test(name)) {
        throw new ContextError(
          "invalid_skill_name",
          `Invalid enabled Skill name: ${name}`,
        );
      }
      const skillPath = resolve(configuredSkillsRoot, name, "SKILL.md");
      const skill = await resolveContainedFile(configuredSkillsRoot, skillPath);
      if (skill === undefined) {
        throw new ContextError(
          "skill_not_found",
          `Enabled Skill does not contain SKILL.md: ${name}`,
        );
      }
      loadedSkills.push({ name, content: skill });
      sources.push(
        `${input.skillsDirectory.replaceAll("\\", "/")}/${name}/SKILL.md`,
      );
    }

    const fullPrompt = renderPrompt(
      this.#baseInstructions,
      agents,
      loadedSkills,
      [],
    );
    const beforeTokens = estimateTextTokens(fullPrompt);
    if (beforeTokens <= input.maxContextTokens) {
      return {
        systemPrompt: fullPrompt,
        sources,
        compacted: false,
        beforeTokens,
        afterTokens: beforeTokens,
      };
    }

    const requiredPrompt = renderPrompt(
      this.#baseInstructions,
      agents,
      [],
      loadedSkills.map((skill) => skill.name),
    );
    if (estimateTextTokens(requiredPrompt) > input.maxContextTokens) {
      throw new ContextError(
        "required_context_exceeds_limit",
        "Safety instructions and AGENTS.md exceed maxContextTokens.",
      );
    }

    const kept = [...loadedSkills];
    const removed: string[] = [];
    let prompt = fullPrompt;
    while (
      kept.length > 0 &&
      estimateTextTokens(prompt) > input.maxContextTokens
    ) {
      const dropped = kept.pop();
      if (dropped !== undefined) {
        removed.unshift(dropped.name);
      }
      prompt = renderPrompt(this.#baseInstructions, agents, kept, removed);
    }

    return {
      systemPrompt: prompt,
      sources,
      compacted: true,
      beforeTokens,
      afterTokens: estimateTextTokens(prompt),
    };
  }
}

export function compactModelMessages(
  messages: readonly ModelMessage[],
  maxContextTokens: number,
): CompactedMessages {
  const beforeTokens = estimateMessagesTokens(messages);
  if (beforeTokens <= maxContextTokens) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  const requiredIndexes = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === "system" || message.role === "user") {
      requiredIndexes.add(index);
    }
  });
  const compacted: ModelMessage[] = messages.filter(
    (_message, index) => requiredIndexes.has(index),
  );
  const marker: ModelMessage = {
    role: "system",
    content: "Older assistant and tool detail was compacted from this turn.",
  };
  compacted.splice(Math.min(1, compacted.length), 0, marker);
  const afterTokens = estimateMessagesTokens(compacted);
  if (afterTokens > maxContextTokens) {
    throw new ContextError(
      "required_context_exceeds_limit",
      "System and user messages exceed maxContextTokens.",
    );
  }
  return {
    messages: compacted,
    compacted: true,
    beforeTokens,
    afterTokens,
  };
}
