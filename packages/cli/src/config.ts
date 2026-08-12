import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  isPermissionMode,
  type AgentRunLimits,
  type PermissionMode,
} from "@agent/contracts";
import { assertSafeRoot } from "./session-store.js";

import { CliError, EXIT_CODES } from "./errors.js";

export interface OpenAICompatibleConfig {
  readonly kind: "openai-compatible";
  readonly profileId: string;
  readonly model: string;
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
    profileId: "default",
    model: "gpt-4.1-mini",
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

const MAX_SAFE_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1 (max for setTimeout)

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw configError(`${path} must be a positive integer`);
  }
  return value as number;
}

function timeoutMs(value: unknown, path: string): number {
  const n = positiveInteger(value, path);
  if (n > MAX_SAFE_TIMEOUT_MS) {
    throw configError(`${path} must not exceed ${MAX_SAFE_TIMEOUT_MS} (2^31-1)`);
  }
  return n;
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
  if (parsed.protocol !== "https:") {
    if (parsed.protocol === "http:") {
      if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]") {
        throw configError("provider.baseUrl must use https:// or loopback http://");
      }
    } else {
      throw configError("provider.baseUrl must be an absolute HTTP(S) URL");
    }
  }
  return parsed.toString().replace(/\/$/u, "");
}

const TRUSTED_API_KEY_ENVS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "TEST_OPENAI_KEY",
]);

function environmentName(value: unknown): string {
  const name = text(value, "provider.apiKeyEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw configError(
      "provider.apiKeyEnv must be a valid environment variable name",
    );
  }
  if (!TRUSTED_API_KEY_ENVS.has(name)) {
    throw configError(`provider.apiKeyEnv "${name}" is not in the trusted whitelist`);
  }
  return name;
}

function skillNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw configError("skills must be an array of names");
  }
  if (value.length > 50) {
    throw configError("skills array length exceeds maximum limit of 50");
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

function profileIdString(value: unknown, path: string): string {
  const id = text(value, path);
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw configError(`${path} must contain only alphanumeric characters and hyphens`);
  }
  return id;
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
  const parsedLimits = {
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
  };
  if (parsedLimits.maxSteps > 10_000) throw configError("limits.maxSteps must not exceed 10,000");
  if (parsedLimits.maxContextTokens > 2_000_000) throw configError("limits.maxContextTokens must not exceed 2,000,000");
  if (parsedLimits.maxOutputTokens > 200_000) throw configError("limits.maxOutputTokens must not exceed 200,000");
  if (parsedLimits.timeoutMs > 86_400_000) throw configError("limits.timeoutMs must not exceed 86,400,000");

  return {
    version: 1,
    provider: {
      kind: "openai-compatible",
      profileId: profileIdString(provider["profileId"], "provider.profileId"),
      model: text(provider["model"], "provider.model"),
      requestTimeoutMs: timeoutMs(
        provider["requestTimeoutMs"],
        "provider.requestTimeoutMs",
      ),
      maxRetries: retryCount(provider["maxRetries"]),
    },
    permissionMode: mode,
    limits: parsedLimits,
    skills: skillNames(root["skills"]),
  };
}

export async function loadAgentConfig(
  workspaceRoot: string,
): Promise<AgentConfig> {
  const agentDir = join(workspaceRoot, ".agent");
  await assertSafeRoot(workspaceRoot, agentDir);
  const path = join(agentDir, "config.json");
  let raw: string;
  try {
    const st = await stat(path);
    if (st.size > 1_000_000) {
      throw new CliError("CONFIG_ERROR", EXIT_CODES.usageOrConfig, `config file exceeds 1MB limit: ${path}`);
    }
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

export interface ProviderProfile {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
}

export async function loadProviderProfile(
  profileId: string,
): Promise<ProviderProfile> {
  const baseDir = (process.env["AGENT_HOME"] ?? homedir());
  const path = join(baseDir, ".gemini", "agent", "profiles.json");
  let raw: string;
  try {
    const st = await stat(path);
    if (st.size > 1_000_000) {
      throw new CliError("CONFIG_ERROR", EXIT_CODES.usageOrConfig, `profiles file exceeds 1MB limit: ${path}`);
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      throw new CliError(
        "CONFIG_ERROR",
        EXIT_CODES.usageOrConfig,
        `missing ${path}; please configure your provider profiles`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("CONFIG_ERROR", EXIT_CODES.usageOrConfig, `file is not valid JSON: ${path}`);
  }

  // Support both v1 (flat) and v2 (named profiles map) formats.
  // v1 format (legacy): top-level object has baseUrl and apiKeyEnv directly.
  // v2 format (current): top-level object is a map of profileId -> { baseUrl, apiKeyEnv }.
  let profileRecord: Record<string, unknown> | undefined;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed)
  ) {
    const root = parsed as Record<string, unknown>;
    // v1 detection: has baseUrl/apiKeyEnv at the top level
    if (typeof root["baseUrl"] === "string" && typeof root["apiKeyEnv"] === "string") {
      // Legacy v1 flat format – treat the whole object as the profile
      profileRecord = root;
    } else {
      // v2 named-profile format
      const candidate = root[profileId];
      if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
        profileRecord = candidate as Record<string, unknown>;
      }
    }
  }

  if (profileRecord === undefined) {
    throw new CliError("CONFIG_ERROR", EXIT_CODES.usageOrConfig, `profile "${profileId}" is not a valid object in ${path}`);
  }

  try {
    return {
      baseUrl: baseUrl(profileRecord["baseUrl"]),
      apiKeyEnv: environmentName(profileRecord["apiKeyEnv"]),
    };
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError("CONFIG_ERROR", EXIT_CODES.usageOrConfig, `Invalid profile "${profileId}": ${error.message}`);
    }
    throw error;
  }
}

export function resolveApiKey(
  profile: ProviderProfile,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment[profile.apiKeyEnv]?.trim();
  if (value === undefined || value.length === 0) {
    throw new CliError(
      "CONFIG_ERROR",
      EXIT_CODES.usageOrConfig,
      `missing API key: set environment variable ${profile.apiKeyEnv}`,
    );
  }
  return value;
}
