# R9: Pi compatibility minimum

The git package and all five workspaces now declare `@earendil-works/pi-coding-agent >=1.5.0`. This is a supported minimum, not a version pin. The existing lockfile continues to resolve Pi 1.5.0; no resolved dependency records changed.

## Why 1.5.0

`background-terminal/background-terminal.ts` and `subagent/src/index.ts` use `MessageRenderOptions.keyText` to render the configured expand shortcut. Pi added the injected `keyText`/`keyHint` renderer helpers in **1.5.0** (Pi's 1.5.0 changelog, Added section, issue #4748). Pi 1.1.0's types do not provide that property.

An isolated Pi 1.1.0 installation, with its Pi sibling packages also overridden to 1.1.0, confirmed the mismatch: both renderers failed typechecking with `TS2339: Property 'keyText' does not exist on type 'MessageRenderOptions'.` Aligning the siblings was necessary because Pi 1.1.0 itself declares caret ranges for them. The package could load on that version, but loading does not execute message renderers and therefore was insufficient evidence of compatibility. Supporting Pi below 1.5.0 would require extension changes outside this task.

The running host is Pi 1.6.0. Raising the floor to 1.6.0 is unnecessary: Pi 1.5.0 supplies the required API, passes all workspace typechecks and the final full test suite, and loads all five extensions.

## Changes

- Added the same `>=1.5.0` host peer to the root git package and updated the five workspace peer ranges and their lockfile metadata. Other peer ranges and all resolved dependency versions remain unchanged.
- Kept the Windows and Ubuntu CI matrix and the existing unpinned Node setup. Added a `locked` / `1.5.0` Pi axis. Minimum jobs use `npm install --no-save --package-lock=false @earendil-works/pi-coding-agent@1.5.0 @earendil-works/pi-tui@1.5.0`; these exact versions select a test fixture, not a consumer dependency pin.
- Added a real Pi loader check before the existing typechecks and tests. It uses an empty temporary agent directory, asserts the selected minimum version, and checks all manifest entry points, eight tools, and three commands. Loader errors and missing registrations fail CI.

## Verification

Compatibility probes ran on Windows with Node v26.13.0 in temporary copies, without changing the repository's `node_modules` or any Pi-managed checkout. After integration, the parent also ran the complete suite in the working checkout; its installed `pi-coding-agent`, `pi-ai`, and `pi-tui` versions were independently confirmed as exactly 1.5.0.

| Check | Evidence |
| --- | --- |
| Isolated minimum installation | `npm ls` confirmed `pi-coding-agent`, `pi-ai`, and `pi-tui` are all exactly 1.5.0. The CI minimum-install command completed successfully. |
| Workspace types on Pi 1.5.0 | `npm run typecheck --workspaces --if-present`: all five passed. |
| Real Pi 1.5.0 loading | The exact workflow JavaScript loaded five extensions with no loader errors, all eight expected tools, and all three expected commands. |
| Real Pi 1.6.0 loading | The same assertions passed using the installed 1.6.0 host SDK and a temporary agent directory. |
| Final tests on Pi 1.5.0 | Full `npm test`: 424 passed, 12 skipped (platform exclusions and the opt-in recovery probe). All five workspace typechecks also passed with `--noUnusedLocals`. |
| Final lockfile installation | A fresh temporary `npm ci --ignore-scripts --no-audit --no-fund` completed successfully (174 packages). |
| Metadata and workflow | All six manifest peer declarations match their lockfile entries; every resolved `node_modules/` lock record matches the preexisting lockfile. Workflow YAML parses, retains both operating systems, and has no Node version pin. `git diff --check` passes for the R9-owned files. |

The focused command selects `ask-user/ask-user.test.ts`, `goal/goal.test.ts`, `bash-timeout/bash-timeout.test.ts`, `background-terminal/index.test.ts`, and `subagent/src/index.test.ts`. It ran through Vitest 4.1.12 with `PI_SUBAGENT_CHILD` cleared and a temporary `PI_CODING_AGENT_DIR`.

The work-in-progress focused run found two stale expectations in `merges budget keys across global and project settings, gated by project trust`: they expected `{ timeoutMs: 3000000 }` while field-wise merging correctly retained `maxTurns: 111`. Both expectations and the old whole-role-merge comment were corrected. These were integration failures, not Pi API failures. The final full run passed, including the post-write case. The parent then repeated real loading with the final source through both Pi 1.5.0 and the installed Pi 1.6.0 SDK: each loaded five extensions, eight tools, and three commands with no errors.

## Limits

The compatibility worker avoided the full root suite during concurrent edits; the parent ran it successfully after integration. GitHub Actions has not run yet; Ubuntu execution is covered by the configured workflow, not by this local Windows run. The 1.6.0 check covers loading and registration only. No interactive model-backed TUI/RPC session, provider call, publishing, extension installation, or commit was performed. Future Pi releases are allowed by the peer range but are not all claimed to have been tested.
