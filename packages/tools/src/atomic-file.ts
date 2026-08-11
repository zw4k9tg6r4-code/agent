import {
  link,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function writeFileAtomic(
  absolutePath: string,
  content: Uint8Array | string,
  options: {
    readonly mode?: number;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  if (options.signal.aborted) {
    throw new DOMException("write cancelled", "AbortError");
  }

  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.signal.aborted) {
      throw new DOMException("write cancelled", "AbortError");
    }
    // The requested mode was applied when the temporary file was opened.
    // Rename is the commit point; no fallible operation may turn a committed
    // write into a reported failure.
    await rename(temporaryPath, absolutePath);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeFileExclusiveAtomic(
  absolutePath: string,
  content: Uint8Array | string,
  options: {
    readonly mode?: number;
    readonly signal: AbortSignal;
  },
): Promise<"created" | "exists"> {
  if (options.signal.aborted) {
    throw new DOMException("write cancelled", "AbortError");
  }

  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.signal.aborted) {
      throw new DOMException("write cancelled", "AbortError");
    }

    // Publishing a hard link is atomic and refuses to replace an existing
    // first-preimage file. Both paths are in the same checked directory.
    await link(temporaryPath, absolutePath);
    // The final link is already durable enough for this process boundary;
    // cleanup cannot change the reported publication result.
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return "created";
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return "exists";
    }
    throw error;
  }
}
