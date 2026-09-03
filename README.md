# agent-runtime

Independent general-purpose Agent runtime (TypeScript monorepo, Node.js 22+).

## Layout

- `packages/contracts` — shared interfaces (frozen during MVP worktrees).
- `packages/core` — agent main loop, session state, redaction.
- `packages/tools` — direct-process `shell_execute`, workspace files, checkpoints.
- `packages/policy` — permission evaluation and process-risk analysis.
- `packages/providers` — OpenAI-compatible model streaming.
- `packages/cli` — `agent` command composition root.
- `docs/architecture` — design rules; `docs/status` — historical handoffs.
- `examples/` — runnable quickstart (start here).

## Quickstart

See `examples/README.md`. In short, from the repository root:

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run verify
```

`verify` runs build + typecheck + coverage tests. Always build before
testing: cross-package tests resolve to compiled `dist`.
