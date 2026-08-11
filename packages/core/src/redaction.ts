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

function sanitizeValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === "object" && value !== null) {
    return sanitizeObject(value as JsonObject);
  }
  return value;
}

function sanitizeObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(
      ([key, item]) => [key, sanitizeValue(item)],
    ),
  );
}

export function sanitizeToolResult(result: ToolResult): ToolResult {
  const common = {
    toolCallId: result.toolCallId,
    output: sanitizeString(result.output),
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
          message: sanitizeString(result.error.message),
        },
      };
}
