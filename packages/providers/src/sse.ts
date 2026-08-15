import { Buffer } from "node:buffer";

function findBoundary(
  text: string,
  fromIndex: number,
): { readonly index: number; readonly length: number } | undefined {
  const idxLf = text.indexOf("\n\n", fromIndex);
  const idxCrlf = text.indexOf("\r\n\r\n", fromIndex);
  const idxMixed = text.indexOf("\r\n\n", fromIndex);

  let bestIdx = -1;
  let bestLen = 0;

  if (idxLf !== -1) {
    bestIdx = idxLf;
    bestLen = 2;
  }
  if (idxCrlf !== -1 && (bestIdx === -1 || idxCrlf < bestIdx)) {
    bestIdx = idxCrlf;
    bestLen = 4;
  }
  if (idxMixed !== -1 && (bestIdx === -1 || idxMixed < bestIdx)) {
    bestIdx = idxMixed;
    bestLen = 3;
  }

  return bestIdx === -1 ? undefined : { index: bestIdx, length: bestLen };
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
      const prevLen = buffer.length;
      const chunkText = decoder.decode(result.value, { stream: true });
      buffer += chunkText;
      if (buffer.length > 10_000_000 || Buffer.byteLength(buffer, "utf8") > 10_000_000) {
        throw new Error("SSE frame exceeded maximum buffer size");
      }
      let searchPos = Math.max(0, prevLen - 3);
      let boundary = findBoundary(buffer, searchPos);
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
        boundary = findBoundary(buffer, 0);
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
