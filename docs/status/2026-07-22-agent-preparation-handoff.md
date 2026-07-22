# Agent MVP Preparation Handoff

## Status

- State: paused after preparation; implementation worktrees have not started.
- Product goal: build an independent general-purpose Agent runtime inspired by reusable ideas from the open-source Grok Build harness, without copying closed model weights.
- Baseline branch: `main`.
- Shared contract version: `1`.

## Completed

- Product and runtime design: `docs/superpowers/specs/2026-07-20-general-agent-runtime-design.md`.
- Frozen cross-package rules: `docs/architecture/contracts.md`.
- npm Workspace and strict TypeScript baseline.
- `@agent/contracts` model, tool, permission, session, checkpoint, and runner interfaces.
- Safe recovery semantics for persisted permission phases, unknown tool execution, usage accounting, and external cancellation.
- Structured direct-process boundary for `shell_execute`; opaque Shell strings are outside the MVP.
- Detailed red-green implementation plans:
  - `docs/superpowers/plans/2026-07-20-agent-core-providers.md`
  - `docs/superpowers/plans/2026-07-20-agent-tools-policy.md`
  - `docs/superpowers/plans/2026-07-20-agent-cli.md`

## Verification at Pause

Run on 2026-07-22:

```powershell
npm.cmd run verify
```

Result:

- TypeScript type-check passed.
- 4 test files passed, 12 tests passed.
- Contracts build passed.
- Plan task order, Markdown fences, placeholders, and trailing whitespace checks passed.

No real API key, model endpoint, external account, implementation worktree, push, or deployment was created.

## Resume Order

1. Start two isolated worktrees from the saved `main` baseline.
2. Implement `Core/Providers` using its plan and only `packages/core/**`, `packages/providers/**`.
3. In parallel, implement `Tools/Policy` using its plan and only `packages/tools/**`, `packages/policy/**`.
4. Review and merge both branches into `main`; refresh the workspace lockfile and run ordered build plus repository verification.
5. Create the second-wave CLI worktree only from that integrated, green main branch.
6. Merge CLI, then add shared integration, security, recovery, Windows shim, and 20-task evaluation evidence.

## Resume Guardrails

- Do not modify `packages/contracts/**` from an implementation worktree.
- Do not replay a tool after `tool_execution_started` without a terminal result.
- Reuse persisted permission decisions and confirmations during recovery.
- Keep API keys in environment variables only.
- Do not execute opaque Shell command strings; use the structured direct-process contract.
- Do not push, publish, or deploy without a new explicit user request.
