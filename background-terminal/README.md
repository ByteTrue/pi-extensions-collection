<h1 align="center">background-terminal</h1>

<p align="center">Pure background execution: <code>background_run</code> starts a command, returns a task id immediately, and notifies you when it exits.</p>

> [!IMPORTANT]
> The optional 120s foreground shell default is **not part of this extension** — Pi ships with no foreground timeout, and this extension does not add one. The default lives in the separate [`bash-timeout`](../bash-timeout) extension, installed by the same package; disable that entry in `pi config` if you don't want it.

Pi's built-in `bash` is the foreground executor — and this extension never touches it. It adds one standalone tool for the other half of the decision:

- **Need the command's output to continue?** Use `bash` — it blocks and returns the result.
- **Should it run hands-off (builds, test suites, dev servers, watch mode)?** Use `background_run` — it returns a task id immediately, and the Agent keeps working or ends its turn, and the command's exit arrives as a new message (exit code + bounded output tail) that starts the next turn. That notification is how the Agent waits.

`background_run(command, timeout?)`:

- **No lifetime by default** (opencode's background shell): the task runs until it exits or the Pi session ends. Pass `timeout` in seconds to set a bound; `0` also means no timeout, and an explicit positive value is honored without a second cap (only Pi's own 2,147,483-second platform maximum applies). When a bound fires, the task is killed and the notice says so; restart it with `background_run` to renew a service.
- Full stdout/stderr stream live to an output file (path in the result); the Agent reads it with Pi's built-in `read` only when needed.
- In TUI/RPC sessions the exit notification fires normally. In `pi -p` the process exits with the turn, so a task started there dies before its exit can be reported — hands-off backgrounding belongs in interactive sessions (subagent children are killed by their own `session_shutdown`).

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Restart or reload Pi, then ask naturally:

> Start the test suite running hands-off — get back to me when it finishes.

The Agent calls `background_run`, keeps working or waits, and reports the outcome when the exit notification arrives. Completions that pile up while the Agent is busy arrive as one batched follow-up, not one turn per task.

## Tools

| Tool | Required input | Result |
| --- | --- | --- |
| `background_run` | `command` | Task id, `status: running`, output file path, immediately; exit reported via follow-up; optional `timeout` (omit or `0` = no timeout) |
| `background_status` | `id` | Status, exit code, line count, output path, and recent output |
| `background_kill` | `id` | Stops a running task |

No built-in tool is overridden, shadowed, or registered under a built-in name.

## Staying out of the built-ins' way

- `bash` (and `powershell`) keep their exact built-in behavior. The optional 120s default (and the timeout-error steering block) lives in the [`bash-timeout`](../bash-timeout) extension in this repo.
- The `background_run` path applies your `shellPath` / `shellCommandPrefix` settings (read through Pi's own `SettingsManager`, honoring project trust) and the same session environment the built-in tools set (`PI_*` variables plus the agent bin dir on `PATH`).
- Uninstalling removes exactly the three tools above; the built-ins were never touched.

Requires `@earendil-works/pi-coding-agent >=1.1.0`.

## Lifecycle

A task ends when:

- the command exits (the agent is woken with the outcome);
- `background_kill` stops it (reported as `killed`);
- its explicit `timeout` expires (status `timed_out`, the agent is woken); or
- the owning Pi session shuts down, or Pi receives SIGTERM/SIGHUP: tasks spawn through Pi's own shell backend and are killed with it. **SIGKILL and hard crashes cannot run cleanup.** Each task writes a journal (owner Pi pid, task pid, start time); the next extension load calls `reapOrphans`, kills tasks whose owner is gone, and removes their journal and log. Until that next load the task can keep running; no portable OS primitive kills it at the moment of SIGKILL. A command that daemonizes itself still escapes, same as built-in bash.

Manual stops and `background_kill` report a `killed` notice. Session cleanup is silent because the session is ending. Tasks survive `/reload` inside the same session, but they do not survive Pi exiting. Reload flushes any completions buffered while the agent was busy before returning, and a process-global queue covers the old/new runtime handoff and retries after `sendMessage` failures. First upgrade from a legacy manager also reconciles its settled records at-least-once: an old notice may repeat once because legacy records have no delivery marker. Metadata cleanup failures cannot suppress a completion notice.

Completion notices are wrapped in a `<shell id state command>` tag; the body carries a bounded output tail (last 50 lines or 4,000 characters, with ANSI/control sequences stripped), the exit code or error, and the full output file path. Each completion message is capped at 50,000 characters. Overflow switches to ID/state/path summaries and splits them across as many messages as needed, so every task remains discoverable. Summary `details` contains only minimal terminal fields and output paths, never output tails. Formatting switches to summaries incrementally instead of joining the whole batch first. Output write failures are shown as `failed` even when the command exits zero. In Pi's TUI, completion messages default to a one-line summary; Ctrl+O expands the full notice. `state` is pi's task state (`completed`, `failed`, `timed_out`, `killed`), a superset of opencode's `completed`/`error`/`cancelled`. The same provider registry is exposed to `goal` (wait while shells run) and `subagent` (list still-running work in its completion notice). A notice is delivered at the next turn boundary, not only when the whole goal loop stops. The latest 100 tasks by settlement time are retained after notification; running and unnotified tasks are never evicted by this history limit. Evicted tasks' output files remain readable until real session shutdown and are protected from orphan sweeps, then are cleaned up with the rest of the session output.

Output is stored under `$TMPDIR/background-terminal/` and removed at real session shutdown. The directory must be current-user-owned and private (`0700` on POSIX); journals must have valid IDs, and cleanup paths come from those IDs rather than path strings inside the JSON. Journal/PID/start files must be current-user-owned regular files, never symlinks. When recorded and current start times are both available they must match; the command marker is only a fallback when start time is unavailable. Each task also writes `bg_*.journal.json` / `.pid` / `.start` beside its log for the next-start reaper; those files are removed when the task settles, is killed, or is reaped. A fresh journal without a PID gets a 10-second wrapper-startup grace period. On macOS the reaper pauses the process group before killing it. Output files cap at 50 MiB: beyond that the file stops growing and a marker records what was dropped (the task itself keeps running). Tasks are isolated by session id. If Pi crashes, stale logs older than 7 days without a corresponding journal are swept the next time the extension loads; logs with a live, dead, corrupt, or unverifiable journal are left alone.

## Deliberate limits

- Pure background: no foreground wait, no inline output (that is `bash`'s job)
- No override of any built-in tool, and no foreground shell timeout hook (see the [`bash-timeout`](../bash-timeout) extension for the optional 120s default)
- No PTY or interactive stdin
- No custom `cwd` or environment input
- No configurable defaults (no task lifetime by default / 50 MiB output cap)
- No daemon, tmux dependency, Web UI, or cross-session persistence
- No output pagination in tool results—`read` handles large output

## Development

```bash
npm --workspace background-terminal test
npm --workspace background-terminal run typecheck
```
