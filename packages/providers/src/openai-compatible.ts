import type {
  JsonObject,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelProviderOptions,
  ModelRequest,
  ModelStopReason,
  TokenUsage,
  ToolCall,
} from "@agent/contracts";

import { decodeSseData } from "./sse.js";

export interface OpenAICompatibleProviderConfig {
  readonly id?: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnvVar: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries?: number;
  readonly temperature?: number;
}

export interface OpenAICompatibleRuntime {
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export class OpenAICompatibleError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OpenAICompatibleError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

interface MutableToolCall {
  id: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactApiKey(message: string, apiKey: string): string {
  return message.replaceAll(apiKey, "[REDACTED]");
}

function safeCause(error: unknown, apiKey: string): Error | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return new Error(redactApiKey(error.message, apiKey));
}

function normalizeProviderError(
  error: unknown,
  apiKey: string,
): OpenAICompatibleError {
  if (error instanceof OpenAICompatibleError) {
    return new OpenAICompatibleError(
      error.code,
      redactApiKey(error.message, apiKey),
      error.retryable,
      error.status,
      safeCause(error.cause, apiKey),
    );
  }
  return new OpenAICompatibleError(
    "provider_error",
    redactApiKey(
      error instanceof Error ? error.message : "Provider failed.",
      apiKey,
    ),
    false,
    undefined,
    safeCause(error, apiKey),
  );
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new OpenAICompatibleError(
      "invalid_provider_config",
      `${field} must not be empty.`,
      false,
    );
  }
  return normalized;
}

function validateConfig(
  config: OpenAICompatibleProviderConfig,
): Required<Omit<OpenAICompatibleProviderConfig, "id" | "temperature">> &
  Pick<OpenAICompatibleProviderConfig, "id" | "temperature"> {
  const baseUrl = requireNonEmpty(config.baseUrl, "baseUrl").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new OpenAICompatibleError(
      "invalid_provider_config",
      "baseUrl must be an absolute HTTP(S) URL.",
      false,
      undefined,
      error,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OpenAICompatibleError(
      "invalid_provider_config",
      "baseUrl must use http or https.",
      false,
    );
  }
  if (
    !Number.isInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 1
  ) {
    throw new OpenAICompatibleError(
      "invalid_provider_config",
      "requestTimeoutMs must be a positive integer.",
      false,
    );
  }
  const maxRetries = config.maxRetries ?? 2;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new OpenAICompatibleError(
      "invalid_provider_config",
      "maxRetries must be an integer from 0 through 2.",
      false,
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnvVar)) {
    throw new OpenAICompatibleError(
      "invalid_provider_config",
      "apiKeyEnvVar must be a valid environment variable name.",
      false,
    );
  }
  return {
    baseUrl,
    model: requireNonEmpty(config.model, "model"),
    apiKeyEnvVar: config.apiKeyEnvVar,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries,
    ...(config.id === undefined ? {} : { id: config.id }),
    ...(config.temperature === undefined
      ? {}
      : { temperature: config.temperature }),
  };
}

function mapMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  return { role: message.role, content: message.content };
}

function requestBody(
  config: ReturnType<typeof validateConfig>,
  request: ModelRequest,
): Record<string, unknown> {
  return {
    model: config.model,
    messages: request.messages.map(mapMessage),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_tokens: request.maxOutputTokens }),
    ...((request.temperature ?? config.temperature) === undefined
      ? {}
      : { temperature: request.temperature ?? config.temperature }),
  };
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = value["prompt_tokens"];
  const outputTokens = value["completion_tokens"];
  const totalTokens = value["total_tokens"];
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }
  if (
    !Number.isInteger(inputTokens) || inputTokens < 0 || inputTokens > 100_000_000 ||
    !Number.isInteger(outputTokens) || outputTokens < 0 || outputTokens > 100_000_000 ||
    !Number.isInteger(totalTokens) || totalTokens < 0 || totalTokens > 100_000_000
  ) {
    throw new OpenAICompatibleError(
      "invalid_provider_response",
      "Usage metrics must be non-negative integers up to 100,000,000.",
      false
    );
  }
  return { inputTokens, outputTokens, totalTokens };
}

function parseArguments(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new OpenAICompatibleError(
      "invalid_tool_arguments",
      "Streamed tool arguments are not valid JSON.",
      false,
      undefined,
      error,
    );
  }
  if (!isRecord(parsed)) {
    throw new OpenAICompatibleError(
      "invalid_tool_arguments",
      "Streamed tool arguments must be a JSON object.",
      false,
    );
  }
  return parsed as JsonObject;
}

function stopReason(value: string): ModelStopReason {
  if (value === "stop") {
    return "end_turn";
  }
  if (value === "length") {
    return "length";
  }
  if (value === "tool_calls" || value === "function_call") {
    return "tool_use";
  }
  throw new OpenAICompatibleError(
    "unsupported_finish_reason",
    `Unsupported OpenAI finish_reason: ${value}`,
    false,
  );
}

function collectToolFragments(
  value: unknown,
  calls: Map<number, MutableToolCall>,
  state: { argumentsBytes: number },
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const fragment of value) {
    if (!isRecord(fragment) || typeof fragment["index"] !== "number") {
      continue;
    }
    const index = fragment["index"];
    const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
    if (calls.size >= 128 && !calls.has(index)) {
      throw new OpenAICompatibleError("too_many_tool_calls", "Exceeded maximum allowed tool calls.", false);
    }
    if (typeof fragment["id"] === "string") {
      existing.id += fragment["id"];
      if (existing.id.length > 256) {
        throw new OpenAICompatibleError("tool_id_too_large", "Tool ID exceeded maximum length.", false);
      }
    }
    const fn = fragment["function"];
    if (isRecord(fn)) {
      if (typeof fn["name"] === "string") {
        existing.name += fn["name"];
        if (existing.name.length > 256) {
          throw new OpenAICompatibleError("tool_name_too_large", "Tool name exceeded maximum length.", false);
        }
      }
      if (typeof fn["arguments"] === "string") {
        existing.arguments += fn["arguments"];
        state.argumentsBytes += fn["arguments"].length;
        if (state.argumentsBytes > 5_000_000) {
          throw new OpenAICompatibleError("arguments_too_large", "Aggregate tool arguments exceeded maximum length.", false);
        }
      }
    }
    calls.set(index, existing);
  }
}

function completeToolCalls(calls: Map<number, MutableToolCall>): ToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (call.id.length === 0 || call.name.length === 0) {
        throw new OpenAICompatibleError(
          "invalid_tool_call",
          "Streamed tool call is missing id or function name.",
          false,
        );
      }
      return {
        id: call.id,
        name: call.name,
        arguments: parseArguments(call.arguments),
      };
    });
}

async function httpError(
  response: Response,
  apiKeyEnvVar: string,
  apiKey: string,
): Promise<OpenAICompatibleError> {
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (text.length < 4_096) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Ignore stream errors during error reading
    } finally {
      reader.cancel().catch(() => {});
    }
    text = text.slice(0, 4_096);
  } else {
    text = (await response.text()).slice(0, 4_096);
  }
  let providerMessage = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      isRecord(parsed["error"]) &&
      typeof parsed["error"]["message"] === "string"
    ) {
      providerMessage = redactApiKey(
        parsed["error"]["message"],
        apiKey,
      );
    }
  } catch {
    providerMessage = redactApiKey(text, apiKey);
  }
  if (response.status === 401 || response.status === 403) {
    return new OpenAICompatibleError(
      "authentication_error",
      `Authentication failed. Set a valid value for ${apiKeyEnvVar}.`,
      false,
      response.status,
    );
  }
  const retryable =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500;
  return new OpenAICompatibleError(
    retryable ? "temporary_provider_error" : "provider_request_error",
    providerMessage || `Provider returned HTTP ${response.status}.`,
    retryable,
    response.status,
  );
}

function normalizeThrown(
  error: unknown,
  externalSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  apiKey: string,
): OpenAICompatibleError {
  if (error instanceof OpenAICompatibleError) {
    return normalizeProviderError(error, apiKey);
  }
  if (externalSignal.aborted) {
    return new OpenAICompatibleError(
      "request_cancelled",
      "The model request was cancelled.",
      false,
      undefined,
      safeCause(error, apiKey),
    );
  }
  if (timeoutSignal.aborted) {
    return new OpenAICompatibleError(
      "request_timeout",
      "The model request exceeded requestTimeoutMs.",
      true,
      undefined,
      safeCause(error, apiKey),
    );
  }
  if (error instanceof TypeError) {
    return new OpenAICompatibleError(
      "network_error",
      "The model endpoint could not be reached.",
      true,
      undefined,
      safeCause(error, apiKey),
    );
  }
  return new OpenAICompatibleError(
    "provider_error",
    redactApiKey(
      error instanceof Error ? error.message : "The model provider failed.",
      apiKey,
    ),
    false,
    undefined,
    safeCause(error, apiKey),
  );
}

async function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abortHandler = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abortHandler);
      resolve();
    }, milliseconds);
  });
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly #config: ReturnType<typeof validateConfig>;
  readonly #runtime: OpenAICompatibleRuntime;

  constructor(
    config: OpenAICompatibleProviderConfig,
    runtime: OpenAICompatibleRuntime = {
      fetch: globalThis.fetch,
      env: process.env,
      sleep: defaultSleep,
    },
  ) {
    this.#config = validateConfig(config);
    this.#runtime = runtime;
    this.id = this.#config.id ?? `openai-compatible:${this.#config.model}`;
  }

  async *stream(
    request: ModelRequest,
    options: ModelProviderOptions,
  ): AsyncIterable<ModelEvent> {
    const apiKey = this.#runtime.env[this.#config.apiKeyEnvVar];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new OpenAICompatibleError(
        "missing_api_key",
        `Set ${this.#config.apiKeyEnvVar} before running the Agent.`,
        false,
      );
    }

    for (let attempt = 0; attempt <= this.#config.maxRetries; attempt += 1) {
      let emitted = false;
      try {
        for await (const event of this.#streamAttempt(
          request,
          options.signal,
          apiKey,
        )) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const normalized = normalizeProviderError(error, apiKey);
        if (emitted && normalized.retryable) {
          throw new OpenAICompatibleError(
            "stream_interrupted",
            "The model stream failed after output began; it was not retried to avoid duplicate events.",
            false,
            normalized.status,
            safeCause(normalized, apiKey),
          );
        }
        if (
          !normalized.retryable ||
          attempt === this.#config.maxRetries ||
          options.signal.aborted
        ) {
          throw normalized;
        }
        try {
          await this.#runtime.sleep(
            100 * (2 ** attempt),
            options.signal,
          );
        } catch (sleepError) {
          if (options.signal.aborted) {
            throw new OpenAICompatibleError(
              "request_cancelled",
              "The model request was cancelled.",
              false,
              undefined,
              safeCause(sleepError, apiKey),
            );
          }
          throw new OpenAICompatibleError(
            "provider_backoff_failed",
            "Provider retry backoff failed.",
            false,
            undefined,
            safeCause(sleepError, apiKey),
          );
        }
      }
    }
  }

  async *#streamAttempt(
    request: ModelRequest,
    externalSignal: AbortSignal,
    apiKey: string,
  ): AsyncIterable<ModelEvent> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort("request_timeout"),
      this.#config.requestTimeoutMs,
    );
    const signal = AbortSignal.any([externalSignal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await this.#runtime.fetch(
          `${this.#config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody(this.#config, request)),
            signal,
          },
        );
      } catch (error) {
        throw normalizeThrown(
          error,
          externalSignal,
          timeout.signal,
          apiKey,
        );
      }
      if (!response.ok) {
        throw await httpError(
          response,
          this.#config.apiKeyEnvVar,
          apiKey,
        );
      }
      if (response.body === null) {
        throw new OpenAICompatibleError(
          "missing_response_body",
          "Provider returned an empty streaming response.",
          true,
          response.status,
        );
      }

      const calls = new Map<number, MutableToolCall>();
      const state = { argumentsBytes: 0, textBytes: 0, frames: 0 };
      let usage: TokenUsage | undefined;
      let completed: ModelStopReason | undefined;
      try {
        for await (const data of decodeSseData(response.body)) {
          if (data === "[DONE]") {
            break;
          }
          let frame: unknown;
          try {
            frame = JSON.parse(data);
          } catch (error) {
            throw new OpenAICompatibleError(
              "invalid_sse_payload",
              "Provider returned a non-JSON SSE data frame.",
              false,
              response.status,
              error,
            );
          }
          if (!isRecord(frame)) {
            throw new OpenAICompatibleError(
              "invalid_sse_payload",
              "Provider SSE data frame must be a JSON object.",
              false,
              response.status,
            );
          }
          if (isRecord(frame["error"])) {
            const message =
              typeof frame["error"]["message"] === "string"
                ? redactApiKey(frame["error"]["message"], apiKey)
                : "Provider emitted a stream error.";
            throw new OpenAICompatibleError(
              "provider_stream_error",
              message,
              false,
              response.status,
            );
          }
          usage = parseUsage(frame["usage"]) ?? usage;
          const choices = frame["choices"];
          if (!Array.isArray(choices)) {
            continue;
          }
          for (const choice of choices) {
            if (!isRecord(choice)) {
              continue;
            }
            const delta = choice["delta"];
            if (isRecord(delta)) {
              if (typeof delta["content"] === "string") {
                state.textBytes += delta["content"].length;
                if (state.textBytes > 5_000_000) {
                  throw new OpenAICompatibleError("text_too_large", "Aggregate text exceeded maximum length.", false);
                }
                yield { type: "text_delta", delta: delta["content"] };
              }
              collectToolFragments(delta["tool_calls"], calls, state);
            }
            if (typeof choice["finish_reason"] === "string") {
              completed = stopReason(choice["finish_reason"]);
            }
          }
        }
      } catch (error) {
        throw normalizeThrown(
          error,
          externalSignal,
          timeout.signal,
          apiKey,
        );
      }

      for (const call of completeToolCalls(calls)) {
        yield { type: "tool_call", call };
      }
      if (usage !== undefined) {
        yield { type: "usage", usage };
      }
      if (completed === undefined) {
        throw new OpenAICompatibleError(
          "incomplete_model_stream",
          "Provider stream ended without finish_reason.",
          false,
          response.status,
        );
      }
      yield { type: "completed", stopReason: completed };
    } finally {
      clearTimeout(timer);
    }
  }
}
