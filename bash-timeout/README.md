# bash-timeout

Optional opencode-style default timeout for Pi's built-in `bash` and `powershell`
tools — one extension in this repo.

Pi's built-in `bash` runs with no timeout unless the model passes one, so a single
runaway foreground command (`find /`) can wedge the agent for hours. opencode's
`shell` tool defaults foreground calls to 2 minutes and treats `timeout: 0` as an
explicit opt-out. This extension applies that behavior through one `tool_call` hook:

- **Default** — a `tool_call` hook injects `timeout: 120` when a `bash`/`powershell`
  call passes none.
- **Opt-out** — an explicit `timeout: 0` removes the parameter, because Pi's
  built-in shell rejects `<= 0`; removing the parameter lets it run without a timeout.
- **Explicit timeout** — positive values are respected up to Pi's platform maximum
  of 2,147,483 seconds.

The extension registers no tools or commands and leaves tool results unchanged.

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Restart or reload Pi. There is nothing to configure and nothing to invoke — the
default is simply there.

> [!TIP]
> **Don't want the default? Turn this entry off in `pi config`.** It is standalone by
> design (split out of `@bytetrue/pi-background-terminal` in its 0.12.0): this
> package contains no background tools, and `background-terminal` contains no
> foreground-timeout hook. Architectures whose setup checks statically scan installed
> source and reject foreground-timeout hooks can disable this entry and keep
> `background-terminal`.

## Uninstall

Disable `bash-timeout` in `pi config`, or remove the whole package with
`pi remove git:github.com/ByteTrue/pi-extensions-collection`.

The built-in `bash`/`powershell` tools return to their exact built-in behavior — no
default timeout. The extension registers no tools and no commands, so
there is nothing else to clean up.

## How it works

`bash-timeout.ts` is the entire runtime — one file, zero imports (the type-only
import disappears at load; the runtime guards compare `event.toolName` directly).
Pi loads the entry file listed in the root manifest via jiti, so the runtime
artifact is exactly the file you see here, tests aside:

```text
bash-timeout.ts        hook implementation + default-export entry (registerBashTimeout)
bash-timeout.test.ts   CI-only: the full hook test suite (never installed)
package.json           private, never published — exists only so workspace CI runs tests
```

## Deliberate limits

- No configurable default value (120s is fixed, matching opencode; pass `timeout` per call to change it)
- No per-tool or per-project opt-out, and no runtime switch — an install either applies the default or it does not
- No override of any built-in tool; no tool registration at all
- No npm package, no versioning, no pinning — updates come with the git package
- Independent of `background-terminal`: install either alone, or both — they never depend on each other
