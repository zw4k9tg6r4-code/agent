import { describe, expect, it } from "vitest";

import { decodeSseData } from "../src/sse.js";

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<readonly string[]> {
  const values: string[] = [];
  for await (const value of decodeSseData(stream)) {
    values.push(value);
  }
  return values;
}

describe("decodeSseData", () => {
  it("decodes LF events split through JSON and UTF-8 byte boundaries", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"text":"你好"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 4));
        controller.enqueue(bytes.slice(bytes.length - 4));
        controller.close();
      },
    });

    await expect(collect(stream)).resolves.toEqual(['{"text":"你好"}']);
  });

  it("supports CRLF, comments, and multiple data lines", async () => {
    await expect(
      collect(
        byteStream([
          ": keep-alive\r\n",
          "event: message\r\ndata: first\r\n",
          "data: second\r\n\r\n",
          "data: [DONE]\r\n\r\n",
        ]),
      ),
    ).resolves.toEqual(["first\nsecond", "[DONE]"]);
  });

  it("flushes a final event without a trailing blank line", async () => {
    await expect(
      collect(byteStream(['data: {"final":true}'])),
    ).resolves.toEqual(['{"final":true}']);
  });

  it("ignores events that contain no data field", async () => {
    await expect(
      collect(byteStream(["event: ping\nid: 1\n\n"])),
    ).resolves.toEqual([]);
  });
  it("handles empty data frames", async () => {
    await expect(
      collect(byteStream(["data\n\n"])),
    ).resolves.toEqual([""]);
  });

  it("throws on exceeding max bytes", async () => {
    const big = new Uint8Array(21_000_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      }
    });
    await expect(collect(stream)).rejects.toThrow("SSE stream exceeded maximum allowed bytes");
  });

  it("throws on exceeding max buffer size", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Enqueue 11MB of text without newlines
        const big = new Uint8Array(11_000_000);
        big.fill(97); // 'a'
        controller.enqueue(big);
        controller.close();
      }
    });
    await expect(collect(stream)).rejects.toThrow("SSE frame exceeded maximum buffer size");
  });

  it("throws on exceeding max frames in loop", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const payload = "data: x\n\n".repeat(20_001);
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    });
    await expect(collect(stream)).rejects.toThrow("SSE stream exceeded maximum allowed frames");
  });

  it("throws on exceeding max frames at end", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let payload = "data: x\n\n".repeat(20_000);
        payload += "data: final";
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    });
    await expect(collect(stream)).rejects.toThrow("SSE stream exceeded maximum allowed frames");
  });

  it("cancels reader on throw", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
      },
      cancel() {
        cancelled = true;
      }
    });
    const iter = decodeSseData(stream)[Symbol.asyncIterator]();
    await iter.next();
    await iter.return?.();
    expect(cancelled).toBe(true);
  });
});
