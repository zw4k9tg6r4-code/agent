import type {
  JsonObject,
  JsonValue,
  ToolResult,
} from "@agent/contracts";

const NAMED_SECRET =
  /(\b(?:api[_-]?key|access[_-]?token|token|secret|password)\b\s*[:=]\s*)([^\s,;"']+)/gi;
const BEARER_SECRET =
  /(\bauthorization\b\s*:\s*bearer\s+)([^\s,;"']+)/gi;
const OPENAI_STYLE_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

export interface RedactionOptions {
  /**
   * Apply the generic `name: value` secret pattern. File-content tools
   * disable it: unquoted keys in source code would otherwise corrupt the
   * exact text the model needs to reason about.
   */
  readonly namedSecrets?: boolean;
}

function sanitizeString(
  value: string,
  options: RedactionOptions = {},
): string {
  let result = value
    .replace(
      BEARER_SECRET,
      (_match, prefix: string) => `${prefix}[REDACTED]`,
    )
    .replace(OPENAI_STYLE_SECRET, "[REDACTED]");
  if (options.namedSecrets !== false) {
    result = result.replace(
      NAMED_SECRET,
      (_match, prefix: string) => `${prefix}[REDACTED]`,
    );
  }
  return result;
}

function sanitizeValue(
  value: JsonValue,
  visited: WeakSet<object>,
  depth: number,
  options: RedactionOptions,
): JsonValue {
  if (typeof value === "string") {
    return sanitizeString(value, options);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (visited.has(value) || depth > 32) {
    return "[REDACTED]";
  }
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, visited, depth + 1, options));
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeValue(item, visited, depth + 1, options);
  }
  return result as JsonObject;
}

function sanitizeObject(
  value: JsonObject,
  options: RedactionOptions,
): JsonObject {
  const visited = new WeakSet<object>();
  return sanitizeValue(value, visited, 1, options) as JsonObject;
}

export function sanitizeToolResult(
  result: ToolResult,
  options: RedactionOptions = {},
): ToolResult {
  // Metadata and error messages never contain model-reasoning content, so
  // they are always fully redacted even when the caller disables
  // namedSecrets for file-content output.
  const strict: RedactionOptions = { ...options, namedSecrets: true };
  const common = {
    toolCallId: result.toolCallId,
    output:
      typeof result.output === "string"
        ? sanitizeString(result.output, options)
        : "",
    ...(result.metadata === undefined
      ? {}
      : { metadata: sanitizeObject(result.metadata, strict) }),
  };
  return result.ok
    ? { ...common, ok: true }
    : {
        ...common,
        ok: false,
        error: {
          ...result.error,
          message: sanitizeString(result.error?.message ?? "", strict),
        },
      };
}
