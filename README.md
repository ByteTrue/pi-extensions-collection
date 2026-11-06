# pi-extensions-collection

Drop-in extensions for [Pi coding agent](https://pi.dev): **copy a file into
`~/.pi/agent/extensions/` and it works.** No npm publishing, no `npm install`, no
build step, no `node_modules` next to the extension.

That constraint is the whole point of this repo, and it decides what may live here:

- **Allowed**: `node:*` built-ins, Pi host modules (`@earendil-works/*`, `typebox` —
  Pi maps them to its own copies).
- **Not allowed**: third-party npm dependencies, a bundler or build step, or anything
  that needs `npm install` in `~/.pi/agent/extensions/`. Anything that grows that far
  does not belong in this repo.

Each subdirectory is one extension: a single TypeScript file loaded by Pi via jiti,
its tests, its README, and a **private** `package.json` that exists only so CI can
typecheck and test it — it is never published.

## Install

One Node script (Node 18+) downloads the selected files from this repo's `main`
branch (GitHub raw) into `~/.pi/agent/extensions/`, overwriting whatever was there.
It opens with an arrow-key checklist — `↑`/`↓` move, `space` toggles, `a` toggles
all, `enter` installs — so a machine keeps only the extensions it wants. `--all`
skips the menu and installs everything (for scripts, where there is no terminal).

Every extension starts ticked, so plain `<enter>` installs all of them and `space`
is how you drop the ones a machine does not want.

One extension is skipped automatically: `pi-context-guard` registers
`ctx_reduce` / `ctx_search` / `ctx_expand`, the same tool names
[`@cortexkit/pi-magic-context`](https://github.com/ByteTrue) provides. Pi refuses to
start when two extensions register one tool name, so the installer detects that
package in your settings and leaves `pi-context-guard` out. Remove one of the two if
you want the other.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ByteTrue/pi-extensions-collection/main/install.mjs -o /tmp/install.mjs
node /tmp/install.mjs
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ByteTrue/pi-extensions-collection/main/install.mjs -OutFile "$env:TEMP\install.mjs"
node "$env:TEMP\install.mjs"
```

Re-running the script is the update path — there is no versioning and no pinning.
Picking a subset never deletes anything: extensions you leave unticked stay as they
are. Restart or reload Pi afterwards; files in that directory load automatically.

You can also skip the script entirely: copy a `pi-*` directory into
`~/.pi/agent/extensions/<name>/` by hand. Every extension is a single file, so that is
the whole copy.

## What is here

| Extension | What it does |
| --- | --- |
| [`pi-background-terminal`](./pi-background-terminal/) | `background_run` / `background_status` / `background_kill` tools plus the `/background` menu: pure-background execution whose exit wakes the agent with a new message. Built-in `bash`/`powershell` stay untouched |
| [`pi-bash-timeout`](./pi-bash-timeout/) | Optional 300s default-and-cap for the built-in `bash`/`powershell` tools (two event hooks; registers no tools) |
| [`pi-ask-user`](./pi-ask-user/) | Minimal `ask_user` tool: 1–4 single- or multi-select decision questions per call with back-navigation, answered via Pi's built-in dialogs |
| [`pi-goal`](./pi-goal/) | Minimal `/goal`: one durable objective per session, continued automatically at Pi's settle boundary until the model calls `goal_done` with evidence. The model can draft the objective itself via `goal_start` |
| [`pi-context-guard`](./pi-context-guard/) | Large-window models (>400k) compact at 400k; the system prompt names the session file; stale/duplicate oversized tool results are deterministically pruned with `ctx_reduce` / `ctx_search` / `ctx_expand` and `/context-guard` |
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

`node scripts/check-installer.mjs` fails when a `pi-*/` directory is missing from
`install.mjs`'s `EXTENSIONS` list, or when the installer lists a file that does not
exist. CI runs it before installing anything, because a missing entry is silent: the
extension simply can never be installed by the documented command.

Editing an installed copy in `~/.pi/agent/extensions/` works too, but re-running
`install.mjs` overwrites it.

## Design notes

The constraints this repo lives by — why drop-in means no npm dependencies, why tool
names must be globally unique, what has already been ruled out — are in
[`byissue/`](./byissue): `spec/index.md` for the current truth, `decisions/` for the
calls that were made, and the epic that split this repo out of its predecessor.
