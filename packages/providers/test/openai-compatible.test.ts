import type {
  ModelEvent,
  ModelRequest,
} from "@agent/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleError,
  OpenAICompatibleProvider,
  type OpenAICompatibleRuntime,
} from "../src/index.js";

const request: ModelRequest = {
  messages: [
    { role: "system", content: "safe" },
    { role: "user", content: "read" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "prior-call",
          name: "file_read",
          arguments: { path: "OLD.md" },
        },
      ],
    },
    {
      role: "tool",
      content: "old contents",
      toolCallId: "prior-call",
      name: "file_read",
    },
  ],
  tools: [
    {
      name: "file_read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      riskLevel: "read",
      outputLimitBytes: 4_096,
      supportsCancellation: true,
    },
  ],
  maxOutputTokens: 200,
  temperature: 0.2,
};

function sse(lines: readonly string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  iterable: AsyncIterable<ModelEvent>,
): Promise<readonly ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function runtime(
  fetchImplementation: typeof fetch,
  delays: number[] = [],
): OpenAICompatibleRuntime {
  return {
    fetch: fetchImplementation,
    env: { TEST_OPENAI_KEY: "secret-value" },
    async sleep(milliseconds, signal) {
      if (signal.aborted) {
        throw signal.reason;
      }
      delays.push(milliseconds);
    },
  };
}

function provider(
  fetchImplementation: typeof fetch,
  overrides: Partial<ConstructorParameters<
    typeof OpenAICompatibleProvider
  >[0]> = {},
  delays: number[] = [],
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    {
      baseUrl: "https://example.test/v1/",
      model: "test-model",
      apiKeyEnvVar: "TEST_OPENAI_KEY",
      requestTimeoutMs: 1_000,
      maxRetries: 2,
      ...overrides,
    },
    runtime(fetchImplementation, delays),
  );
}

describe("OpenAICompatibleProvider", () => {
  it("maps messages/tools and streams text, usage, and completion", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const instance = provider(fetchMock);

    await expect(
      collect(
        instance.stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).resolves.toEqual([
      { type: "text_delta", delta: "hel" },
      { type: "text_delta", delta: "lo" },
      {
        type: "usage",
        usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
      },
      { type: "completed", stopReason: "end_turn" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer secret-value",
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      stream: true,
      max_tokens: 200,
      temperature: 0.2,
      stream_options: { include_usage: true },
    });
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "file_read",
          description: "Read a file",
          parameters: request.tools[0]?.inputSchema,
        },
      },
    ]);
    expect(body["messages"]).toEqual([
      { role: "system", content: "safe" },
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "prior-call",
            type: "function",
            function: {
              name: "file_read",
              arguments: '{"path":"OLD.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: "old contents",
        tool_call_id: "prior-call",
      },
    ]);
  });

  it("assembles indexed tool call fragments before emitting a complete call", async () => {
    const instance = provider(async () =>
      sse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"file_","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    await expect(
      collect(
        instance.stream(
          { messages: request.messages, tools: request.tools },
          { signal: new AbortController().signal },
        ),
      ),
    ).resolves.toEqual([
      {
        type: "tool_call",
        call: {
          id: "call-1",
          name: "file_read",
          arguments: { path: "README.md" },
        },
      },
      { type: "completed", stopReason: "tool_use" },
    ]);
  });

  it("retries two pre-output transient failures with bounded backoff", async () => {
    const delays: number[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        sse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
    const instance = provider(fetchMock, {}, delays);

    const events = await collect(
      instance.stream(request, {
        signal: new AbortController().signal,
      }),
    );

    expect(events.at(-1)).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry authentication, missing-key, or post-output failures", async () => {
    const authFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ error: { message: "bad secret-value" } }),
        { status: 401 },
      ),
    );
    await expect(
      collect(
        provider(authFetch).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OpenAICompatibleError>>({
        code: "authentication_error",
        retryable: false,
      }),
    );
    expect(authFetch).toHaveBeenCalledTimes(1);

    const missingFetch = vi.fn<typeof fetch>();
    const missing = new OpenAICompatibleProvider(
      {
        baseUrl: "https://example.test/v1",
        model: "test-model",
        apiKeyEnvVar: "MISSING_KEY",
        requestTimeoutMs: 1_000,
      },
      {
        ...runtime(missingFetch),
        env: {},
      },
    );
    await expect(
      collect(
        missing.stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "missing_api_key" });
    expect(missingFetch).not.toHaveBeenCalled();

    const interruptedFetch = vi.fn<typeof fetch>(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
              ),
            );
            setTimeout(() => {
              controller.error(new TypeError("connection reset"));
            }, 10);
          },
        }),
      );
    });
    await expect(
      collect(
        provider(interruptedFetch).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: "stream_interrupted",
      retryable: false,
    });
    expect(interruptedFetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes request timeout and external cancellation without leaking keys", async () => {
    const waitingFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init?.signal?.reason),
            { once: true },
          );
        }),
    );
    await expect(
      collect(
        provider(waitingFetch, {
          requestTimeoutMs: 10,
          maxRetries: 0,
        }).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: "request_timeout",
      retryable: true,
    });

    const controller = new AbortController();
    const cancelled = collect(
      provider(waitingFetch).stream(request, {
        signal: controller.signal,
      }),
    );
    controller.abort("stop");
    await expect(cancelled).rejects.toMatchObject({
      code: "request_cancelled",
      retryable: false,
    });

    const backoffController = new AbortController();
    const backoffFetch = vi.fn<typeof fetch>(async () =>
      new Response("busy", { status: 503 }),
    );
    const backoffCancelled = collect(
      new OpenAICompatibleProvider(
        {
          baseUrl: "https://example.test/v1",
          model: "test-model",
          apiKeyEnvVar: "TEST_OPENAI_KEY",
          requestTimeoutMs: 1_000,
          maxRetries: 2,
        },
        {
          fetch: backoffFetch,
          env: { TEST_OPENAI_KEY: "secret-value" },
          async sleep(_milliseconds, signal) {
            backoffController.abort("stop-during-backoff");
            throw signal.reason;
          },
        },
      ).stream(request, { signal: backoffController.signal }),
    );
    await expect(backoffCancelled).rejects.toMatchObject({
      code: "request_cancelled",
      retryable: false,
    });
    expect(backoffFetch).toHaveBeenCalledTimes(1);

    for (
      const error of await Promise.allSettled([
        cancelled,
        backoffCancelled,
      ])
    ) {
      expect(JSON.stringify(error)).not.toContain("secret-value");
    }
  });

  it("redacts the exact API key from fetch and HTTP response errors", async () => {
    const fetchThrowsKey = vi.fn<typeof fetch>(async () => {
      throw new Error(
        "transport saw Authorization: Bearer secret-value",
      );
    });
    let thrownFetchError: unknown;
    try {
      await collect(
        provider(fetchThrowsKey, { maxRetries: 0 }).stream(request, {
          signal: new AbortController().signal,
        }),
      );
    } catch (error) {
      thrownFetchError = error;
    }
    expect(thrownFetchError).toBeInstanceOf(OpenAICompatibleError);
    if (!(thrownFetchError instanceof OpenAICompatibleError)) {
      throw new Error("Expected OpenAICompatibleError.");
    }
    expect((thrownFetchError as OpenAICompatibleError).message).toContain("[REDACTED]");
    expect((thrownFetchError as OpenAICompatibleError).message).not.toContain("secret-value");
    expect(String((thrownFetchError as OpenAICompatibleError).cause)).not.toContain("secret-value");

    const responseEchoesKey = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "upstream echoed secret-value",
          },
        }),
        { status: 400 },
      ),
    );
    let responseError: unknown;
    try {
      await collect(
        provider(responseEchoesKey).stream(request, {
          signal: new AbortController().signal,
        }),
      );
    } catch (error) {
      responseError = error;
    }
    expect(responseError).toBeInstanceOf(OpenAICompatibleError);
    if (!(responseError instanceof OpenAICompatibleError)) {
      throw new Error("Expected OpenAICompatibleError.");
    }
    expect((responseError as OpenAICompatibleError).message).toContain("[REDACTED]");
    expect((responseError as OpenAICompatibleError).message).not.toContain("secret-value");
  });

  it("rejects invalid config and malformed SSE without a network retry", async () => {
    expect(
      () =>
        provider(async () => sse([]), {
          maxRetries: 3,
        }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_provider_config" }),
    );

    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(["data: not-json\n\n"]),
    );
    await expect(
      collect(
        provider(fetchMock).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_sse_payload",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects plain http API endpoints except loopback", () => {
    expect(() =>
      provider(async () => sse([]), { baseUrl: "http://example.test/v1" }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_provider_config" }),
    );
    expect(() =>
      provider(async () => sse([]), {
        baseUrl: "http://localhost:11434/v1",
      }),
    ).not.toThrow();
  });

  it("enforces tool call limits and argument size limits", async () => {
    const fetchCallsLimit = vi.fn<typeof fetch>(async () => {
      const calls = [];
      for (let i = 0; i < 130; i++) {
        calls.push(`{"index":${i},"id":"call-${i}","type":"function","function":{"name":"file_read","arguments":"{}"}}`);
      }
      return sse([`data: {"choices":[{"delta":{"tool_calls":[${calls.join(",")}]},"finish_reason":null}]}\n\n`]);
    });
    await expect(
      collect(
        provider(fetchCallsLimit).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: "too_many_tool_calls",
      retryable: false,
    });

    const fetchArgsLimit = vi.fn<typeof fetch>(async () => {
      const args = "A".repeat(5_000_001);
      return sse([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"file_read","arguments":"${args}"}}]},"finish_reason":null}]}\n\n`,
      ]);
    });
    await expect(
      collect(
        provider(fetchArgsLimit).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: "arguments_too_large",
      retryable: false,
    });
  });

  it("enforces SSE buffer size limits", async () => {
    const fetchSseLimit = vi.fn<typeof fetch>(async () => {
      return sse([`data: ${"A".repeat(10_000_001)}\n\n`]);
    });
    await expect(
      collect(
        provider(fetchSseLimit).stream(request, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("SSE frame exceeded maximum buffer size");
  });
});
