import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  isPermissionMode,
  type JsonObject,
  type SessionEvent,
  type SessionEventData,
  type SessionEventStore,
  type SessionListItem,
  type SessionState,
  type TokenUsage,
} from "@agent/contracts";

import { CliError, EXIT_CODES } from "./errors.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EVENT_TYPES = new Set<SessionEvent["type"]>([
  "session_started",
  "turn_started",
  "user_message",
  "model_request_started",
  "model_output",
  "model_response_completed",
  "tool_requested",
  "permission_decided",
  "permission_confirmed",
  "tool_execution_started",
  "tool_completed",
  "tool_failed",
  "context_compacted",
  "turn_completed",
  "turn_failed",
  "session_completed",
  "session_failed",
  "session_cancelled",
]);
const TERMINAL_TYPES = new Set<SessionEvent["type"]>([
  "session_completed",
  "session_failed",
  "session_cancelled",
]);
const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export interface SessionDetails {
  readonly item: SessionListItem;
  readonly durationMs: number;
  readonly modelRequests: number;
  readonly toolCalls: number;
}

export interface SessionStoreOptions {
  readonly createEventId?: () => string;
  readonly lockWaitMs?: number;
  readonly now?: () => Date;
}

function dataError(message: string): CliError {
  return new CliError("DATA_ERROR", EXIT_CODES.usageOrConfig, message);
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw dataError(`invalid session id: ${sessionId}`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventError(
  sessionId: string,
  lineNumber: number,
  message: string,
): never {
  throw dataError(`session ${sessionId} line ${lineNumber}: ${message}`);
}

function objectValue(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): Record<string, unknown> {
  if (!record(value)) {
    eventError(sessionId, lineNumber, `${field} must be an object`);
  }
  return value;
}

function textValue(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    eventError(
      sessionId,
      lineNumber,
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function integerValue(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    eventError(
      sessionId,
      lineNumber,
      `${field} must be a non-negative integer`,
    );
  }
  return value as number;
}

function booleanValue(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): boolean {
  if (typeof value !== "boolean") {
    eventError(sessionId, lineNumber, `${field} must be a boolean`);
  }
  return value;
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return record(value) && Object.values(value).every(isJsonValue);
}

function jsonObjectValue(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): JsonObject {
  if (!record(value) || !Object.values(value).every(isJsonValue)) {
    eventError(sessionId, lineNumber, `${field} must be a JSON object`);
  }
  return value as JsonObject;
}

function validateUsage(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): void {
  const usage = objectValue(value, field, sessionId, lineNumber);
  integerValue(
    usage["inputTokens"],
    `${field}.inputTokens`,
    sessionId,
    lineNumber,
  );
  integerValue(
    usage["outputTokens"],
    `${field}.outputTokens`,
    sessionId,
    lineNumber,
  );
  integerValue(
    usage["totalTokens"],
    `${field}.totalTokens`,
    sessionId,
    lineNumber,
  );
  const cost = usage["estimatedCostUsd"];
  if (
    cost !== undefined
    && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
  ) {
    eventError(
      sessionId,
      lineNumber,
      `${field}.estimatedCostUsd must be a non-negative finite number`,
    );
  }
}

function validateToolCall(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): void {
  const call = objectValue(value, field, sessionId, lineNumber);
  textValue(call["id"], `${field}.id`, sessionId, lineNumber);
  textValue(call["name"], `${field}.name`, sessionId, lineNumber);
  jsonObjectValue(
    call["arguments"],
    `${field}.arguments`,
    sessionId,
    lineNumber,
  );
}

function validatePermissionDecision(
  value: unknown,
  field: string,
  sessionId: string,
  lineNumber: number,
): void {
  const decision = objectValue(value, field, sessionId, lineNumber);
  const outcome = textValue(
    decision["outcome"],
    `${field}.outcome`,
    sessionId,
    lineNumber,
  );
  if (!["allow", "ask", "deny"].includes(outcome)) {
    eventError(sessionId, lineNumber, `${field}.outcome is invalid`);
  }
  textValue(decision["reason"], `${field}.reason`, sessionId, lineNumber);
  textValue(decision["ruleId"], `${field}.ruleId`, sessionId, lineNumber);
  if (outcome === "allow" || outcome === "ask") {
    jsonObjectValue(
      decision["resolvedArguments"],
      `${field}.resolvedArguments`,
      sessionId,
      lineNumber,
    );
  }
}

function validateToolResult(
  value: unknown,
  field: string,
  expectedOk: boolean,
  sessionId: string,
  lineNumber: number,
): void {
  const result = objectValue(value, field, sessionId, lineNumber);
  if (
    booleanValue(result["ok"], `${field}.ok`, sessionId, lineNumber)
    !== expectedOk
  ) {
    eventError(sessionId, lineNumber, `${field}.ok is invalid`);
  }
  textValue(
    result["toolCallId"],
    `${field}.toolCallId`,
    sessionId,
    lineNumber,
  );
  if (typeof result["output"] !== "string") {
    eventError(sessionId, lineNumber, `${field}.output must be a string`);
  }
  if (result["metadata"] !== undefined) {
    jsonObjectValue(
      result["metadata"],
      `${field}.metadata`,
      sessionId,
      lineNumber,
    );
  }
  if (!expectedOk) {
    const error = objectValue(
      result["error"],
      `${field}.error`,
      sessionId,
      lineNumber,
    );
    textValue(
      error["code"],
      `${field}.error.code`,
      sessionId,
      lineNumber,
    );
    textValue(
      error["message"],
      `${field}.error.message`,
      sessionId,
      lineNumber,
    );
    booleanValue(
      error["retryable"],
      `${field}.error.retryable`,
      sessionId,
      lineNumber,
    );
  }
}

function validateEventPayload(
  value: Record<string, unknown>,
  type: SessionEvent["type"],
  sessionId: string,
  lineNumber: number,
): void {
  const text = (field: string): string =>
    textValue(value[field], `${type}.${field}`, sessionId, lineNumber);
  const integer = (field: string): number =>
    integerValue(value[field], `${type}.${field}`, sessionId, lineNumber);

  switch (type) {
    case "session_started": {
      text("task");
      text("workspaceRoot");
      const mode = text("permissionMode");
      if (!isPermissionMode(mode)) {
        eventError(
          sessionId,
          lineNumber,
          "session_started.permissionMode is invalid",
        );
      }
      return;
    }
    case "turn_started": {
      text("turnId");
      const kind = text("kind");
      if (!["new", "continue", "resume"].includes(kind)) {
        eventError(sessionId, lineNumber, "turn_started.kind is invalid");
      }
      return;
    }
    case "user_message":
      text("turnId");
      if (typeof value["content"] !== "string") {
        eventError(
          sessionId,
          lineNumber,
          "user_message.content must be a string",
        );
      }
      return;
    case "model_request_started":
      text("turnId");
      integer("step");
      return;
    case "model_output":
      text("turnId");
      integer("step");
      if (typeof value["text"] !== "string") {
        eventError(
          sessionId,
          lineNumber,
          "model_output.text must be a string",
        );
      }
      return;
    case "model_response_completed": {
      text("turnId");
      integer("step");
      const message = objectValue(
        value["message"],
        "model_response_completed.message",
        sessionId,
        lineNumber,
      );
      if (message["role"] !== "assistant") {
        eventError(
          sessionId,
          lineNumber,
          "model_response_completed.message.role must be assistant",
        );
      }
      if (typeof message["content"] !== "string") {
        eventError(
          sessionId,
          lineNumber,
          "model_response_completed.message.content must be a string",
        );
      }
      const toolCalls = message["toolCalls"];
      if (toolCalls !== undefined) {
        if (!Array.isArray(toolCalls)) {
          eventError(
            sessionId,
            lineNumber,
            "model_response_completed.message.toolCalls must be an array",
          );
        }
        toolCalls.forEach((call, index) => {
          validateToolCall(
            call,
            `model_response_completed.message.toolCalls[${index}]`,
            sessionId,
            lineNumber,
          );
        });
      }
      const stopReason = text("stopReason");
      if (!["cancelled", "end_turn", "length", "tool_use"].includes(stopReason)) {
        eventError(
          sessionId,
          lineNumber,
          "model_response_completed.stopReason is invalid",
        );
      }
      validateUsage(
        value["usage"],
        "model_response_completed.usage",
        sessionId,
        lineNumber,
      );
      return;
    }
    case "tool_requested":
      text("turnId");
      integer("step");
      validateToolCall(
        value["call"],
        "tool_requested.call",
        sessionId,
        lineNumber,
      );
      return;
    case "permission_decided":
      text("turnId");
      integer("step");
      text("toolCallId");
      validatePermissionDecision(
        value["decision"],
        "permission_decided.decision",
        sessionId,
        lineNumber,
      );
      return;
    case "permission_confirmed":
      text("turnId");
      integer("step");
      text("toolCallId");
      booleanValue(
        value["approved"],
        "permission_confirmed.approved",
        sessionId,
        lineNumber,
      );
      return;
    case "tool_execution_started":
      text("turnId");
      integer("step");
      text("toolCallId");
      return;
    case "tool_completed":
      text("turnId");
      integer("step");
      validateToolResult(
        value["result"],
        "tool_completed.result",
        true,
        sessionId,
        lineNumber,
      );
      return;
    case "tool_failed":
      text("turnId");
      integer("step");
      validateToolResult(
        value["result"],
        "tool_failed.result",
        false,
        sessionId,
        lineNumber,
      );
      return;
    case "context_compacted":
      text("turnId");
      integer("beforeTokens");
      integer("afterTokens");
      return;
    case "turn_completed":
      text("turnId");
      if (typeof value["output"] !== "string") {
        eventError(
          sessionId,
          lineNumber,
          "turn_completed.output must be a string",
        );
      }
      integer("steps");
      validateUsage(
        value["usage"],
        "turn_completed.usage",
        sessionId,
        lineNumber,
      );
      return;
    case "turn_failed":
      text("turnId");
      text("code");
      text("message");
      return;
    case "session_completed":
      if (typeof value["summary"] !== "string") {
        eventError(
          sessionId,
          lineNumber,
          "session_completed.summary must be a string",
        );
      }
      validateUsage(
        value["usage"],
        "session_completed.usage",
        sessionId,
        lineNumber,
      );
      return;
    case "session_failed":
      text("code");
      text("message");
      return;
    case "session_cancelled":
      text("reason");
  }
}

function parseEvent(
  line: string,
  sessionId: string,
  lineNumber: number,
): SessionEvent {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw dataError(
      `invalid JSON in session ${sessionId} at line ${lineNumber}`,
    );
  }
  if (!record(value)) {
    throw dataError(`invalid event in session ${sessionId} at line ${lineNumber}`);
  }
  const type = value["type"];
  const sequence = value["sequence"];
  const at = value["at"];
  if (
    typeof type !== "string"
    || !EVENT_TYPES.has(type as SessionEvent["type"])
    || typeof value["eventId"] !== "string"
    || value["eventId"].length === 0
    || value["sessionId"] !== sessionId
    || !Number.isInteger(sequence)
    || (sequence as number) <= 0
    || typeof at !== "string"
    || Number.isNaN(Date.parse(at))
  ) {
    throw dataError(`invalid event in session ${sessionId} at line ${lineNumber}`);
  }
  validateEventPayload(
    value,
    type as SessionEvent["type"],
    sessionId,
    lineNumber,
  );
  return value as unknown as SessionEvent;
}

function validateHistory(
  sessionId: string,
  events: readonly SessionEvent[],
): void {
  let activeTurnId: string | undefined;
  const pendingToolCallIds = new Set<string>();
  let terminal = false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.sequence !== index + 1) {
      throw dataError(`session ${sessionId} has a sequence gap at ${index + 1}`);
    }
    if (index === 0 && event.type !== "session_started") {
      throw dataError(`session ${sessionId} first event must be session_started`);
    }
    if (index > 0 && event.type === "session_started") {
      throw dataError(`session ${sessionId} has duplicate session_started`);
    }
    if (terminal) {
      throw dataError(`session ${sessionId} has an event after its terminal`);
    }

    if (event.type === "turn_started") {
      if (event.kind === "resume") {
        if (activeTurnId === undefined && pendingToolCallIds.size === 0) {
          throw dataError(
            `session ${sessionId} cannot resume without recoverable state`,
          );
        }
      } else if (
        activeTurnId !== undefined
        || pendingToolCallIds.size > 0
      ) {
        const reason = activeTurnId === undefined
          ? "unresolved tool calls"
          : `${activeTurnId} is incomplete`;
        throw dataError(
          `session ${sessionId} cannot start ${event.kind} while ${reason}`,
        );
      }
      activeTurnId = event.turnId;
      continue;
    }

    if ("turnId" in event && event.turnId !== activeTurnId) {
      throw dataError(
        `session ${sessionId} event does not match its active turn`,
      );
    }

    if (event.type === "model_response_completed") {
      for (const call of event.message.toolCalls ?? []) {
        pendingToolCallIds.add(call.id);
      }
    } else if (event.type === "tool_requested") {
      pendingToolCallIds.add(event.call.id);
    } else if (event.type === "tool_completed" || event.type === "tool_failed") {
      pendingToolCallIds.delete(event.result.toolCallId);
    }

    if (event.type === "turn_completed" || event.type === "turn_failed") {
      if (
        event.type === "turn_completed"
        && pendingToolCallIds.size > 0
      ) {
        throw dataError(
          `session ${sessionId} cannot complete with unresolved tool calls`,
        );
      }
      activeTurnId = undefined;
      continue;
    }

    if (TERMINAL_TYPES.has(event.type)) {
      if (activeTurnId !== undefined || pendingToolCallIds.size > 0) {
        throw dataError(
          `session ${sessionId} cannot terminate with recoverable state`,
        );
      }
      terminal = true;
      continue;
    }
  }
}

function terminalState(event: SessionEvent): SessionState {
  if (event.type === "session_completed") return "completed";
  if (event.type === "session_failed") return "failed";
  if (event.type === "session_cancelled") return "cancelled";
  return "running";
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const estimated =
    (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  const base = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
  return left.estimatedCostUsd === undefined
    && right.estimatedCostUsd === undefined
    ? base
    : { ...base, estimatedCostUsd: estimated };
}

interface FileState {
  readonly events: readonly SessionEvent[];
  readonly needsSeparator: boolean;
  readonly repairOffset: number | null;
}

interface LockRecord {
  readonly pid: number;
  readonly token: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class JsonlSessionEventStore implements SessionEventStore {
  readonly #root: string;
  readonly #createEventId: () => string;
  readonly #lockWaitMs: number;
  readonly #now: () => Date;

  constructor(root: string, options: SessionStoreOptions = {}) {
    this.#root = root;
    this.#createEventId = options.createEventId ?? randomUUID;
    this.#lockWaitMs = options.lockWaitMs ?? 5_000;
    this.#now = options.now ?? (() => new Date());
  }

  async append(
    sessionId: string,
    data: SessionEventData,
  ): Promise<SessionEvent> {
    assertSessionId(sessionId);
    return this.#withFileLock(
      sessionId,
      this.#lockPath(sessionId, "append"),
      true,
      async () => this.#appendUnlocked(sessionId, data),
    );
  }

  async withSessionLease<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    assertSessionId(sessionId);
    return this.#withFileLock(
      sessionId,
      this.#lockPath(sessionId, "lease"),
      false,
      action,
    );
  }

  async get(sessionId: string): Promise<SessionListItem | undefined> {
    const events = await this.#readComplete(sessionId, true);
    return events.length === 0 ? undefined : this.#summarize(sessionId, events);
  }

  async *read(sessionId: string): AsyncIterable<SessionEvent> {
    const events = await this.#readComplete(sessionId, false);
    for (const event of events) yield event;
  }

  async list(): Promise<readonly SessionListItem[]> {
    let names: readonly string[];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const items = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => this.get(name.slice(0, -6))),
    );
    return items
      .filter((item): item is SessionListItem => item !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async details(sessionId: string): Promise<SessionDetails> {
    const events = await this.#readComplete(sessionId, false);
    const item = this.#summarize(sessionId, events);
    const first = events[0];
    const last = events.at(-1);
    if (first === undefined || last === undefined) {
      throw dataError(`session ${sessionId} is empty`);
    }
    return {
      item,
      durationMs: Math.max(0, Date.parse(last.at) - Date.parse(first.at)),
      modelRequests: events.filter(
        (event) => event.type === "model_request_started",
      ).length,
      toolCalls: events.filter(
        (event) => event.type === "tool_requested",
      ).length,
    };
  }

  async #appendUnlocked(
    sessionId: string,
    data: SessionEventData,
  ): Promise<SessionEvent> {
    const path = this.#path(sessionId);
    const state = await this.#readState(sessionId, true);
    if (state.repairOffset !== null) {
      const repair = await open(path, "r+");
      try {
        await repair.truncate(state.repairOffset);
        await repair.sync();
      } finally {
        await repair.close();
      }
    }
    const last = state.events.at(-1);
    const event: SessionEvent = {
      ...data,
      eventId: this.#createEventId(),
      sessionId,
      sequence: (last?.sequence ?? 0) + 1,
      at: this.#now().toISOString(),
    };
    validateHistory(sessionId, [...state.events, event]);
    const append = await open(path, "a", 0o600);
    try {
      const separator =
        state.repairOffset === null && state.needsSeparator ? "\n" : "";
      await append.writeFile(
        `${separator}${JSON.stringify(event)}\n`,
        "utf8",
      );
      await append.sync();
    } finally {
      await append.close();
    }
    return event;
  }

  #summarize(
    sessionId: string,
    events: readonly SessionEvent[],
  ): SessionListItem {
    const first = events[0];
    const last = events.at(-1);
    if (
      first === undefined
      || first.type !== "session_started"
      || last === undefined
    ) {
      throw dataError(`session ${sessionId} has no session_started event`);
    }
    const terminal = [...events].reverse().find(
      (event) => TERMINAL_TYPES.has(event.type),
    );
    const completed = terminal?.type === "session_completed"
      ? terminal
      : undefined;
    const usage = completed?.usage ?? events.reduce<TokenUsage>(
      (total, event) => event.type === "model_response_completed"
        ? addUsage(total, event.usage)
        : total,
      ZERO_USAGE,
    );
    return {
      sessionId,
      state: terminal === undefined ? "running" : terminalState(terminal),
      task: first.task,
      updatedAt: last.at,
      lastSequence: last.sequence,
      usage,
    };
  }

  async #readComplete(
    sessionId: string,
    allowMissing: boolean,
  ): Promise<readonly SessionEvent[]> {
    return (await this.#readState(sessionId, allowMissing)).events;
  }

  async #readState(
    sessionId: string,
    allowMissing: boolean,
  ): Promise<FileState> {
    assertSessionId(sessionId);
    let raw: Buffer;
    try {
      raw = await readFile(this.#path(sessionId));
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        if (allowMissing) {
          return {
            events: [],
            needsSeparator: false,
            repairOffset: null,
          };
        }
        throw new CliError(
          "SESSION_NOT_FOUND",
          EXIT_CODES.usageOrConfig,
          `session not found: ${sessionId}`,
        );
      }
      throw error;
    }

    const lastNewline = raw.lastIndexOf(0x0a);
    const committedEnd = lastNewline + 1;
    const committed = raw.subarray(0, committedEnd).toString("utf8");
    const tail = raw.subarray(committedEnd).toString("utf8");
    const events: SessionEvent[] = [];

    if (committed.length > 0) {
      const lines = committed.split("\n");
      lines.pop();
      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine?.endsWith("\r")
          ? rawLine.slice(0, -1)
          : rawLine;
        if (line === undefined || line.length === 0) {
          throw dataError(
            `session ${sessionId} has an empty committed line at ${index + 1}`,
          );
        }
        events.push(parseEvent(line, sessionId, index + 1));
      }
    }

    let repairOffset: number | null = null;
    let needsSeparator = false;
    if (tail.length > 0) {
      const normalizedTail = tail.endsWith("\r")
        ? tail.slice(0, -1)
        : tail;
      try {
        JSON.parse(normalizedTail);
      } catch {
        repairOffset = committedEnd;
      }
      if (repairOffset === null) {
        events.push(
          parseEvent(
            normalizedTail,
            sessionId,
            events.length + 1,
          ),
        );
        needsSeparator = true;
      }
    }

    validateHistory(sessionId, events);
    return { events, needsSeparator, repairOffset };
  }

  async #ensureSafeRoot(): Promise<void> {
    const workspaceRoot = dirname(dirname(this.#root));
    const agentDir = join(workspaceRoot, ".agent");
    for (const dir of [agentDir, this.#root]) {
      try {
        const stats = await lstat(dir);
        if (stats.isSymbolicLink()) {
          throw new CliError("DATA_ERROR", EXIT_CODES.usageOrConfig, `session directory ${dir} must not be a symbolic link`);
        }
        const real = await realpath(dir);
        if (real !== dir) {
          throw new CliError("DATA_ERROR", EXIT_CODES.usageOrConfig, `session directory ${dir} must not be a reparse point or symlink`);
        }
      } catch (error: any) {
        if (error.code === "ENOENT") {
          await mkdir(dir, { mode: 0o700 });
          continue;
        }
        throw error;
      }
    }
  }

  async #withFileLock<T>(
    sessionId: string,
    path: string,
    wait: boolean,
    action: () => Promise<T>,
  ): Promise<T> {
    await this.#ensureSafeRoot();
    const lock = await this.#acquireLock(sessionId, path, wait);
    try {
      return await action();
    } finally {
      await this.#releaseLock(path, lock.token);
    }
  }

  async #acquireLock(
    sessionId: string,
    path: string,
    wait: boolean,
  ): Promise<LockRecord> {
    const deadline = Date.now() + this.#lockWaitMs;
    while (true) {
      const lock: LockRecord = { pid: process.pid, token: randomUUID() };
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return lock;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }

      if (await this.#removeDeadLock(path)) continue;
      if (!wait || Date.now() >= deadline) {
        throw new CliError(
          "SESSION_BUSY",
          EXIT_CODES.usageOrConfig,
          `session is busy in another process: ${sessionId}`,
        );
      }
      await delay(10);
    }
  }

  async #removeDeadLock(path: string): Promise<boolean> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      const details = await stat(path);
      if (Date.now() - details.mtimeMs < this.#lockWaitMs) return false;
      await unlink(path).catch((unlinkError: unknown) => {
        if (!hasCode(unlinkError, "ENOENT")) throw unlinkError;
      });
      return true;
    }
    if (
      record(value)
      && Number.isInteger(value["pid"])
      && processIsAlive(value["pid"] as number)
    ) {
      return false;
    }
    await unlink(path).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
    return true;
  }

  async #releaseLock(path: string, token: string): Promise<void> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!record(value) || value["token"] !== token) return;
      await unlink(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }

  #path(sessionId: string): string {
    return join(this.#root, `${sessionId}.jsonl`);
  }

  #lockPath(sessionId: string, kind: "append" | "lease"): string {
    return join(this.#root, `${sessionId}.${kind}.lock`);
  }
}
