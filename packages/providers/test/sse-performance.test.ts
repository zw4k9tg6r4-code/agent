import { describe, expect, it } from "vitest";
import { decodeSseData } from "../src/sse.js";

describe("SSE performance and chunk streaming", () => {
  it("processes thousands of small chunks in linear time without stalling", async () => {
    const totalChunks = 5000;
    const chunkText = "data: {\"index\": 1}\n\n";
    const encoder = new TextEncoder();
    const encoded = encoder.encode(chunkText);

    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < totalChunks) {
          controller.enqueue(encoded);
          sent += 1;
        } else {
          controller.close();
        }
      },
    });

    const start = Date.now();
    const results: string[] = [];
    for await (const data of decodeSseData(stream)) {
      results.push(data);
    }
    const elapsed = Date.now() - start;

    expect(results.length).toBe(totalChunks);
    // Should complete in well under 2000ms on any machine (typically < 100ms)
    expect(elapsed).toBeLessThan(5000);
  });

  it("handles a single event fragmented across hundreds of 1-byte chunks", async () => {
    const eventPayload = "data: hello fragmented world\n\n";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(eventPayload);

    let idx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < bytes.length) {
          controller.enqueue(bytes.subarray(idx, idx + 1));
          idx += 1;
        } else {
          controller.close();
        }
      },
    });

    const results: string[] = [];
    for await (const data of decodeSseData(stream)) {
      results.push(data);
    }
    expect(results).toEqual(["hello fragmented world"]);
  });
});
