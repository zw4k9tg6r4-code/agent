# Agent CLI Example

## Prerequisites

- Node.js 22 or newer.
- A Git workspace.
- An OpenAI-compatible endpoint and API key.

## Build

From the Agent repository:

```powershell
$agentRepository = (Get-Location).Path
npm.cmd install
npm.cmd run build
npm.cmd run verify
npm.cmd run start --workspace @agent/cli -- --help
```

Always build before testing: cross-package tests resolve to compiled `dist`,
so a bare `npm test` on a fresh clone fails. `verify` runs
`build + typecheck + test:coverage` in the right order.

Windows PowerShell does not need an execution-policy change. npm commands use
`npm.cmd`.

## Initialize a workspace

Change to the target workspace, then run the compiled CLI by its absolute path:

```powershell
node "$agentRepository\packages\cli\dist\bin.js" init
```

Initialization creates:

```text
.agent/
├─ config.json
├─ sessions/
└─ checkpoints/
```

Copy `examples/config.json` to `.agent/config.json` when you want the example
provider and Skill settings. Copy `examples/skills/review/SKILL.md` to
`.agent/skills/review/SKILL.md`, and place the example `AGENTS.md` at the
workspace root.

## Set the key for the current PowerShell process

```powershell
$env:OPENAI_API_KEY = Read-Host "OpenAI-compatible API key"
```

The JSON stores only `OPENAI_API_KEY`, never the key value.

## Commands

If the package has been linked with npm, Windows exposes `agent.cmd`:

```powershell
agent.cmd
agent.cmd run "inspect this repository"
agent.cmd sessions
agent.cmd resume session-id-from-list
agent.cmd undo session-id-from-list
```

On Unix systems, use `agent`, `agent run`, `agent resume`, and `agent undo`.

Interactive mode accepts multiple messages. Enter `/exit` or send EOF to finish
the session. Press `Ctrl+C` to cancel the active operation; the process returns
exit code `130`, and a running session remains available to `agent resume`.

`agent sessions` reads `.agent/sessions/*.jsonl` and reports state, update time,
duration, tokens, estimated cost, model requests, and tool calls. `agent undo`
restores the first pre-change checkpoint saved for that session.

Session and checkpoint data remain local and Git-ignored. Do not upload them
unless they have been reviewed for sensitive content.
