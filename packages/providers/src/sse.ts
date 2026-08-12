function eventBoundary(
  buffer: string,
): { readonly index: number; readonly length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match?.index === undefined
    ? undefined
    : { index: match.index, length: match[0].length };
}

function eventData(event: string): string | undefined {
  const lines: string[] = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line === "data") {
      lines.push("");
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      lines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

export async function* decodeSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let totalFrames = 0;
  let doneReading = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        doneReading = true;
        buffer += decoder.decode();
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > 20_000_000) {
        throw new Error("SSE stream exceeded maximum allowed bytes (20MB).");
      }
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > 10_000_000) {
        throw new Error("SSE frame exceeded maximum buffer size");
      }
      let boundary = eventBoundary(buffer);
      while (boundary !== undefined) {
        totalFrames += 1;
        if (totalFrames > 20_000) {
          throw new Error("SSE stream exceeded maximum allowed frames.");
        }
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = eventData(rawEvent);
        if (data !== undefined) {
          yield data;
        }
        boundary = eventBoundary(buffer);
      }
    }
    if (buffer.trim().length > 0) {
      totalFrames += 1;
      if (totalFrames > 20_000) {
        throw new Error("SSE stream exceeded maximum allowed frames.");
      }
      const data = eventData(buffer);
      if (data !== undefined) {
        yield data;
      }
    }
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
