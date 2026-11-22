# subagent

Lightweight, high-performance Subagent runner for [Pi coding agent](https://pi.dev).

Spawns focused child agents in isolated sessions for delegating tasks, code reviews, or investigations. Every call returns at once; the parent agent keeps working (or ends its turn) and the full result arrives as a new message. Live progress, token & cost tracking sit in the status bar and the `/subagent` menu. One call = one subagent; to run several at once, the model makes multiple `subagent` calls in the same message. `agent` and `description` are required — there is no anonymous child.

## Features

- **⚡️ Zero Bloat & Minimal Context**: Three lightweight tool schemas (~200 tokens) replace heavy multi-thousand-token multi-agent frameworks.
- **🎭 opencode's Subagent Roles, Built In**: `general` (multi-step work with the child's default toolset) and `explore` (read-only search specialist; `read, bash, grep, find, ls`) with opencode's own trigger sentences and prompts. No roles of our own ship on top. They ship as ordinary agent documents in `agents/` — copy one into `.pi/agents/` to customise it.
- **🎯 Explicit Role Required**: every call names a role from the roster, so the child's prompt, model, thinking level and tool selection come from a document you can read and edit. A missing or unknown role is rejected with the list of available roles.
- **📋 Workspace-aware Role Roster**: the tool description lists built-in and global roles. Before each agent run, the system prompt receives the current workspace roster, including project descriptions only when that project is trusted.
- **🛡️ Runaway Guardrails**: Package default 40-minute timeout and 100-turn limit prevent infinite loops or burning quota. Both are configurable per role and globally (`/subagent` → Configure Budget); 0 and negative values fall back to the default, so the ceiling cannot be switched off.
- **🔄 Pi-native Session Resumption**: paused or completed children can be resumed by their original parent session and workspace. A cross-process lock prevents concurrent writers through this extension.
- **🚀 Always Non-blocking**: The tool call returns a task id immediately; the parent turn is never held. The complete output joins the next completion batch, which requests one model continuation.
- **🎛️ Full Control Loop**: `subagent_status` checks a task (status, activity, recent tools, session log path); `subagent_stop` stops one — idempotent, session-scoped, mirroring the background-terminal run/status/kill trio.
- **📊 Progress Where It Belongs**: The footer shows `sub:N · <role> <elapsed>` for the oldest running task; `/subagent → task → View Progress` shows the detailed card (duration, thinking intent, tool traces with arguments, token usage, cost).
- **⚙️ `/subagent` Interactive Menu**:
  - **Task Monitor**: View currently running, paused, and recent subagent tasks, inspect progress or output, or stop running tasks.
  - **Fuzzy Model Search**: Model picker with real-time text filter and wrap-around keyboard navigation (Up at top loops to bottom).
  - **Back Navigation**: Pressing `Esc` in any sub-menu smoothly returns to the parent menu level.
  - **Role & Default Config**: Configure global/project default models, thinking levels, budgets, and per-role overrides (built-in or custom).

## Installation

Part of [`pi-extensions-collection`](https://github.com/ByteTrue/pi-extensions-collection):

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Add `--local` (`-l`) to scope it to the current project instead of your personal
configuration. This tracks `main`; append a tag or commit to install a historical
revision. Nothing is published to npm.

Or run the extension directly from a checkout:

```bash
pi -e /path/to/pi-extensions-collection/subagent/subagent.ts
```

The extension used to live in `ByteTrue/pi-subagent`, which is archived. The
`agents/` directory must keep its location next to `src/` — built-in roles are
resolved relative to it.

## Interactive Configuration (`/subagent`)

Run `/subagent` in the Pi TUI to interactively:
- **View Active Subagents**: Browse all active/recent subagent tasks in the current session, view output, stop running tasks, or see resume instructions.
- **Set default subagent model and thinking level**: Use real-time fuzzy search to pick models across all configured providers with wrap-around cursor movement (`Esc` to go back).
- **Configure Budget**: Set default `maxTurns` / `timeoutMs` from preset tiers (50/100/150/200 turns; 20/40/60/120 minutes) or a custom number, in the global or project scope. "Inherit budget" removes that scope's override; project defaults inherit global defaults before the package default (100 turns / 40 minutes).
- **Configure specific roles**: Customize `general`, `explore`, or any custom role with dedicated model, thinking, and budget overrides (a role budget from settings outranks the role document's own budget).
- **Run `/subagent list` or `/subagent show`**: View effective configurations and discovered agent templates.

## Settings Files

Subagent configuration lives in this package's own file, not in pi's `settings.json`:

- Global: `<pkg-config root>/subagent/settings.json`, where `<pkg-config root>` is `$PI_PKG_CFG_DIR` or `<agent dir>/pi-pkg-cfg` (`<agent dir>` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`).
- Project: `<project>/.pi/pi-pkg-cfg/subagent/settings.json`, only written when you pick the project scope in `/subagent` and the project is trusted.

Configuration menus edit the raw values in the selected scope, not the merged
global/project execution view. "Keep current" therefore cannot copy another
scope's override into the file you are editing.

Trusted project role settings merge with global role settings **field by field**. An omitted field inherits; a value replaces that field; `null` bypasses the global role field and continues at the role document, then the normal default chain. Empty `model` and `thinking` strings also mean `null`. Tool arrays replace the whole array: `[]` selects no ordinary tools, while `null` restores the document's tool selection. The role menu distinguishes "Inherit" (remove the field) from "Use role document/default" (store `null`).

**Migration from whole-role replacement:** a project role that sets only `timeoutMs` now retains the global role's model, thinking, tools, and turn limit. To keep the previous fallback for a particular field, set that project role field to `null`. An empty role object inherits all global fields. This inheritance change does not rewrite settings files.

The file holds the section directly:

```json
{
  "defaultModel": "bytetrueapi/gemini-3.7-flash",
  "defaultMaxTurns": 100,
  "defaultTimeoutMs": 2400000,
  "agents": {
    "explore": { "model": "bytetrueapi/qwen3.8-max", "thinking": "high" }
  }
}
```

Upgrading from 0.9.x: the global `subagent` section in Pi's `settings.json` (or the older `subagents.agentOverrides` shape) is copied into the new file when first read. A project legacy section is read without migration until you explicitly save project settings. The original Pi files remain untouched. A legacy file that is still live is labelled `legacy (read-only fallback)`. Once the corresponding package settings file exists, the legacy section is ignored, so make later edits in the new file.

## Tool Reference

### `subagent`

Delegate ONE task to an isolated child agent session. The call always returns at once with a task id and child sessionID; the result arrives later as a `<subagent sessionID state description>` message. To run several tasks at once, make multiple `subagent` calls in the same message — each gets its own task id, progress card, and completion notice. The child runs a separate `pi -p` process, so it cannot receive follow-ups while running; resume it by its `sub_…` session id after it stops.

Note: in print mode (`pi -p`, `--mode json`) the process exits after processing its prompt, so a subagent started there has no later user turn to report to. Pure background is the only mode by design (issue 088).

Complete child JSON events up to 1,048,576 characters are parsed normally, and a stdout chunk containing many smaller events is processed in full. Pi's `agent_end` embeds the accumulated session history and can exceed that limit even when the final report is small; the extension recognizes its bounded type prefix and discards only that redundant oversized payload. An oversized final assistant `message_end` is recovered from the latest assistant message in the child's session JSONL, and only when that message has `stopReason: "stop"`. Missing, unreadable, or non-final recovery data fails explicitly. Unknown, malformed, and other oversized event types also fail; JSON is never blindly split or silently truncated into a successful result.

Successful final responses below 40,000 characters remain inline. At 40,000 characters or more, the exact UTF-8 report is written to `result.md` in a unique, owner-only `pi-subagent-result-*` directory under the platform temporary directory. The completion notice returns its absolute path and a read instruction instead of duplicating the report inline, leaving room below the 50,000-character notice limit. The extension does not delete the result file after delivery; normal temporary-directory cleanup still applies, so the parent should read it promptly. A recovery or result-file write failure makes the run failed with an explicit error.

Process close settles the final status. A nonzero cleanup exit preserves success only after `agent_end`, a confirmed final `stopReason: "stop"`, and complete result delivery, with no assistant error. Ordinary nonzero exits, authentication failures, timeouts, and missing delivery evidence remain failures; cancellation and pauses retain their existing states. Partial output alone never proves success.

Subagent and background-command completion notices share a dispatcher. While the parent is busy, pending results flush together at `turn_end` or `agent_settled`; idle sessions batch nearby completions for 50 ms. Source-specific cards and replay details are preserved, but only the last card requests a model continuation through the steering queue. Long-running goal continuations therefore receive the whole pending batch at the next turn boundary, without a separate follow-up turn for each card. Completed tasks save a bounded notice under `<agentDir>/completion-notices` before delivery. Failed sends remain pending across `/reload`, session shutdown, and process restarts; reopening the original parent session restores its notices and deduplicates them against the in-memory queue. Restored notices retain result text and minimal terminal/replay details. The host returns no durable delivery receipt: a crash between accepting a message and removing its record may repeat a notice, while a host failure after accepting it may lose that delivery. A failed disk write is reported and keeps the in-memory retry; work that crashes before recording its completion has no saved notice.

The notice uses opencode's shape: `<subagent sessionID="sub_…" state="completed|paused|failed|cancelled" description="…">` around the child's inline result or complete-result file pointer (or "Subagent completed without a text response."). Fatal child errors are appended to any partial answer. In Pi's TUI, completion messages default to a one-line summary; Ctrl+O expands the full notice. It also lists background work still running in the parent session. Background tasks started by the child itself stop when its `pi -p` process exits, and the notice says so. Final progress always includes the launch session id and cwd, including fast tasks with no earlier progress event. The latest 100 settled tasks are retained after notification; running and unnotified records are not evicted. Each completion message is capped at 50,000 characters. Overflow switches to ID/state/session-log summaries and splits them across messages without omitting tasks. Summary `details` retains only the BySpace terminal fields (`id`, raw `status`, `sessionId`, `cwd`, `sessionFile` when known), never output/progress. Formatting switches incrementally instead of joining the whole batch first. A process-global pending queue covers reload handoff and send retries; first upgrade from a legacy manager reconciles old settled records at-least-once, so an old notice may repeat once because legacy records have no delivery marker. BySpace reporting preserves per-task order across reload, resolves logs in the child profile, sends a cancelled snapshot on session shutdown, clears failed running-report dedupe state, and retries terminal reports once with a five-second timeout.

A child that outlives a SIGKILLed or crashed parent has a journal under `$TMPDIR/pi-subagent` with owner/child PIDs and OS start identities. The next session start can reap children when the owner is definitely gone, or when both owner identities are readable and prove its PID was reused. Recovery awaits asynchronous OS queries and Windows termination commands with five-second timeouts, keeping the event loop responsive; each pass shares repeated PID queries, and overlapping passes for the same directory share one scan. Legacy journals and unreadable identities keep conservative PID-only behavior; permission errors do not prove a process is dead. The directory must be current-user-owned and private (`0700` on POSIX), and journal/start files must be current-user-owned regular files, never symlinks. Cleanup paths come from the validated journal filename; a failed termination keeps the journal for a later retry. A live child with an unverified identity also retains its journal after seven days; age alone does not prove the record is stale. Child start identities must match when both are available; only an unavailable identity permits a command-argument fallback. New resumed-child journals also record the exact verified transcript path. On Windows, unambiguous quoted arguments are checked; on Linux, `/proc/<pid>/cmdline` supplies exact arguments. The path must still name an owned regular transcript for that session and match the complete `--session` argument. Ambiguous Windows quoting, unavailable argument data, and macOS resumed-path fallback fail closed and retain the journal; macOS still recovers children whose start identities match. Until recovery runs, a child may keep running — `session_shutdown` cannot run after SIGKILL.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | `string` | **Yes** | The task instruction / prompt. |
| `agent` | `string` | **Yes** | Role name from the current roster: a built-in role (`general`, `explore`), a trusted project or global agent document, or an `agents.<name>` settings entry. Unknown or omitted names are rejected. |
| `description` | `string` | **Yes** | Short 3-5 word label. It titles the child session, the progress card, and the completion notice. |
| `tools` | `string[]` | No | Optional active tool selection (e.g. `["read", "grep", "find"]`), subject to the codemode caveats below. An explicit `[]` starts the child with `--no-tools`; omit the field to use role/default tools. |
| `cwd` | `string` | No | Optional working directory, resolved relative to the parent session workspace (including SDK sessions whose workspace differs from `process.cwd()`). |
| `resume` | `string` | No | Resume a previous stopped child by its `sub_` session id, from the original parent session and child `cwd`. Ownership, transcript existence, and exclusive use are checked before launch. Generated resume instructions include that `cwd`. |
| `timeoutMs` | `number` | No | Timeout in ms. Default: the configured global default (package default 2400000 = 40 minutes); a role document's own `timeoutMs` applies to that role. `0` and negative values fall back to the default, so the ceiling cannot be switched off. Enforced redundantly: a one-shot timer, a per-event deadline check, and a 1s watchdog — a late timer cannot stall the abort (ff 108). |
| `maxTurns` | `number` | No | Turn limit before pausing at the next `turn_start`, after the current turn's tools finish. Natural completion exactly at the limit succeeds. Default: the configured global default (package default 100); a role document's own `maxTurns` applies to that role. `0` and negative values fall back to the default. |

#### Resume ownership and recovery

New children record `{parentSessionId, cwd}` under `<child agent dir>/subagent-sessions/<id>.json`. Each run holds an exclusive `<id>.lock` in that directory until the child exits. Resume verifies this record and opens the exact owned transcript path. Keep using the same child agent directory; changing it changes where ownership and history are looked up.

Older children without ownership records cannot be resumed through the tool after this update; their history remains readable. Start a new child with the context it needs. A crash can leave a lock behind. The error includes its full path: remove only that `.lock` after confirming both the parent and child have exited. Locks are not reclaimed automatically, and manual Pi CLI invocations do not participate in this lock protocol.

#### Usage Example

The built-in explore, when the job is a read-only hunt through the codebase:

```json
{
  "agent": "explore",
  "description": "Find the retry logic",
  "task": "Find every place the retry logic is implemented or configured, very thorough; report absolute paths"
}
```

Use `general` for other self-contained work. For a specialized role, create a document such as `.pi/agents/dogfood.md`, then use the same call shape:

```json
{
  "agent": "dogfood",
  "description": "Dogfood onboarding flow",
  "task": "Dogfood the new onboarding flow and report what breaks"
}
```

Parallel fanout is just several calls in one message:

```json
[{ "agent": "explore", "description": "Map the child spawn path",
   "task": "Trace how a child process is spawned and report the exact files and lines" },
 { "agent": "general", "description": "Review the tests",
   "task": "Review the tests that cover this path and report gaps with evidence" }]
```

### `subagent_status`

Check one subagent task by id: status, elapsed time, current activity (running tool, turns, token/cost, model), recent tool calls, and the child session log path — the model can `read` that file for the full behaviour history. The task's output is never included here; it is delivered automatically as a new message when the task completes, so there is no reason to poll.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | **Yes** | Task id from the `subagent` call. |

### `subagent_stop`

Stop a running subagent task by id. Idempotent: stopping an already-finished task reports its status instead of failing. Tasks from other sessions are not visible. A cancellation notice still arrives as a new message.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | **Yes** | Task id from the `subagent` call. |


#### Built-in roles

Every call needs a role. The package ships **exactly the two subagent roles opencode ships built in** — a general-purpose worker and a read-only search specialist:

| Role | Tools | For |
|---|---|---|
| `general` | child defaults (`read, bash, edit, write`, plus default-active extensions) | Researching complex questions and executing multi-step work; no role-specific system prompt, like opencode's `general`. |
| `explore` | `read, bash, grep, find, ls` | Fast, read-only codebase search: files by pattern, code by keyword, or how something works. Say how thorough you want it (`quick` / `medium` / `very thorough`). |

opencode's subagent set is `general` + `explore` (its `plan` is a primary agent, not a subagent), and the trigger sentences and the `explore` prompt here are copied verbatim from it. Add `.pi/agents/<name>.md` (project) or `~/.pi/agent/agents/<name>.md` (user) for any other job. Project documents are loaded only when the project is trusted, the same gate as project settings; user/global documents always load. A built-in document is an ordinary agent file in the package's `agents/` directory, parsed by the same code as your own `.pi/agents/*.md`, and a file with the same name wins over the packaged one. Both built-in documents use the package budget and inherit the parent's model and thinking. Copy one out to customise it:

```bash
mkdir -p .pi/agents
cp /path/to/pi-extensions-collection/subagent/agents/explore.md .pi/agents/explore.md
```

**Migrating**: the roles we used to ship on top of opencode's (`reviewer`, and earlier `plan` / `general-purpose`) are gone; `explore` is back under opencode's name and prompt. An `agents.reviewer` block in your settings file still resolves (settings-only roles stay valid), but it now carries no prompt and no tool selection — recreate it as `.pi/agents/reviewer.md` for the old behaviour. Any other name with neither a document nor a settings entry is rejected with the list of available roles.

```markdown
---
model: your-provider/your-model
---
```

A document replaces the built-in entirely, so keep the fields you still want — `tools` in particular. Omitting `tools` uses the child's Pi defaults and default-active extension tools; it does not copy the parent's complete active tool list.

#### Role descriptions and the roster

Every agent document supports a `description:` frontmatter line. It is the trigger sentence the dispatching model reads in the roster (`- name: description`, one per line); it is not part of the child's task prompt. Write it as an instruction to the caller, not a property label:

```markdown
---
description: Database migration auditor. Use it to inspect schema drift.
tools: read, grep, find
---
```

The static tool description includes built-in and global roles only. At `before_agent_start`, the extension refreshes the roster from the current session's `ctx.cwd` and project trust state, and supplies any changed roster in the system prompt. This also covers SDK sessions whose workspace differs from `process.cwd()` and documents added during a session; no tool re-registration is needed. Roles without a `description:` use "This subagent should only be called when explicitly requested."

Untrusted project roles contribute neither names nor descriptions. Trusted project documents can override global/built-in roles, and the execution path uses the same trust gate. Role names may contain ordinary spaces, dots, and Unicode, but are capped at 128 characters and reject control and line-separator characters in both discovery and resolution.

#### Extension tools and role documents

`--tools` selects the child's ordinary active tools. Pi also keeps configured MCP tools when the list contains only ordinary names; an explicit MCP selection or `--no-tools` filters them. When the parent has `codemode` active, this extension adds `codemode` to a nonempty explicit tool list. Pi tools registered with `codemode` or `deferred` exposure remain callable from codemode even when they are not active, so this selection is **not a security sandbox**. An explicit `tools: []` uses `--no-tools` and does not add codemode.

The built-in `explore` names `read, bash, grep, find, ls`; `grep`/`find`/`ls` are otherwise off by default. Its prompt requires read-only work, but `bash` can write files or change system state, and inherited codemode can reach other tools. Enforce strict isolation outside the agent when the task requires it.

To select additional extension tools, put the complete list in `agents.<role>.tools` in the package settings file. It replaces the document's `tools:`, so include the role's baseline as well as the additions. Older billion-context-pi versions wrote `subagents.agentOverrides.<role>.tools` in Pi's settings; that is a legacy fallback and has no effect once the corresponding package settings file exists.

#### Environment pass-through

The reverse is just as common: an extension registers tools into *every* pi process, including children, where they may not work. The `env` section in this package's settings file passes extra environment variables to every child, so you can switch such an extension off for children without this package knowing anything about it.

```json
{
  "env": {
    "BILLION_CONTEXT_PLUGIN": "0"
  }
}
```

- Read from the global and trusted-project package settings files described above; project keys win on conflict, unset keys are kept from global. The legacy `subagent.env` section in Pi settings is still supported through migration/fallback.
- Values must be strings — numbers and booleans are ignored rather than silently coerced, so a switch that tests for `"0"` cannot be handed a `0`.
- `PI_SUBAGENT_CHILD` is applied **after** your values and is not overridable: it is this extension's recursion guard, and a child that lost it would load this extension again and recurse.
- This is a plain pass-through. Unrelated to the env, the child still inherits the parent's environment as before.

#### Model and Thinking Resolution

The Agent-facing tool deliberately does not expose model or thinking overrides. These execution-policy choices remain under user control through `/subagent`, settings, and agent documents.

The model priority chain is:

1. `agents[role].model` — per-role binding (settings file)
2. An agent document — `.pi/agents/<name>.md`, `<agentDir>/agents/<name>.md`, or the packaged built-in
3. `defaultModel` — explicit subagent default (settings file)
4. Parent session's current fully qualified provider/model (inherited)
5. The child `pi` process's own default

Thinking follows the same user-controlled chain: role settings, agent document, subagent default, then the parent session. Neither built-in document pins a thinking level, so both inherit; pin one per role in `/subagent` → Configure an Agent Role or `agents.<role>.thinking` when a role deserves more. No provider is hardcoded.

Root-level pi settings `defaultProvider`/`defaultModel`/`defaultThinkingLevel` are deliberately **not** consulted — unset subagent configuration means "inherit".

#### Budget Resolution

The budget is the pair `maxTurns` / `timeoutMs`. Its chain has the same shape as the model chain, with the package constants as the last stop:

1. The call parameter (`maxTurns` / `timeoutMs`) — one task
2. `agents[role].maxTurns` / `agents[role].timeoutMs` — per-role binding (settings file)
3. The role document's `maxTurns:` / `timeoutMs:` frontmatter — the role's own budget
4. `defaultMaxTurns` / `defaultTimeoutMs` (settings file) — global default
5. Package constants: **100 turns / 40 minutes**

Layer 3 outranks layer 4, so a global default cannot shrink a role's own budget; neither built-in document carries one, so both take the global default. The tool description advertises the configured **global** default, evaluated when the tool registers, and says that role documents and this parameter can raise it — after changing settings, `/reload` makes the advertised number follow.

**The ceiling cannot be turned off**: `0`, negatives, and non-numeric values are dropped at every layer, and reaching the ceiling pauses the child with a session id and resume hint. **A resumed run gets a fresh full window** — budgets are per segment, not cumulative, so resuming once means two budgets' worth of work. That is the intended reading: one run gets its budget, and a resume is a second chance, not an leftover allowance.

## Paseo compatibility

Launch details expose the task/session ids and a private async directory under the OS temporary directory (`pi-subagent/paseo-…`). A `status.json` snapshot links the child transcript and records running or terminal state. Completion notices use `subagent-notify` with Paseo-compatible headers and transcript pointers; failures and stopped tasks receive individual notices. Resumed tasks get distinct transcript aliases so replay can follow each continuation. These files supplement the ordinary task manager and do not change the background execution model.

On extension load, abandoned async directories older than seven days are eligible for cleanup once their owner process is gone. Resume aliases are retained while their transcript exists. Compatibility tests cover launch, shutdown, stop, and resume message shapes; live Paseo desktop replay has not been verified.

## License

MIT
