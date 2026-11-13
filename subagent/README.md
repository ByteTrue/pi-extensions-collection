# subagent

Lightweight, high-performance Subagent runner for [Pi coding agent](https://pi.dev).

Spawns focused child agents in isolated sessions for delegating tasks, code reviews, or investigations. Every call returns at once; the parent agent keeps working (or ends its turn) and the full result arrives as a new message. Live progress, token & cost tracking sit in the status bar and the `/subagent` menu. One call = one subagent; to run several at once, the model makes multiple `subagent` calls in the same message. `agent` and `description` are required — there is no anonymous child.

## Features

- **⚡️ Zero Bloat & Minimal Context**: Three lightweight tool schemas (~200 tokens) replace heavy multi-thousand-token multi-agent frameworks.
- **🎭 opencode's Subagent Roles, Built In**: `general` (multi-step work with the inherited toolset) and `explore` (read-only search specialist; `read, bash, grep, find, ls`) with opencode's own trigger sentences and prompts. No roles of our own ship on top. They ship as ordinary agent documents in `agents/` — copy one into `.pi/agents/` to customise it.
- **🎯 Explicit Role Required**: every call names a role from the roster, so the child's prompt, model, thinking level and tool allowlist come from a document you can read and edit. A missing or unknown role is rejected with the list of available roles.
- **📋 Role Roster in the Tool Description**: each role document's `description:` frontmatter — a trigger sentence ("Use it to…") — is embedded in the `subagent` tool description, so the dispatching model sees when to use every role, including your custom `.pi/agents/*.md` (issue 102).
- **🛡️ Runaway Guardrails**: Package default 40-minute timeout and 100-turn limit prevent infinite loops or burning quota. Both are configurable per role and globally (`/subagent` → Configure Budget); 0 and negative values fall back to the default, so the ceiling cannot be switched off.
- **🔄 Pi-native Session Resumption**: Subagents assign clean project session IDs; paused or completed sessions can be resumed with `resume: "<sessionId>"`.
- **🚀 Always Non-blocking**: The tool call returns a task id immediately; the parent turn is never held. The complete output is delivered as a follow-up message that starts the next turn.
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
pi install git:github.com/ByteTrue/pi-extensions-collection@v2.0.0
```

Add `--local` (`-l`) to scope it to the current project instead of your personal
configuration. Drop the `@v2.0.0` ref to track `main`. Nothing is published to npm.

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
- **Configure Budget**: Set the global default `maxTurns` / `timeoutMs` from preset tiers (50/100/150/200 turns; 20/40/60/120 minutes) or a custom number, in the global or project scope. "Clear override" falls back to the package default (100 turns / 40 minutes).
- **Configure specific roles**: Customize `general`, `explore`, or any custom role with dedicated model, thinking, and budget overrides (a role budget from settings outranks the role document's own budget).
- **Run `/subagent list` or `/subagent show`**: View effective configurations and discovered agent templates.

## Settings Files

Subagent configuration lives in this package's own file, not in pi's `settings.json`:

- Global: `<pkg-config root>/subagent/settings.json`, where `<pkg-config root>` is `$PI_PKG_CFG_DIR` or `<agent dir>/pi-pkg-cfg` (`<agent dir>` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`).
- Project: `<project>/.pi/pi-pkg-cfg/subagent/settings.json`, only written when you pick the project scope in `/subagent` and the project is trusted.

Configuration menus edit the raw values in the selected scope, not the merged
global/project execution view. "Keep current" therefore cannot copy another
scope's override into the file you are editing.

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

Upgrading from 0.9.x: an existing `subagent` section in pi's `settings.json` (or the older `subagents.agentOverrides` shape) is copied whole into the new file the first time it is read or written, and pi's `settings.json` is left untouched so you can roll back. A legacy file that is still the live one is reported as `legacy (read-only fallback): <path>`. Project-level sections in `<project>/.pi/settings.json` are read but never rewritten; they keep applying until you delete them.

## Tool Reference

### `subagent`

Delegate ONE task to an isolated child agent session. The call always returns at once with a task id and child sessionID; the result arrives later as a `<subagent sessionID state description>` message. To run several tasks at once, make multiple `subagent` calls in the same message — each gets its own task id, progress card, and completion notice. The child runs a separate `pi -p` process, so it cannot receive follow-ups while running; resume it by its `sub_…` session id after it stops.

Note: in print mode (`pi -p`, `--mode json`) the process exits after one turn, so a subagent started there has no next turn to report to. Pure background is the only mode by design (issue 088).

Note: the `subagent-exit` completion notice is queued while the parent agent is busy in a turn (delivered in a batch at `agent_settled`). If the parent turn runs for hours, notices accumulate for that duration — check `subagent_status` for live status in the meantime.

The notice uses opencode's shape: `<subagent sessionID="sub_…" state="completed|paused|failed|cancelled" description="…">` around the child's full result (or "Subagent completed without a text response."). Fatal child errors are appended to any partial answer. In Pi's TUI, completion messages default to a one-line summary; Ctrl+O expands the full notice. It also lists background work still running in the parent session. Background tasks started by the child itself stop when its `pi -p` process exits, and the notice says so. Final progress always includes the launch session id and cwd, including fast tasks with no earlier progress event. The latest 100 settled tasks are retained after notification; running and unnotified records are not evicted. Each completion message is capped at 50,000 characters. Overflow switches to ID/state/session-log summaries and splits them across messages without omitting tasks. Summary `details` retains only the BySpace terminal fields (`id`, raw `status`, `sessionId`, `cwd`, `sessionFile` when known), never output/progress. Formatting switches incrementally instead of joining the whole batch first. A process-global pending queue covers reload handoff and send retries; first upgrade from a legacy manager reconciles old settled records at-least-once, so an old notice may repeat once because legacy records have no delivery marker. BySpace reporting sends a cancelled snapshot on session shutdown, clears failed running-report dedupe state, and retries terminal reports once with a five-second timeout.

A child that outlives a SIGKILLed or crashed parent writes a journal under `$TMPDIR/pi-subagent` (owner pid, child pid, start time). The directory must be current-user-owned and private (`0700` on POSIX), and journals must have valid IDs and PIDs; cleanup paths come from the validated journal filename, not path strings inside the JSON. The next extension load reaps children whose owner is gone. Journal/start files must be current-user-owned regular files, never symlinks. Recorded and current start times must match when both are available; only an unavailable start time falls back to a full `--session <id>` command argument match. Then the journal is removed. Until that next start the child process may keep running — session_shutdown cannot run after SIGKILL.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | `string` | **Yes** | The task instruction / prompt. |
| `agent` | `string` | **Yes** | Role name from the roster embedded in the tool description: a built-in role (`general`, `explore`) or any custom `.pi/agents/<name>.md`. A name matching no document is rejected with the list of available roles; omitting it is an error. |
| `description` | `string` | **Yes** | Short 3-5 word label. It titles the child session, the progress card, and the completion notice. |
| `tools` | `string[]` | No | Optional tool allowlist (e.g. `["read", "grep", "find"]`). An explicit `[]` starts the child with `--no-tools`; omit the field to inherit role/default tools. |
| `cwd` | `string` | No | Optional working directory for the task. |
| `resume` | `string` | No | Resume a previous subagent session by id (must start with `sub_`; sessions not created by this extension are rejected). Generated resume instructions also include the resolved child `cwd`. |
| `timeoutMs` | `number` | No | Timeout in ms. Default: the configured global default (package default 2400000 = 40 minutes); a role document's own `timeoutMs` applies to that role. `0` and negative values fall back to the default, so the ceiling cannot be switched off. Enforced redundantly: a one-shot timer, a per-event deadline check, and a 1s watchdog — a late timer cannot stall the abort (ff 108). |
| `maxTurns` | `number` | No | Turn limit before pausing at the next `turn_start`, after the current turn's tools finish. Natural completion exactly at the limit succeeds. Default: the configured global default (package default 100); a role document's own `maxTurns` applies to that role. `0` and negative values fall back to the default. |

#### Usage Example

The built-in explore, when the job is a read-only hunt through the codebase:

```json
{
  "agent": "explore",
  "description": "Find the retry logic",
  "task": "Find every place the retry logic is implemented or configured, very thorough; report absolute paths"
}
```

Any other self-contained job needs a small role document first (`.pi/agents/dogfood.md`), then the same shape:

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
| `general` | inherited (`read, bash, edit, write`) | Researching complex questions and executing multi-step work; no role-specific system prompt, like opencode's `general`. |
| `explore` | `read, bash, grep, find, ls` | Fast, read-only codebase search: files by pattern, code by keyword, or how something works. Say how thorough you want it (`quick` / `medium` / `very thorough`). |

opencode's subagent set is `general` + `explore` (its `plan` is a primary agent, not a subagent), and the trigger sentences and the `explore` prompt here are copied verbatim from it. Add `.pi/agents/<name>.md` (project) or `~/.pi/agent/agents/<name>.md` (user) for any other job. Project documents are loaded only when the project is trusted, the same gate as project settings; user/global documents always load. A built-in document is an ordinary agent file in the package's `agents/` directory, parsed by the same code as your own `.pi/agents/*.md`, and a file with the same name wins over the packaged one. Both built-in documents use the package budget and inherit the parent's model and thinking. Copy one out to customise it:

```bash
mkdir -p .pi/agents && cp node_modules/@bytetrue/pi-subagent/agents/explore.md .pi/agents/explore.md
```

**Migrating**: the roles we used to ship on top of opencode's (`reviewer`, and earlier `plan` / `general-purpose`) are gone; `explore` is back under opencode's name and prompt. An `agents.reviewer` block in your settings file still resolves (settings-only roles stay valid), but it now carries no prompt and no tool allowlist — recreate it as `.pi/agents/reviewer.md` for the old behaviour. Any other name with neither a document nor a settings entry is rejected with the list of available roles.

```markdown
---
model: your-provider/your-model
---
```

A document replaces the built-in entirely, so keep the fields you still want — `tools` in particular. Omitting `tools` leaves the child on pi's default set (`read, bash, edit, write`).

#### Role descriptions and the roster

Every agent document supports a `description:` frontmatter line. It is **not** injected into the child's prompt — it is the trigger sentence the dispatching model reads: the `subagent` tool description embeds the roster of all discovered roles (`- name: description`, one per line), so the model can match a job to a role. Write it as an instruction to the caller, not a property label:

```markdown
---
description: Database migration auditor. Use it to inspect schema drift.
tools: read, grep, find
---
```

The roster is built when the extension registers the tool. Agent documents added mid-session still resolve immediately when passed as `agent`, but they appear in the advertised roster after a `/reload`. Roles without a `description:` use the default trigger sentence "This subagent should only be called when explicitly requested."

Project-only role names are listed, but their document is not read at load: an untrusted project's `description:` must not enter the tool prompt. Such roles show the default trigger sentence in the roster; the document (prompt, tools, model) is read only when the project is trusted and the role is actually called. Role names may contain ordinary spaces, dots, and Unicode, but are capped at 128 characters and reject control and line-separator characters in both discovery and resolution.

#### Extension tools and role documents

`--tools` is an **allowlist that replaces the default selection**, so a role that names its own `tools:` receives only those names — extension tools are not added on top. The built-in `explore` document names `read, bash, grep, find, ls` — `grep`/`find`/`ls` are off by default in pi, and naming them is the point: it is the search specialist. It grants no `edit`/`write`, which makes "search only" a capability boundary rather than just a prompt. A role that omits `tools:` (like `general`) inherits pi's full default set, extension tools included.

If you want a read-only child to also carry an extension's tool (for example the context tools from [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)), add them through settings rather than editing a packaged document: an older billion-context-pi's `/acp-subagents <package-dir>` writes a combined tool list to `subagents.agentOverrides.<role>.tools`, which this extension reads as a per-role override. Note that an override **replaces** the document's `tools:`, so it must list the role's full baseline, not just the additions.

#### Environment pass-through

The reverse is just as common: an extension registers tools into *every* pi process, including children, where they may not work. `subagent.env` passes extra environment variables to every child, so you can switch such an extension off for children without this package knowing anything about it.

```json
{
  "subagent": {
    "env": {
      "BILLION_CONTEXT_PLUGIN": "0"
    }
  }
}
```

- Read from both `.pi/settings.json` (project) and `~/.pi/agent/settings.json` (global); project keys win on conflict, unset keys are kept from global.
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

## License

MIT
