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

function sanitizeString(value: string): string {
  return value
    .replace(
      BEARER_SECRET,
      (_match, prefix: string) => `${prefix}[REDACTED]`,
    )
    .replace(
      NAMED_SECRET,
      (_match, prefix: string) => `${prefix}[REDACTED]`,
    )
    .replace(OPENAI_STYLE_SECRET, "[REDACTED]");
}

function sanitizeValue(
  value: JsonValue,
  visited: WeakSet<object>,
  depth: number,
): JsonValue {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (visited.has(value) || depth > 32) {
    return "[REDACTED]";
  }
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, visited, depth + 1));
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeValue(item, visited, depth + 1);
  }
  return result as JsonObject;
}

function sanitizeObject(value: JsonObject): JsonObject {
  const visited = new WeakSet<object>();
  return sanitizeValue(value, visited, 1) as JsonObject;
}

export function sanitizeToolResult(result: ToolResult): ToolResult {
  const common = {
    toolCallId: result.toolCallId,
    output: typeof result.output === "string" ? sanitizeString(result.output) : "",
    ...(result.metadata === undefined
      ? {}
      : { metadata: sanitizeObject(result.metadata) }),
  };
  return result.ok
    ? { ...common, ok: true }
    : {
        ...common,
        ok: false,
        error: {
          ...result.error,
          message: sanitizeString(result.error?.message ?? ""),
        },
      };
}
