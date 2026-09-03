# Agent Runtime Contracts

`@agent/contracts` is the only interface package shared by every parallel MVP worktree.

## Dependency rule

- `core`, `providers`, `tools`, `policy`, and `cli` may import from `@agent/contracts`.
- Implementation packages must not import another package's internal `src/` files, with one exception: `policy` may import the public `@agent/tools` entry point (process-risk analysis reuses the shell validators; declared in `packages/policy/package.json`).
- The final composition root (`cli`) may import public package entry points.
- Public data crossing package boundaries must be JSON-safe unless the contract explicitly uses a platform object such as `AbortSignal`.

## Compatibility rule

During the three parallel MVP worktrees, `packages/contracts/` is frozen and owned by the main task. A worker that needs a contract change must stop and report:

1. the missing behavior;
2. the exact proposed signature;
3. affected packages and tests.

The main task decides whether to update the baseline and rebase the workers.

## Event rule

Session records are append-only. `SessionEventStore.append` atomically assigns event ID, sequence, and timestamp. Existing events are never edited in place. A resumed turn only trusts complete `model_response_completed` events. A `tool_execution_started` event without a matching success or failure has unknown execution state and is never replayed automatically.

## Runtime rule

`AgentRunner.runTurn` supports new, continued, and resumed turns. A successful turn leaves the session in `running` state so interactive input can continue. `AgentRunner.finishSession` is the only normal path that writes `session_completed`; no event may be appended after a terminal session event.

An external abort interrupts only the active Turn. Core returns a running result with `turn_cancelled` and never appends `turn_failed` or `session_cancelled` for an abort. `turn_cancelled` closes the turn for continuation: a later `continue` turn may start only after the snapshot has no pending tool states and no unknown tool executions, so recovery applies the same unknown-execution checks as a process crash. `session_cancelled` is reserved for explicit whole-session termination outside the MVP.

## Security rule

`PermissionEvaluator` decides before a tool executes. Core passes only the decision's `resolvedArguments` into `Tool.execute`, preserving the model's original `ToolCall.id`. Tools do not bypass permission decisions, and Core does not call the filesystem or shell directly. `file_patch` captures the first preimage through `CheckpointStore` before writing.

The MVP `shell_execute` tool accepts a structured direct-process request (`program`, `args`, optional `cwd` and `timeoutMs`). It does not interpret an opaque Shell command, pipe, redirection, compound expression, or script-shell wrapper.

## Version rule

`CONTRACTS_VERSION` remains `1` throughout the MVP. Any incompatible signature change before release requires updating all dependent plans and tests in the same baseline commit.
