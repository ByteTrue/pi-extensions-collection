# pi-extensions-collection

Extensions for [Pi coding agent](https://pi.dev), installed and updated as one git
package. Pi clones the repo, installs whatever dependencies the extensions declare,
and loads every entry in the root `pi` manifest.

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

`pi update git:github.com/ByteTrue/pi-extensions-collection` updates this package;
`pi update --extensions` updates all installed packages. Let running tasks finish,
update, then restart Pi so process-global managers also use the new code. Pi owns
that checkout: an update resets it to the fetched commit and removes untracked
files, so work in a separate checkout and load the file you are changing with `pi -e`.

Each extension is a top-level directory with its own `package.json`: the entry
file, tests, README, and a private manifest that holds its runtime dependencies and
the dev dependencies CI uses. Nothing is published to npm.

## Install

Requires Pi **1.5.0 or newer**. CI checks the locked host and the 1.5.0 minimum on
Windows and Ubuntu, including real extension loading before types and tests.

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Pin a tag or commit by appending its ref:
`pi install git:github.com/ByteTrue/pi-extensions-collection@<tag-or-commit>`.
Pinned installs use the extensions and behavior at that historical revision.

Installation clones the repo into Pi's package directory and runs `npm install`
there, so any package an extension imports resolves normally. Updating is
`pi update git:github.com/ByteTrue/pi-extensions-collection`: Pi fetches, resets
the checkout, and reinstalls dependencies.

`pi config` turns individual extensions off. The setting is a filter on the package
entry in `~/.pi/agent/settings.json`, for example
`-subagent/subagent.ts`; nothing is deleted.

## What is here

| Extension | What it does |
| --- | --- |
| [`background-terminal`](./background-terminal/) | `background_run` / `background_status` / `background_kill` tools plus the `/background` menu: pure-background execution whose exit wakes the agent with a `<shell>` notice; no lifetime by default, killed at session exit. Built-in `bash`/`powershell` stay untouched |
| [`bash-timeout`](./bash-timeout/) | Optional 120s default timeout for the built-in `bash`/`powershell` tools; explicit `timeout: 0` disables it and larger values are honored (one event hook; registers no tools) |
| [`ask-user`](./ask-user/) | `ask_user` tool: single- or multi-select decision questions (required options), with a row-by-row multiselect checklist and back-navigation |
| [`goal`](./goal/) | `/goal`: one durable objective per session, continued automatically at Pi's settle boundary until `goal_done` with evidence; untrusted-objective wrapper, 50-round and 3-stall guards, background-work wait, restart pause |
| [`subagent`](./subagent/) | `subagent` / `subagent_status` / `subagent_stop` plus the `/subagent` menu: isolated child sessions whose `<subagent>` result arrives as a new message; `agent` and `description` required, live progress, budget guards, opencode's built-in subagent roles `general` and `explore` |

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
root `pi` manifest, or when an entry is not a file inside its extension directory. CI runs it
first, because a missing entry is silent: the extension never loads.

## Design notes

The rules this repo lives by — one git package, no npm publishing, no build step,
dependencies installed by Pi, tool names globally unique, what has already been ruled
out — are in [`bywork/memory/`](./bywork/memory), one file per topic. The previous
workflow's records (spec, decisions, epics, probe notes) are archived read-only in
[`archive/byissue/`](./archive/byissue).
