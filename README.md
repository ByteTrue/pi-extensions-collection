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

Each extension is a top-level directory with its own `package.json`: the entry
file, tests, README, and a private manifest that holds its runtime dependencies and
the dev dependencies CI uses. Nothing is published to npm.

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
`-context-prune/context-prune.ts`; nothing is deleted.

`context-prune` registers `ctx_reduce` / `ctx_search` / `ctx_expand`, the same
tool names [`@cortexkit/pi-magic-context`](https://github.com/ByteTrue) provides. Pi
refuses to start when two extensions register one tool name. Run `pi config` before
the first start and turn `context-prune` off; it resolves packages without loading
extension code. `auto-compact` registers no tools and can stay loaded.

## What is here

| Extension | What it does |
| --- | --- |
| [`background-terminal`](./background-terminal/) | `background_run` / `background_status` / `background_kill` tools plus the `/background` menu: pure-background execution whose exit wakes the agent with a `<shell>` notice; no lifetime by default, killed at session exit. Built-in `bash`/`powershell` stay untouched |
| [`bash-timeout`](./bash-timeout/) | Optional 120s default timeout for the built-in `bash`/`powershell` tools; explicit `timeout: 0` disables it and larger values are honored (two event hooks; registers no tools) |
| [`ask-user`](./ask-user/) | `ask_user` tool: 1–4 single- or multi-select decision questions per call, with true toggle-then-submit multiselect and back-navigation |
| [`goal`](./goal/) | `/goal`: one durable objective per session, continued automatically at Pi's settle boundary until `goal_done` with evidence; untrusted-objective wrapper, 50-round and 3-stall guards, background-work wait, restart pause |
| [`subagent`](./subagent/) | `subagent` / `subagent_status` / `subagent_stop` plus the `/subagent` menu: isolated child sessions whose `<subagent>` result arrives as a new message; `agent` and `description` required, live progress, budget guards, opencode's built-in subagent roles `general` and `explore` |
| [`context-prune`](./context-prune/) | `ctx_reduce` / `ctx_search` / `ctx_expand` plus `/context-prune`: deterministic pruning of stale tool results, reminders that make the tools get used, and the session file named in the system prompt |
| [`auto-compact`](./auto-compact/) | Large-window models compact at 400k tokens; registers no tools and no commands |

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
pi -e ./goal/goal.ts
```

Run `npm install` first if you added a runtime dependency; Pi resolves it from the
checkout's `node_modules`.

`node scripts/check-manifest.mjs` fails when an extension directory has no entry in the
root `pi` manifest, or when the manifest lists a file that does not exist. CI runs it
first, because a missing entry is silent: the extension never loads.

## Design notes

The rules this repo lives by — one git package, no npm publishing, no build step,
dependencies installed by Pi, tool names globally unique, what has already been ruled
out — are in [`byissue/`](./byissue): `spec/index.md` for the current truth,
`decisions/` for the calls that were made, and the epic that split this repo out of
its predecessor.
