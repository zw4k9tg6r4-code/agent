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
});
