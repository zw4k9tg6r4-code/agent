import { createHash, randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomic(
  absolutePath: string,
  content: Uint8Array | string,
  options: {
    readonly mode?: number;
    readonly signal: AbortSignal;
    readonly expectedSha256?: string;
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
    if (options.expectedSha256 !== undefined) {
      let currentHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        currentHandle = await open(absolutePath, "r");
        const current = await currentHandle.readFile();
        if (createHash("sha256").update(current).digest("hex") !== options.expectedSha256) {
          throw new Error("checkpoint checksum failed during atomic write");
        }
        await currentHandle.close();
        currentHandle = undefined;
        await rename(temporaryPath, absolutePath);
      } finally {
        await currentHandle?.close();
      }
    } else {
      await rename(temporaryPath, absolutePath);
    }
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
