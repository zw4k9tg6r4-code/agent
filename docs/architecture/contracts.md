# Agent Runtime Contracts

`@agent/contracts` is the only interface package shared by every parallel MVP worktree.

## Dependency rule

- `core`, `providers`, `tools`, `policy`, and `cli` may import from `@agent/contracts`.
- Implementation packages must not import another package's internal `src/` files.
- The final composition root may import public package entry points after the implementation branches are integrated.
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

## Security rule

`PermissionEvaluator` decides before a tool executes. Core passes only the decision's `resolvedArguments` into `Tool.execute`, preserving the model's original `ToolCall.id`. Tools do not bypass permission decisions, and Core does not call the filesystem or shell directly. `file_patch` captures the first preimage through `CheckpointStore` before writing.

## Version rule

`CONTRACTS_VERSION` remains `1` throughout the MVP. Any incompatible signature change before release requires updating all dependent plans and tests in the same baseline commit.
