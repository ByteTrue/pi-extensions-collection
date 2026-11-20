# goal

One durable objective per session. The agent keeps working on it turn after turn
until it declares completion with evidence — no more typing「继续」every three
minutes.

One extension in this repo. It follows opencode's goal plugin where pi allows it:
the objective is treated as untrusted data (not system instructions), the loop
has a 50-round budget, three no-tool continuations pause it, and background work
in the same session holds it instead of injecting another continuation. There is
no task tree, no dashboard, no token budget, no judge model.

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Restart or reload Pi. Nothing to configure.

## Use

Start a goal manually with `/goal <objective>`. The model cannot start one.

```text
/goal Reduce p95 checkout latency below 120 ms without breaking the test suite
```

The objective goes into the system prompt as a `<goal>` section, wrapped in
`<untrusted_objective>` so the model treats it as the task, not as higher-priority
instructions. The objective is capped at 4000 characters and restated in each
continuation. At the end of a turn, an active goal asks Pi to continue.

It stops when the agent calls `goal_done`:

```json
{ "summary": "p95 is 96 ms on the checkout benchmark", "evidence": "npm run bench → p95 96 ms; npm test → 214 passed" }
```

`evidence` is required and shown to you on completion, so "done" means a check
that was actually run, not a claim.

| Command | What it does |
| --- | --- |
| `/goal <objective>` | Start (or replace) the session's goal and begin working |
| `/goal` `/goal status` | Show the objective, `runs/50`, pause reason, and recorded evidence |
| `/goal pause` | Stop continuing (the goal stays for later) |
| `/goal resume` | Continue a paused goal now |
| `/goal clear` | Discard the goal |

### How the loop stays honest

Continuing is automatic, but it is not unconditional:

- **Three text-only continuations → pause.** Each automatically started run that
  makes no tool call increments a stall counter; three in a row pause the goal
  (opencode's `MAX_STALLS`). A run that uses a tool resets the counter. The check
  covers the whole run, not its last turn — every run ends with a text-only turn,
  so a last-turn test would pause on every continuation. A user-started run that
  answers in text is not held against the goal.
- **50 continuations → pause.** The round budget matches opencode's
  `MAX_ROUNDS`; `/goal resume` counts the resume round as 1/50, so 49 more
  automatic rounds follow.
- **Interrupt or provider error → pause.** Escape and failed runs are not
  progress.
- **Queued user input → hold.** If you have already typed something, the
  continuation stays out of the way until that input has been handled.
- **Background work → hold.** If a shell or subagent started by this session is
  still running, the goal does not inject another continuation; it resumes when
  the work reports back. There is no wall-clock pause (the 30-minute timer was
  removed): a subagent's own timeout and a shell's `background_run` lifetime are
  the bounds. This uses the shared background-work registry in
  `background-terminal` and `subagent`; with neither loaded the goal behaves as
  before.
- **`/goal pause`, `/goal clear`, or `goal_done` → stop.** The extension never
  continues a goal that is not active.

### Scope and lifetime

One goal per session (a new `/goal` replaces the previous one). The state is
written to the session transcript, so resuming the session restores the
objective, its continuation count, stall counter, pause reason, and any recorded
evidence — and `/tree` navigation follows the branch you land on. A goal that was
active when the Pi process exited is restored as paused (opencode's restart
rule), so `/goal resume` is an explicit decision. A paused goal keeps `goal_done`
available so work completed in user-driven turns can still be recorded.

Use it for work with a durable objective and a checkable finish line. For a
one-off edit or a question, a normal prompt is still the right tool.

## Uninstall

Disable `goal` in `pi config`, or remove the whole package with
`pi remove git:github.com/ByteTrue/pi-extensions-collection`.

Nothing else to clean up: it writes no config, and the session entries it left
behind are inert without the extension.

## How it works

`goal.ts` is the entire runtime — one file, zero imports (the type-only
import disappears at load; tool parameters are hand-written JSON Schema):

```text
goal.ts        command + tool + event hooks + default-export entry
goal.test.ts   CI-only: the full test suite (never installed)
package.json      private, never published — exists only so workspace CI runs tests
```

| Surface | Detail |
| --- | --- |
| `/goal` command | Parses `status`/`pause`/`resume`/`clear` as control words; anything else is the objective |
| `goal_done` tool | Registered but inactive until a goal is unfinished (active or paused); requires `summary` + `evidence` |
| `before_agent_start` | Adds the objective as a `<goal>` system section while the goal is unfinished (active or paused) — inside the cached prefix, and it survives compaction |
| `agent_before_settle` | The loop: while active, appends one hidden continuation message and returns `continue: true` |
| `agent_start` / `tool_call` | Count whether the current segment did real work |
| `session_start` / `session_tree` | Restore the goal from the transcript branch |
| `agent_settled` | Releases the print/json-mode command handler once the run is over |
| footer status | `goal:active(N/50)` / `goal:paused` |

Implementing the loop at `agent_before_settle` (rather than with timers, idle
polling, or a `bash`-style tool) is what makes it exact: Pi calls it at the one
point where no automatic retry, compaction, or queued work remains, and its
documented contract is "append entries, request one more model request."

In print and json modes (`pi -p "/goal …"`), the command handler holds the
session open until the run settles; otherwise the process would exit mid-loop.
