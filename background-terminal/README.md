<h1 align="center">background-terminal</h1>

<p align="center">Pure background execution: <code>background_run</code> starts a command, returns a task id immediately, and notifies you when it exits.</p>

> [!IMPORTANT]
> The optional 120s foreground shell default is **not part of this extension** — Pi ships with no foreground timeout, and this extension does not add one. The default lives in the separate [`bash-timeout`](../bash-timeout) extension, installed by the same package; disable that entry in `pi config` if you don't want it.

Pi's built-in `bash` is the foreground executor — and this extension never touches it. It adds one standalone tool for the other half of the decision:

- **Need the command's output to continue?** Use `bash` — it blocks and returns the result.
- **Should it run hands-off (builds, test suites, dev servers, watch mode)?** Use `background_run` — it returns a task id immediately, and the Agent keeps working or ends its turn, and the command's exit arrives as a new message (exit code + bounded output tail) that starts the next turn. That notification is how the Agent waits.

`background_run(command, timeout?)`:

- **No lifetime by default** (opencode's background shell): the task runs until it exits or the Pi session ends. Pass `timeout` in seconds to set a bound; `0` also means no timeout, and an explicit positive value is honored without a second cap (only Pi's own 2,147,483-second platform maximum applies). When a bound fires, the task is killed and the notice says so; restart it with `background_run` to renew a service.
- stdout/stderr stream live to an output file (path in the result), up to 50 MiB plus a truncation marker. When the file writer is full, both child pipes pause until it drains, so a slow disk slows the producer instead of accumulating an unbounded write queue. The Agent reads the log with Pi's built-in `read` only when needed; the recent-output preview continues updating after the file reaches its cap.
- In TUI/RPC sessions the exit notification fires normally. In `pi -p` the process exits with the turn, so a task started there dies before its exit can be reported — hands-off backgrounding belongs in interactive sessions (subagent children are killed by their own `session_shutdown`).

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Restart Pi after installing or updating the package. Let running tasks finish before updating. Then ask naturally:

> Start the test suite running hands-off — get back to me when it finishes.

The Agent calls `background_run`, keeps working or waits, and reports the outcome when the exit notification arrives. Background commands and subagents share a completion dispatcher: queued results enter together at the next turn boundary, and each batch requests one model continuation. Idle completions have a 50 ms batching window. Source-specific cards and replay details remain available.

## Tools

| Tool | Required input | Result |
| --- | --- | --- |
| `background_run` | `command` | Task id, `status: running`, output file path, immediately; exit reported via a batched completion notice; optional `timeout` (omit or `0` = no timeout) |
| `background_status` | `id` | Status, exit code, line count, output path, and recent output |
| `background_kill` | `id` | Stops a running task; reports success after termination is confirmed, or an error after 5 seconds without confirmation |

`/background` lists running commands. **View output** opens a snapshot of the recent tail (last 50 lines, up to 4,000 characters), with terminal control sequences stripped and an omission marker when earlier output is excluded. It shows the full log path and the 50 MiB file limit; it never loads the whole log into the editor. Use `read` on that path for saved output. The log keeps its first 50 MiB while the preview keeps following the latest output.

No built-in tool is overridden, shadowed, or registered under a built-in name.

## Staying out of the built-ins' way

- The optional 120s default for Pi's built-in `bash` and `powershell` lives in the separate [`bash-timeout`](../bash-timeout) extension.
- The `background_run` path applies your `shellPath` / `shellCommandPrefix` settings (read through Pi's own `SettingsManager`, honoring project trust) and the same session environment the built-in tools set (`PI_*` variables plus the agent bin dir on `PATH`).
- Uninstalling removes exactly the three tools above; the built-ins were never touched.

Requires `@earendil-works/pi-coding-agent >=1.5.0`.

## Lifecycle

A task ends when:

- the command exits (the agent is woken with the outcome);
- `background_kill` stops it (reported as `killed`);
- its explicit `timeout` expires (status `timed_out`, the agent is woken); or
- the owning Pi session shuts down, or Pi receives SIGTERM/SIGHUP: the extension terminates its child process groups. Its shell executor also registers process-exit cleanup across reloads. **SIGKILL and hard crashes cannot run cleanup.** Each task writes a journal (owner Pi PID and OS start identity, plus child PID/start files); the next extension load calls `reapOrphans`, verifies and terminates children whose owner is gone or whose owner PID has been reused, and removes their journal and log. Until that next load the task can keep running; no portable OS primitive kills it at the moment of SIGKILL. A command that daemonizes itself still escapes, same as built-in bash.

Manual stops and `background_kill` wait up to 5 seconds for termination to be confirmed and report a `killed` notice. An unconfirmed stop returns an error and leaves the task tracked. Session cleanup is silent because the session is ending. Tasks survive `/reload` inside the same session, but they do not survive Pi exiting. Reload flushes any completions buffered while the agent was busy before returning, and a process-global queue covers the old/new runtime handoff and retries after `sendMessage` failures. Metadata cleanup failures cannot suppress a completion notice. Completed tasks save a bounded notice under `<agentDir>/completion-notices` before delivery; reopening the original parent session restores pending notices after a process restart, deduplicated against the memory queue. Pending notices retain their output logs through session cleanup and orphan recovery. A private `.log.profile` sidecar identifies the owning notice store, so cleanup from another Pi profile also preserves pending output. Unreadable notice stores or invalid ownership markers keep the log for retry. The host provides no durable delivery receipt, so a crash during delivery can still cause a repeated or lost notice. Disk write failures are reported and leave the in-memory retry available; tasks that crash before completion is recorded have no saved notice.

Completion notices are wrapped in a `<shell id state command>` tag; the body carries a bounded output tail (last 50 lines or 4,000 characters, with ANSI/control sequences stripped), the exit code or error, and the full output file path. Each completion message is capped at 50,000 characters. Overflow switches to ID/state/path summaries and splits them across as many messages as needed, so every task remains discoverable. Summary `details` contains only minimal terminal fields and output paths, never output tails. Formatting switches to summaries incrementally instead of joining the whole batch first. Output write failures stop the producer and are shown as `failed`; a zero command exit cannot hide a failed log write. In Pi's TUI, completion messages default to a one-line summary; Ctrl+O expands the full notice. `state` is pi's task state (`completed`, `failed`, `timed_out`, `killed`), a superset of opencode's `completed`/`error`/`cancelled`. The same provider registry is exposed to `goal` (wait while shells run) and `subagent` (list still-running work in its completion notice). Busy sessions receive notices through the steering queue at the next turn boundary, including during a goal loop. Only the last card in a batch requests a continuation; earlier cards enter the same model context without requesting separate turns. The latest 100 tasks by settlement time are retained after notification; running and unnotified tasks are never evicted by this history limit. Evicted tasks' output files remain readable until real session shutdown and are protected from orphan sweeps, then are cleaned up with the rest of the session output.

Output is stored under `$TMPDIR/background-terminal/`. Real session shutdown removes delivered tasks’ logs and preserves logs with pending completion notices. The directory must be a real directory; on POSIX it must be current-user-owned and private (`0700`). Journals must have valid IDs, and cleanup paths come from those IDs rather than path strings inside the JSON. Journal/PID/start files must be regular files, never symlinks, and must be current-user-owned on POSIX. Windows relies on the temp directory’s existing access controls: each OS account must use a private temp directory whose ACL prevents other users from modifying these files. The extension does not inspect or repair Windows ACLs; a shared writable temp directory is unsupported. When recorded and current child start times are both available they must match; the command marker is only a fallback when the child start time is unavailable. Each task also writes a `.log.profile` ownership sidecar and `bg_*.journal.json` / `.pid` / `.start` beside its log for the next-start reaper; the journal/PID/start files are removed when the task settles, is killed, or is reaped. The ownership sidecar stays until its log is removed. Process identity is recorded before `shellCommandPrefix` runs. A fresh journal without a PID gets a 10-second wrapper-startup grace period. On macOS the reaper pauses the process group before killing it. On Windows it records the native Windows PID and process start time, and uses the system `taskkill.exe` to terminate the tree. Failed termination or unverifiable identity keeps the journal and output for a later retry. Output files retain the first 50 MiB plus a marker when further bytes are dropped; the task and recent-output preview keep running. Tasks are isolated by session id. If Pi crashes, stale logs older than 7 days without a corresponding journal or pending completion notice are swept the next time the extension loads; logs with a live, dead, corrupt, or unverifiable journal are left alone. The OS may still clean its temporary directory independently.

New journals include `ownerStart`, obtained from the OS (`Get-Process.StartTime` UTC ticks on Windows, `ps lstart` on POSIX), independently of the task’s `startedAt` timestamp. The owner identity is captured once on the first task start per module load. A live owner PID is considered reused only when both recorded and current identities are readable and differ. Old journals without `ownerStart`, invalid or empty identities, and failed identity probes keep the conservative rule: retain the task while the owner PID may still be alive. A definitely absent owner PID permits recovery under the existing child checks. No backfill or destructive migration is needed; let tasks finish and restart Pi when updating.

Recovery runs asynchronously at session start. OS probes and Windows termination commands each have a 5-second timeout; timers and the UI event loop remain responsive while recovery is pending. Each pass shares repeated PID/start/command queries and termination results, and overlapping scans share one pass. A large set of distinct stale processes can still delay completion of session startup. See the [original controlled recovery measurement](../bywork/work/audit-followup/background.md) for the former synchronous implementation. Strict Windows descendant lifetime guarantees would require host support such as Job Objects. The extension uses its own small pause/resume shell executor because the host’s output callback cannot await a disk drain; shell discovery and settings still come from Pi.

## Deliberate limits

- Pure background: no foreground wait, no inline output (that is `bash`'s job)
- No override of any built-in tool, and no foreground shell timeout hook (see the [`bash-timeout`](../bash-timeout) extension for the optional 120s default)
- No PTY or interactive stdin
- No custom `cwd` or environment input
- No configurable defaults (no task lifetime by default / 50 MiB output cap)
- No daemon, tmux dependency, Web UI, or running-task persistence across Pi exits
- With native Windows Pi, `background_run` requires Git for Windows Bash, MSYS2 Bash, or Cygwin Bash exposing `/proc/<pid>/winpid`, plus the system Windows PowerShell for process identity queries. Native PowerShell/cmd and WSL-backed shells are not supported command shells for this wrapper
- No output pagination in tool results—`read` handles large output

## Development

```bash
npm --workspace background-terminal test
npm --workspace background-terminal run typecheck
```
