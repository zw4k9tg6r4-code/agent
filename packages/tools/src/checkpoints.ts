import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import type {
  CheckpointCaptureRequest,
  CheckpointRestoreRequest,
  CheckpointRestoreResult,
  CheckpointStore,
} from "@agent/contracts";

import {
  writeFileAtomic,
  writeFileExclusiveAtomic,
} from "./atomic-file.js";
import { checkpointLock, workspaceLock } from "./mutex.js";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-path.js";

const MAX_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHECKPOINT_BLOB_BYTES =
  Math.ceil((MAX_CHECKPOINT_FILE_BYTES * 4) / 3) + 16 * 1024;
const MAX_CHECKPOINT_RECORD_BYTES = 16 * 1024;
const MAX_CHECKPOINT_RECORDS = 10_000;
/** Maximum total bytes of captured file content per session (500 MB). */
const MAX_SESSION_CHECKPOINT_BYTES = 500 * 1024 * 1024;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/u;
const BLOB_NAME = /^[a-f0-9]{64}\.blob\.json$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

interface CheckpointRecord {
  readonly version: 1;
  readonly relativePath: string;
  readonly existed: boolean;
  readonly mode?: number;
  readonly blobName: string;
  readonly sha256?: string;
  readonly createdAt: string;
}

interface CheckpointBlob {
  readonly version: 1;
  readonly relativePath: string;
  readonly existed: boolean;
  readonly mode?: number;
  readonly contentBase64?: string;
  readonly sha256?: string;
  readonly createdAt: string;
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(sessionId)) {
    throw new TypeError(
      "sessionId must contain only letters, digits, dot, underscore, or dash",
    );
  }
}

function recordStem(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex");
}

function blobNameFor(relativePath: string): string {
  return `${recordStem(relativePath)}.blob.json`;
}

function comparable(value: string): string {
  return path.normalize(value).toLowerCase();
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

async function ensureDirectDirectory(
  workspaceRoot: string,
  parent: string,
  name: string,
): Promise<string> {
  const candidate = path.join(parent, name);
  await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  });
  const details = await lstat(candidate);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new WorkspacePathError(
      "PATH_ESCAPE",
      "checkpoint storage cannot contain links or non-directories",
    );
  }
  const canonical = await realpath(candidate);
  if (
    !isContained(workspaceRoot, canonical) ||
    comparable(path.dirname(canonical)) !== comparable(parent)
  ) {
    throw new WorkspacePathError(
      "PATH_ESCAPE",
      "checkpoint storage resolves outside its direct workspace parent",
    );
  }
  return canonical;
}

async function checkpointDirectory(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const canonicalRoot = await realpath(path.resolve(workspaceRoot));
  const rootDetails = await stat(canonicalRoot);
  if (!rootDetails.isDirectory()) {
    throw new WorkspacePathError(
      "WORKSPACE_NOT_DIRECTORY",
      "workspaceRoot must resolve to a directory",
    );
  }
  let current = canonicalRoot;
  for (const name of [".agent", "checkpoints", sessionId]) {
    current = await ensureDirectDirectory(canonicalRoot, current, name);
  }
  return current;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validMode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0o777
  );
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseRecord(text: string): CheckpointRecord {
  const value = objectValue(JSON.parse(text), "checkpoint record");
  const relativePath = value["relativePath"];
  const existed = value["existed"];
  const mode = value["mode"];
  const blobName = value["blobName"];
  const sha256 = value["sha256"];
  const createdAt = value["createdAt"];
  if (
    value["version"] !== 1 ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    typeof existed !== "boolean" ||
    typeof blobName !== "string" ||
    !BLOB_NAME.test(blobName) ||
    blobName !== blobNameFor(relativePath) ||
    !validDate(createdAt) ||
    (mode !== undefined && !validMode(mode)) ||
    (sha256 !== undefined &&
      (typeof sha256 !== "string" || !SHA256.test(sha256))) ||
    (existed && (mode === undefined || sha256 === undefined)) ||
    (!existed && (mode !== undefined || sha256 !== undefined))
  ) {
    throw new Error("invalid checkpoint record");
  }
  return {
    version: 1,
    relativePath,
    existed,
    blobName,
    createdAt,
    ...(mode === undefined ? {} : { mode }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function parseBlob(text: string): CheckpointBlob {
  const value = objectValue(JSON.parse(text), "checkpoint blob");
  const relativePath = value["relativePath"];
  const existed = value["existed"];
  const mode = value["mode"];
  const contentBase64 = value["contentBase64"];
  const sha256 = value["sha256"];
  const createdAt = value["createdAt"];
  if (
    value["version"] !== 1 ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    typeof existed !== "boolean" ||
    !validDate(createdAt) ||
    (mode !== undefined && !validMode(mode)) ||
    (sha256 !== undefined &&
      (typeof sha256 !== "string" || !SHA256.test(sha256))) ||
    (contentBase64 !== undefined && typeof contentBase64 !== "string") ||
    (existed &&
      (mode === undefined ||
        sha256 === undefined ||
        contentBase64 === undefined)) ||
    (!existed &&
      (mode !== undefined ||
        sha256 !== undefined ||
        contentBase64 !== undefined))
  ) {
    throw new Error("invalid checkpoint blob");
  }
  if (contentBase64 !== undefined) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        contentBase64,
      )
    ) {
      throw new Error("checkpoint blob is not canonical base64");
    }
    const content = Buffer.from(contentBase64, "base64");
    if (
      content.length > MAX_CHECKPOINT_FILE_BYTES ||
      createHash("sha256").update(content).digest("hex") !== sha256
    ) {
      throw new Error("checkpoint blob checksum or size is invalid");
    }
  }
  return {
    version: 1,
    relativePath,
    existed,
    createdAt,
    ...(mode === undefined ? {} : { mode }),
    ...(contentBase64 === undefined ? {} : { contentBase64 }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

async function readBoundedText(
  absolutePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const details = await stat(absolutePath);
  if (!details.isFile() || details.size > maxBytes) {
    throw new Error(`checkpoint metadata exceeds ${maxBytes} bytes`);
  }
  const bytes = await readFile(absolutePath, { signal });
  if (bytes.length > maxBytes) {
    throw new Error(`checkpoint metadata exceeds ${maxBytes} bytes`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readOptionalRecord(
  absolutePath: string,
  signal: AbortSignal,
): Promise<CheckpointRecord | undefined> {
  try {
    return parseRecord(
      await readBoundedText(
        absolutePath,
        MAX_CHECKPOINT_RECORD_BYTES,
        signal,
      ),
    );
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readBlob(
  absolutePath: string,
  signal: AbortSignal,
): Promise<CheckpointBlob> {
  return parseBlob(
    await readBoundedText(absolutePath, MAX_CHECKPOINT_BLOB_BYTES, signal),
  );
}

function recordFromBlob(blob: CheckpointBlob): CheckpointRecord {
  return {
    version: 1,
    relativePath: blob.relativePath,
    existed: blob.existed,
    blobName: blobNameFor(blob.relativePath),
    createdAt: blob.createdAt,
    ...(blob.mode === undefined ? {} : { mode: blob.mode }),
    ...(blob.sha256 === undefined ? {} : { sha256: blob.sha256 }),
  };
}

function validateRecordBlob(
  record: CheckpointRecord,
  blob: CheckpointBlob,
): void {
  if (
    record.relativePath !== blob.relativePath ||
    record.existed !== blob.existed ||
    record.mode !== blob.mode ||
    record.sha256 !== blob.sha256 ||
    record.createdAt !== blob.createdAt ||
    record.blobName !== blobNameFor(blob.relativePath)
  ) {
    throw new Error("checkpoint record does not match its blob");
  }
}

async function readRecords(
  directory: string,
  signal: AbortSignal,
): Promise<CheckpointRecord[]> {
  const names = (await readdir(directory)).filter((name) =>
    RECORD_NAME.test(name),
  );
  if (names.length > MAX_CHECKPOINT_RECORDS) {
    throw new Error(
      `checkpoint session exceeds ${MAX_CHECKPOINT_RECORDS} records`,
    );
  }
  const records: CheckpointRecord[] = [];
  for (const name of names) {
    const record = parseRecord(
      await readBoundedText(
        path.join(directory, name),
        MAX_CHECKPOINT_RECORD_BYTES,
        signal,
      ),
    );
    if (name !== `${recordStem(record.relativePath)}.json`) {
      throw new Error("checkpoint record filename does not match its path");
    }
    records.push(record);
  }
  records.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
  return records;
}

export class FileCheckpointStore implements CheckpointStore {
  async capture(request: CheckpointCaptureRequest): Promise<void> {
    validateSessionId(request.sessionId);
    if (request.signal.aborted) {
      throw new DOMException("checkpoint capture cancelled", "AbortError");
    }

    const target = await resolveWorkspacePath(
      request.workspaceRoot,
      request.relativePath,
      {
        allowMissingLeaf: true,
        rejectSensitive: true,
      },
    );
    if (isProtectedWorkspacePath(target.relativePath)) {
      throw new WorkspacePathError(
        "SENSITIVE_PATH",
        "Agent metadata and Git internals cannot be checkpoint targets",
      );
    }
    const directory = await checkpointDirectory(
      target.workspaceRoot,
      request.sessionId,
    );
    const stem = recordStem(target.relativePath);
    const recordPath = path.join(directory, `${stem}.json`);
    const blobPath = path.join(directory, blobNameFor(target.relativePath));
    const existingRecord = await readOptionalRecord(
      recordPath,
      request.signal,
    );
    if (existingRecord !== undefined) {
      const existingBlob = await readBlob(blobPath, request.signal);
      validateRecordBlob(existingRecord, existingBlob);
      return;
    }

    const unlock = await checkpointLock.acquire();
    try {
      const allNames = (await readdir(directory)).filter((n) => BLOB_NAME.test(n));
      if (allNames.length >= MAX_CHECKPOINT_RECORDS) {
        throw new Error(
          `checkpoint session exceeds ${MAX_CHECKPOINT_RECORDS} records`,
        );
      }
      let sessionBytes = 0;
      for (const blobFileName of allNames) {
        const blobFilePath = path.join(directory, blobFileName);
        try {
          const blobStat = await stat(blobFilePath);
          sessionBytes += blobStat.size;
        } catch {
          // Ignore missing blobs during counting
        }
      }

      const createdAt = new Date().toISOString();
      let proposedBlob: CheckpointBlob;
      if (target.exists) {
        const [content, details] = await Promise.all([
          readFile(target.absolutePath, { signal: request.signal }),
          stat(target.absolutePath),
        ]);
        if (!details.isFile()) {
          throw new Error("checkpoint targets must be files");
        }
        if (
          details.size > MAX_CHECKPOINT_FILE_BYTES ||
          content.length > MAX_CHECKPOINT_FILE_BYTES
        ) {
          throw new Error(
            `checkpoint target exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes`,
          );
        }
        proposedBlob = {
          version: 1,
          relativePath: target.relativePath,
          existed: true,
          mode: details.mode & 0o777,
          contentBase64: content.toString("base64"),
          sha256: createHash("sha256").update(content).digest("hex"),
          createdAt,
        };
      } else {
        proposedBlob = {
          version: 1,
          relativePath: target.relativePath,
          existed: false,
          createdAt,
        };
      }

      const blobString = `${JSON.stringify(proposedBlob)}\n`;
      const blobBytes = Buffer.byteLength(blobString, "utf8");
      if (sessionBytes + blobBytes > MAX_SESSION_CHECKPOINT_BYTES) {
        throw new Error(
          `checkpoint session exceeds ${MAX_SESSION_CHECKPOINT_BYTES} bytes total`,
        );
      }

      const blobPublish = await writeFileExclusiveAtomic(
        blobPath,
        blobString,
        { mode: 0o600, signal: request.signal },
      );
      // A blob without a record is a recoverable interrupted capture. The first
      // exclusively published blob remains authoritative.
      const authoritativeBlob =
        blobPublish === "created"
          ? proposedBlob
          : await readBlob(blobPath, request.signal);
      if (authoritativeBlob.relativePath !== target.relativePath) {
        throw new Error("checkpoint collision: relativePath mismatch");
      }
      const record = recordFromBlob(authoritativeBlob);
      validateRecordBlob(record, authoritativeBlob);

      await writeFileAtomic(
        recordPath,
        `${JSON.stringify(record)}\n`,
        { mode: 0o600, signal: request.signal },
      );
    } finally {
      unlock();
    }
  }

  async restore(
    request: CheckpointRestoreRequest,
  ): Promise<CheckpointRestoreResult> {
    const unlockWorkspace = await workspaceLock.acquire();
    try {
      validateSessionId(request.sessionId);
      const workspace = await resolveWorkspacePath(
        request.workspaceRoot,
        ".",
      );
      const directory = await checkpointDirectory(
        workspace.workspaceRoot,
        request.sessionId,
      );
      const records = await readRecords(directory, request.signal);
      const restoredPaths: string[] = [];
      const removedPaths: string[] = [];

    for (const record of records) {
      if (request.signal.aborted) {
        throw new DOMException("checkpoint restore cancelled", "AbortError");
      }
      const target = await resolveWorkspacePath(
        workspace.workspaceRoot,
        record.relativePath,
        {
          allowMissingLeaf: true,
          rejectSensitive: true,
        },
      );
      if (isProtectedWorkspacePath(target.relativePath)) {
        throw new WorkspacePathError(
          "SENSITIVE_PATH",
          "Agent metadata and Git internals cannot be restore targets",
        );
      }
      if (target.relativePath !== record.relativePath) {
        throw new Error(
          `checkpoint target changed after capture: ${record.relativePath}`,
        );
      }

      if (!BLOB_NAME.test(record.blobName)) {
        throw new Error("checkpoint blob name is invalid");
      }
      const blob = await readBlob(
        path.join(directory, record.blobName),
        request.signal,
      );
      validateRecordBlob(record, blob);

      if (record.existed) {
        if (
          blob.contentBase64 === undefined ||
          record.sha256 === undefined
        ) {
          throw new Error("checkpoint blob metadata is missing");
        }

        if (request.expectedHashes !== undefined) {
          const expectedSha256 = request.expectedHashes.get(record.relativePath);
          if (expectedSha256 !== undefined) {
             if (target.exists) {
                const currentBytes = await readFile(target.absolutePath, { signal: request.signal });
                const currentSha256 = createHash("sha256").update(currentBytes).digest("hex");
                if (currentSha256 !== expectedSha256) {
                   throw new Error(`checkpoint CAS failed: ${record.relativePath} was modified after capture`);
                }
             } else if (expectedSha256 !== null) {
                throw new Error(`checkpoint CAS failed: ${record.relativePath} was deleted after capture`);
             }
          }
        }

        const content = Buffer.from(blob.contentBase64, "base64");
        const digest = createHash("sha256").update(content).digest("hex");
        if (digest !== record.sha256) {
          throw new Error(`checkpoint checksum failed: ${record.relativePath}`);
        }
        await writeFileAtomic(target.absolutePath, content, {
          ...(record.mode === undefined ? {} : { mode: record.mode }),
          signal: request.signal,
        });
        restoredPaths.push(record.relativePath);
      } else {
        if (request.expectedHashes !== undefined) {
          const expectedSha256 = request.expectedHashes.get(record.relativePath);
          if (expectedSha256 !== undefined) {
             if (target.exists) {
                const currentBytes = await readFile(target.absolutePath, { signal: request.signal });
                const currentSha256 = createHash("sha256").update(currentBytes).digest("hex");
                if (currentSha256 !== expectedSha256) {
                   throw new Error(`checkpoint CAS failed: ${record.relativePath} was modified after capture`);
                }
             } else if (expectedSha256 !== null) {
                throw new Error(`checkpoint CAS failed: ${record.relativePath} was deleted after capture`);
             }
          }
        }
        await rm(target.absolutePath, { force: true });
        removedPaths.push(record.relativePath);
      }
    }

      return {
        restoredPaths,
        removedPaths,
      };
    } finally {
      unlockWorkspace();
    }
  }
}
