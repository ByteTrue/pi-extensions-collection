# R7: role field inheritance and explicit clearing

Approved behavior is implemented for `agents.<role>` in `subagent/src/settings.ts` and the existing role controls in `subagent/src/command.ts`.

## Behavior

- Each missing project role field inherits that field from the global role. An empty role object inherits the whole global role; it no longer erases it.
- A supplied valid field overrides only that field. This covers `model`, `thinking`, `tools`, `maxTurns`, and `timeoutMs`.
- `null` explicitly clears a role field, suppressing the same global role field. Resolution then continues through the existing role-document/default/parent fallback chain. It does not suppress unrelated defaults or values encoded in another field, such as a thinking suffix on the selected model.
- Empty or whitespace-only `model` and `thinking` strings normalize to `null`. `thinking: "off"` remains an explicit thinking level, distinct from clearing it.
- Tool arrays replace, never concatenate. `tools: []` selects no ordinary active tools (`--no-tools`); `tools: null` resumes the role document's tool selection, or the child default when the document has none. Existing always-on extension-tool behavior is unchanged.
- Invalid field types and invalid numeric budgets are ignored, so they inherit. Positive numeric budgets keep existing flooring/validation. `null` budgets restore the normal fallback budget; they do not disable turn or timeout safety limits.
- Project settings remain ignored when the project is untrusted. Prototype-like map keys, null-prototype maps, atomic saves, permissions, and legacy migration rules are preserved.
- Top-level defaults and environment-variable precedence retain their existing behavior; this change defines explicit clears for role fields only.

## UI decisions

The existing model, thinking, and budget pickers now distinguish:

- **Inherit model / Inherit thinking level / Inherit budget:** remove the field from the selected settings layer, allowing global role inheritance in the project layer.
- **Use role document/default:** persist `null` for that role field, bypassing its global role setting.
- **Keep current:** retain a value or an explicit `null`. Escape still cancels without saving the partially completed form.

The same pickers serve default settings, where only the existing inherit/value choices are offered. Tools remain JSON-configured; no new tools editor or generic settings framework was added. An internal `INHERIT` symbol distinguishes deleting a field from persisting `null` and cancelling (`undefined`).

## Migration example

Global settings:

```json
{"agents":{"explore":{"model":"vendor/global","tools":["read","bash"],"maxTurns":150}}}
```

Project settings:

```json
{"agents":{"explore":{"thinking":"low"}}}
```

Previously that project role replaced the global role wholesale. It now inherits `model`, `tools`, and `maxTurns` while overriding only `thinking`.

To preserve the former document/default fallback for the other fields, make the clears explicit:

```json
{"agents":{"explore":{"model":null,"thinking":"low","tools":null,"maxTurns":null,"timeoutMs":null}}}
```

Use `tools: []` only when intentionally selecting no ordinary tools, not when restoring document defaults. Remove a field (or choose **Inherit**) to resume global inheritance. If an old empty model/thinking string was intended to mean inheritance, remove it: empty strings now mean explicit clear.

No configuration files are rewritten merely to guess the user's former intent. Existing global legacy migration still copies the section atomically; project legacy files remain read-only until an explicit project save. Both legacy parser shapes retain clears, and normalized empty strings are saved as `null` on the next write/migration.

## Parent integration

No R7 production edits to `subagent/src/index.ts` are needed: `resolveRunCfg` already treats null role fields as fallbacks and preserves `tools: []`; `buildPiArgs` already emits `--no-tools`. Tests in the assigned files exercise these consumers directly. The parent owns the README update; the behavior/migration sections above are the source for it.

The parent must update the existing assertion in `subagent/src/index.test.ts:795` (test: `merges budget keys across global and project settings, gated by project trust`) from `{ timeoutMs: 3000000 }` to `{ maxTurns: 111, timeoutMs: 3000000 }`. The global role budget now correctly survives the project timeout override. This file is outside this worker's assigned ownership.

Changed files: `subagent/src/settings.ts`, `subagent/src/settings.test.ts`, `subagent/src/command.ts`, `subagent/src/command.test.ts`, `subagent/src/command-inherit.test.ts`, and this note.

## Checks

- Initial focused run: all 37 tests passed across the three assigned test files.
- After three additional regressions: all 40 tests in the assigned files passed in the broader five-file run.
- Broader command: `npm exec --workspace subagent -- vitest run src/settings.test.ts src/command.test.ts src/command-inherit.test.ts src/index.test.ts src/security.test.ts` — 99 passed, 9 failed. One failure is the parent-owned R7 assertion identified above. Other failures occurred in the concurrently changing parent-owned files: two roster expectations, `runSubagent drops project-layer env and role overrides for untrusted projects (BYTE-5 #1)`, and five launch tests reporting `ReferenceError: acquireSubagentSession is not defined`.
- `npm run typecheck --workspace subagent`: initially passed. A second run against the changing shared workspace reported only missing names in `subagent/src/index.ts`: `resolveChildAgentDir` at lines 2395 and 2758, and `acquireSubagentSession` at line 2758. These are outside the assigned R7 files.
- Final focused rerun: `npm exec --workspace subagent -- vitest run src/settings.test.ts src/command.test.ts src/command-inherit.test.ts` — **40/40 passed**, all three files passed.
- Final `git diff --check` for all six owned paths passed.

Integration follow-up: the parent corrected both old merge expectations and the outdated comment in `subagent/src/index.test.ts`, completed the shared runner/roster changes, and updated `subagent/README.md`. Final repository validation passed: 424 tests, 12 skips, all five workspace typechecks including `--noUnusedLocals`. The intermediate failures above are resolved.

This worker made no commits, dependency changes, or changes to the parent's README/index files.
