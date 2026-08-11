import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isPermissionMode,
  type AgentRunLimits,
  type PermissionMode,
} from "@agent/contracts";

import { CliError, EXIT_CODES } from "./errors.js";

export interface OpenAICompatibleConfig {
  readonly kind: "openai-compatible";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
}

export interface AgentConfig {
  readonly version: 1;
  readonly provider: OpenAICompatibleConfig;
  readonly permissionMode: PermissionMode;
  readonly limits: AgentRunLimits;
  readonly skills: readonly string[];
}

export const DEFAULT_CONFIG: AgentConfig = {
  version: 1,
  provider: {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    requestTimeoutMs: 60_000,
    maxRetries: 2,
  },
  permissionMode: "workspace",
  limits: {
    maxSteps: 30,
    maxContextTokens: 64_000,
    maxOutputTokens: 8_000,
    timeoutMs: 300_000,
  },
  skills: [],
};

function configError(message: string): CliError {
  return new CliError(
    "CONFIG_ERROR",
    EXIT_CODES.usageOrConfig,
    `invalid ".agent/config.json": ${message}`,
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configError(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw configError(`${path} must be a positive integer`);
  }
  return value as number;
}

function retryCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2) {
    throw configError("provider.maxRetries must be an integer from 0 to 2");
  }
  return value as number;
}

function baseUrl(value: unknown): string {
  const raw = text(value, "provider.baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError("provider.baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configError("provider.baseUrl must be an absolute HTTP(S) URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function environmentName(value: unknown): string {
  const name = text(value, "provider.apiKeyEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw configError(
      "provider.apiKeyEnv must be a valid environment variable name",
    );
  }
  return name;
}

function skillNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw configError("skills must be an array of names");
  }
  return value.map((entry, index) => {
    const name = text(entry, `skills[${index}]`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
      throw configError(
        `skills[${index}] must contain only letters, digits, dot, underscore, or hyphen`,
      );
    }
    return name;
  });
}

export function parseAgentConfig(value: unknown): AgentConfig {
  const root = record(value, "configuration");
  if (root["version"] !== 1) throw configError("version must be 1");
  const provider = record(root["provider"], "provider");
  if (provider["kind"] !== "openai-compatible") {
    throw configError('provider.kind must be "openai-compatible"');
  }
  const mode = root["permissionMode"];
  if (typeof mode !== "string" || !isPermissionMode(mode)) {
    throw configError(
      "permissionMode must be readonly, workspace, or trusted",
    );
  }
  const limits = record(root["limits"], "limits");
  return {
    version: 1,
    provider: {
      kind: "openai-compatible",
      baseUrl: baseUrl(provider["baseUrl"]),
      model: text(provider["model"], "provider.model"),
      apiKeyEnv: environmentName(provider["apiKeyEnv"]),
      requestTimeoutMs: positiveInteger(
        provider["requestTimeoutMs"],
        "provider.requestTimeoutMs",
      ),
      maxRetries: retryCount(provider["maxRetries"]),
    },
    permissionMode: mode,
    limits: {
      maxSteps: positiveInteger(limits["maxSteps"], "limits.maxSteps"),
      maxContextTokens: positiveInteger(
        limits["maxContextTokens"],
        "limits.maxContextTokens",
      ),
      maxOutputTokens: positiveInteger(
        limits["maxOutputTokens"],
        "limits.maxOutputTokens",
      ),
      timeoutMs: positiveInteger(limits["timeoutMs"], "limits.timeoutMs"),
    },
    skills: skillNames(root["skills"]),
  };
}

export async function loadAgentConfig(
  workspaceRoot: string,
): Promise<AgentConfig> {
  const path = join(workspaceRoot, ".agent", "config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code: string }).code === "ENOENT"
    ) {
      throw new CliError(
        "CONFIG_ERROR",
        EXIT_CODES.usageOrConfig,
        `missing ${path}; run "agent init" in the workspace first`,
      );
    }
    throw error;
  }

  try {
    return parseAgentConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw configError("file is not valid JSON");
  }
}

export function resolveApiKey(
  config: AgentConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment[config.provider.apiKeyEnv]?.trim();
  if (value === undefined || value.length === 0) {
    throw new CliError(
      "CONFIG_ERROR",
      EXIT_CODES.usageOrConfig,
      `missing API key: set environment variable ${config.provider.apiKeyEnv}`,
    );
  }
  return value;
}
