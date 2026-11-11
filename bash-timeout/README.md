# bash-timeout

Optional 300s default-and-cap for Pi's built-in `bash` and `powershell` tools — one
extension in this repo.

Pi's built-in `bash` runs with no timeout unless the model passes one, so a single runaway foreground command (`find /`) can wedge the agent for hours. This extension adds two event hooks and nothing else:

- **Default** — a `tool_call` hook injects `timeout: 300` when a `bash`/`powershell` call passes none (a passed `0` counts as absent — Node convention reads it as "infinite", which is exactly what this extension prevents).
- **Cap** — an explicit timeout above 300s is clamped down to it. An agent turn blocked on one foreground command wedges everything: user, subagents, all of it. Commands that legitimately need longer (builds, test suites, dev servers) have a real home: `background_run` from [`background-terminal`](../background-terminal) with a large timeout, whose exit arrives as a new message instead of blocking the turn.
- **Steering** — when a shell command dies on the 300s cap, a `tool_result` hook appends one steering block to the raw timeout error: long commands belong in `background_run`; a hung command needs a cause, not a retry.

No tool is registered, overridden, or executed here — only a missing parameter gets a default value and an oversized one gets clamped. `background_run` (when installed) resolves its own, longer lifetime default inside its execute.

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Restart or reload Pi. There is nothing to configure and nothing to invoke — the cap is simply there.

> [!TIP]
> **Don't want the cap? Turn this entry off in `pi config`.** It is standalone by design (split out of `@bytetrue/pi-background-terminal` in its 0.12.0): that package no longer contains any foreground-timeout hook source, and this extension contains no background tools. Architectures whose setup checks statically scan installed source and reject foreground-timeout hooks can disable this entry and keep `background-terminal`.

## Uninstall

Disable `bash-timeout` in `pi config`, or remove the whole package with
`pi remove git:github.com/ByteTrue/pi-extensions-collection`.

The built-in `bash`/`powershell` tools return to their exact built-in behavior — no default timeout, no cap, no steering. The extension registers no tools and no commands, so there is nothing else to clean up.

## How it works

`bash-timeout.ts` is the entire runtime — one file, zero imports (the type-only import disappears at load; the runtime guards compare `event.toolName` directly). Pi loads the entry file listed in the root manifest via jiti, so the runtime artifact is exactly the file you see here, tests aside:

```text
bash-timeout.ts   hook implementation + default-export entry (registerBashTimeout)
bash-timeout.test.ts   CI-only: the full hook test suite (never installed)
package.json         private, never published — exists only so workspace CI runs tests
```

## Deliberate limits

- No configurable cap value (300s is fixed; the escape hatch is `background_run`'s longer lifetime)
- No per-tool or per-project opt-out, and no runtime switch — an install either caps or it does not (that is the point: a setup check scanning the installed source must find either the whole hook or none of it)
- No override of any built-in tool; no tool registration at all
- No npm package, no versioning, no pinning — updates are re-running the install script; the file always tracks `main`
- Independent of `@bytetrue/pi-background-terminal`: install either alone, or both — they never depend on each other
