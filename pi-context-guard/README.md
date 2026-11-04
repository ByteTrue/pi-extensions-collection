# pi-context-guard

Context rules for Pi. No configuration, no second model, no database, no background
work: six event hooks, three context tools (`ctx_reduce`, `ctx_search`, `ctx_expand`),
and `/context-guard`.

1. **Compact at 400k, not at "window − reserve".** A model whose context window
   is larger than 400k tokens compacts once the context passes 400k. Models with
   a smaller window are not touched — Pi's default compaction policy applies there.
   Compaction itself stays Pi's own: synchronous, on the current model.
2. **The system prompt names the session file.** The session file keeps every
   message even after compaction replaces them in the model's view, so a detail
   a summary dropped stays reachable by searching the JSONL instead of being
   re-derived or guessed.
3. **Deterministic pruning of stale tool results.** Old, oversized tool results
   are replaced by a short placeholder. The original never leaves the session
   file, and recovery tools get it back.

The pointer lives in the system prompt rather than the compaction instructions:
a summary is only as good as whatever produced it. Pi uses another extension's
summary verbatim when one handles `session_before_compact`, and custom
instructions are never passed to it. The system prompt is unaffected by who
compacts, or whether a compaction happened at all.

## Pruning

Two rules, both deterministic — nothing is summarised, generated, or embedded:

- **Exact duplicates.** The same tool called with canonically identical arguments
  (JSON keys sorted, `undefined` properties ignored) keeps only its newest result,
  provided the older duplicate is at least 4000 characters long (short outputs are
  never worth a cache bust).
- **Stale large results.** A result at least 4000 characters long is pruned once
  it is older than **6 user turns** *or* older than **40 later tool results**.
  The second measure matters because long sessions are often a few user turns
  around hundreds of tool calls, where a turn-only window would protect nearly
  everything. Both windows keep the newest work whole.

Only `toolResult` content is replaced. User and assistant messages are never
touched, and a result is replaced rather than removed, so tool call/result
pairing and every other message's position survive.

The placeholder is `[pruned <toolCallId>]` and nothing else. It is a pure
function of the id — a placeholder derived from the content would differ between
passes and bust the prompt-cache prefix on every turn.

**New prunes are admitted only at the start of a user turn.** Mid tool-loop the
model is working against a prefix it already has; changing it then costs a cache
bust per tool call instead of one per turn. Existing placeholders are replayed
verbatim on every pass, so once something is pruned it stays byte-identical.

State is in memory only. On resume or `/reload`, earlier `ctx_reduce` calls and
stale/duplicate results are re-derived from the session entries, so pruned results
stay pruned across restarts without any database.

## Tools

- **`ctx_reduce({ ids? })`** — queues active tool results for dropping at the
  start of the next user turn (keeping the current tool-loop prefix intact). Call
  with no `ids` to list the 15 largest unpruned tool results currently in context.
- **`ctx_expand({ id, offset? })`** — returns the original content of a pruned tool
  result (by its tool call id) or of any earlier session entry (by entry id, as
  returned by `ctx_search`). Returns at most 60k characters per call and says which
  offset to continue from, so expanding one huge output does not undo the prune.
- **`ctx_search({ query, limit? })`** — searches the session's full history,
  including messages compaction or pruning removed from the model's view. Scores
  exact phrases, all query terms together, and **literal probes** individually:
  paths, `camelCase`/`snake_case` identifiers, `/slash-commands`, error codes and
  quoted spans are extracted and matched on their own, so "why did the edit to
  src/config.ts fail" still finds the message that only contains `src/config.ts`.
  Tool call ids and entry ids are searchable too, which is what makes a
  `[pruned <id>]` placeholder a working pointer.

All three read in-memory `sessionManager.getEntries()` first and fall back to the
session JSONL on disk. There is no index to build or keep in sync.

## Reminders that make the tools actually get used

A tool nobody is told about never gets called. Reminders are written at creation
time and replayed byte-identical afterwards:

- **Channel 1 (nudge).** When a tool result finishes and the reclaimable share of
  the tail crosses a band — `U/T ≥ 0.2` gentle, `0.4` firm, `0.6` urgent, with
  `T ≥ 60k` and `U ≥ 25k` floors — a `<system-reminder>` is appended to that
  result naming the oldest reclaimable ids. Bands only announce on the upward
  crossing; same-band re-fires need the reclaimable mass to regrow past
  `max(25k, 8% of T)` and five user turns; a band drop is observed silently.
- **Grace after a reduce.** Once the agent calls `ctx_reduce`, reminders hold
  through the rest of the current tool loop and after the queued drops land at the
  next user turn, until the reclaimable mass regrows past the refire threshold or
  the band escalates above its pre-reduce level. Nagging right after compliance is
  the fastest way to make an agent ignore every future reminder.
- **No search hint.** Magic Context appends a `<ctx-search-hint>` to new user
  messages when an auto-search scores. Here that would rewrite an earlier
  message in the model's view on every turn it fires, because context edits are
  not persisted and the next turn rebuilds from the session file — one full
  prefix bust per hint. The agent already calls `ctx_search` unprompted when it
  needs history, so the hint's value does not pay for its cost.

Protected from pruning and excluded from the reclaimable mass: the newest three
`ctx_reduce` results and the newest `todowrite` result. The agent has to keep
seeing its own plan and its own receipts.

## Dry run

```sh
PI_CONTEXT_GUARD_DRY_RUN=1 pi
```

Counts what would be pruned and changes no message bytes. `/context-guard` shows
the last pass: how many results were pruned, how many placeholders replayed,
roughly how many characters were reclaimed, and how many more are eligible at
the next user turn.

## Interaction with other extensions

Pruned sets, queued drops and nudge grace are kept per session (`sessionId`), so
concurrent sessions in one process — subagents, `/fork`, `/switch` — never bleed
state into one another.

Only one extension should rewrite the conversation or register `ctx_reduce` /
`ctx_expand` / `ctx_search`. Do not load `pi-context-guard` alongside Magic Context.
If `context` sees structural markers from Magic Context (`§N§`, `[dropped §`,
`<session-history>`), pi-lcm, or pi-condense already on the transcript, this
extension steps aside for that session instead of undoing or re-rewriting their
placeholders. Pi's own compaction is fine and expected — this extension does not
hook `session_before_compact`.

## Install

Run the repo's installer and tick `pi-context-guard` in the menu — the command is in
[Install](../#install). It registers `ctx_reduce` / `ctx_search` / `ctx_expand`, so
the installer skips it when `@cortexkit/pi-magic-context` is installed: Pi refuses to
start when two extensions register one tool name. Remove one of the two first.

Restart or reload Pi afterwards.
