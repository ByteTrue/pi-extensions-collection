# pi-extensions-collection

Extensions for [Pi coding agent](https://pi.dev), installed and updated as one git
package. Pi clones the repo, installs whatever dependencies the extensions declare,
and loads every entry in the root `pi` manifest.

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

`pi update --extensions` updates them, then `/reload` or restart. Pi owns that
checkout: an update resets it to the fetched commit and removes untracked files, so
work in a separate checkout and load the file you are changing with `pi -e`.

Each `pi-*` subdirectory is one extension: its entry file, tests, README, and a
private `package.json` that holds its runtime dependencies and the dev dependencies
CI uses. Nothing is published to npm.

## Install

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Pin a tag or commit by appending it:
`pi install git:github.com/ByteTrue/pi-extensions-collection@v1`.

Installation clones the repo into Pi's package directory and runs `npm install`
there, so any package an extension imports resolves normally. Updating is
`pi update --extensions`: Pi fetches, resets the checkout, and reinstalls
dependencies.

`pi config` turns individual extensions off. The setting is a filter on the package
entry in `~/.pi/agent/settings.json`, for example
`-pi-context-prune/pi-context-prune.ts`; nothing is deleted.

`pi-context-prune` registers `ctx_reduce` / `ctx_search` / `ctx_expand`, the same
tool names [`@cortexkit/pi-magic-context`](https://github.com/ByteTrue) provides. Pi
refuses to start when two extensions register one tool name. Run `pi config` before
the first start and turn `pi-context-prune` off; it resolves packages without loading
extension code. `pi-auto-compact` registers no tools and can stay loaded.

## What is here

| Extension | What it does |
| --- | --- |
| [`pi-background-terminal`](./pi-background-terminal/) | `background_run` / `background_status` / `background_kill` tools plus the `/background` menu: pure-background execution whose exit wakes the agent with a new message. Built-in `bash`/`powershell` stay untouched |
| [`pi-bash-timeout`](./pi-bash-timeout/) | Optional 300s default-and-cap for the built-in `bash`/`powershell` tools (two event hooks; registers no tools) |
| [`pi-ask-user`](./pi-ask-user/) | Minimal `ask_user` tool: 1–4 single- or multi-select decision questions per call with back-navigation, answered via Pi's built-in dialogs |
| [`pi-goal`](./pi-goal/) | Minimal `/goal`: one durable objective per session, continued automatically at Pi's settle boundary until the model calls `goal_done` with evidence. The model can draft the objective itself via `goal_start` |
| [`pi-context-prune`](./pi-context-prune/) | `ctx_reduce` / `ctx_search` / `ctx_expand` plus `/context-prune`: deterministic pruning of stale tool results, reminders that make the tools get used, and the session file named in the system prompt |
| [`pi-auto-compact`](./pi-auto-compact/) | Large-window models compact at 400k tokens; registers no tools and no commands |
| [`pi-vendor`](./pi-vendor/) | Pi-specific `/vendor` TUI: add a custom provider or model to Pi's `models.json` with catalog lookup, upstream discovery and atomic writes. The agent-facing half of this work moved to the `provider-model-config` skill, which also covers opencode |

## Development

```bash
git clone https://github.com/ByteTrue/pi-extensions-collection
cd pi-extensions-collection
npm install                                  # only for typecheck + tests
npm run typecheck --workspaces --if-present
npm test
```

Try an extension straight from the checkout, without installing it:

```bash
pi -e ./pi-goal/pi-goal.ts
```

Run `npm install` first if you added a runtime dependency; Pi resolves it from the
checkout's `node_modules`.

`node scripts/check-manifest.mjs` fails when a `pi-*/` directory has no entry in the
root `pi` manifest, or when the manifest lists a file that does not exist. CI runs it
first, because a missing entry is silent: the extension never loads.

## Design notes

The rules this repo lives by — one git package, no npm publishing, no build step,
dependencies installed by Pi, tool names globally unique, what has already been ruled
out — are in [`byissue/`](./byissue): `spec/index.md` for the current truth,
`decisions/` for the calls that were made, and the epic that split this repo out of
its predecessor.
