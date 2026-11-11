# context-prune

Context rules for Pi. No configuration, no second model, no database, no background
work: six event hooks, three context tools (`ctx_reduce`, `ctx_search`, `ctx_expand`),
and `/context-prune`.

1. **The system prompt names the session file.** The session file keeps every
   message even after compaction replaces them in the model's view, so a detail
   a summary dropped stays reachable by searching the JSONL instead of being
   re-derived or guessed.
2. **Deterministic pruning of far-behind tool results.** Old outputs are replaced
   by a short placeholder once enough newer work follows them. The original never leaves the session
   file, and recovery tools get it back.

The 400k compaction rule for large-window models is a separate extension,
[`auto-compact`](../auto-compact/); load that too or not.

The pointer lives in the system prompt rather than the compaction instructions:
a summary is only as good as whatever produced it. Pi uses another extension's
summary verbatim when one handles `session_before_compact`, and custom
instructions are never passed to it. The system prompt is unaffected by who
compacts, or whether a compaction happened at all.

## Pruning

Two rules, both deterministic — nothing is summarised, generated, or embedded:

- **Exact duplicates.** The same tool called with canonically identical arguments
  (JSON keys sorted, `undefined` properties ignored) keeps only its newest result,
  provided the older duplicate holds at least 250 tokens.
- **Far-behind results.** An output is pruned once **three user turns** or **a
  quarter of the usable window** of newer content follow it, and it holds at
  least 250 tokens. A result's own payload, including later chunks of a
  multipart output, cannot age it.

The newest part of the conversation is protected by a token floor, derived the
way Magic Context derives it: `clamp(5% of the usable window, 16k, 64k)`, where
the usable window is `contextWindow - maxTokens` (200k when the host exposes no
model). The newest three results are protected regardless, and so are the newest
three `ctx_reduce` results and the newest `todowrite`. Token mass is UTF-8 bytes
× 0.25, so non-ASCII text is not undercounted.

Only `toolResult` content is replaced. User and assistant messages are never
touched, and a result is replaced rather than removed, so tool call/result
pairing and every other message's position survive.

The placeholder is `[pruned <toolCallId>]` and nothing else. It is a pure
function of the id — a placeholder derived from the content would differ between
passes and bust the prompt-cache prefix on every turn.

**New prunes are admitted only when the batch is worth a rewrite.** Mid tool-loop
nothing changes: the model is working against a prefix it already has. At the
start of a user turn (or after a settle) a batch is applied only when it
reclaims at least 2% of the usable window; smaller batches wait, for at most
three passes. Existing placeholders are replayed verbatim on every pass, so once
something is pruned it stays byte-identical.

State is in memory only. On resume or `/reload`, earlier `ctx_reduce` calls and
stale/duplicate results are re-derived from the session entries, so pruned results
stay pruned across restarts without any database.

## Tools

- **`ctx_reduce({ ids? })`** — queues active tool results for dropping at the next
  pass that can rewrite the prefix, and only when the batch is worth that rewrite.
  Call with no `ids` to list the 15 largest results outside the protected window;
  any addressable result, of any size, can be dropped by explicit id.
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
  result naming the 15 oldest reclaimable ids, so one `ctx_reduce` call can handle
  the batch without a preliminary listing. `T` is the provider-visible content
  without reasoning: text, tool arguments, tool outputs and user text, with this
  extension's own reminders stripped. `U` is every active tool output outside the
  protected window, of any size. Control-plane tools and outputs under 250 tokens
  are not listed as hints. Bands only announce on the upward crossing; same-band
  re-fires need the reclaimable mass to regrow past `max(25k, 8% of T)` and five
  user turns; a band drop is observed silently.
- **Grace after a reduce.** Once the agent calls `ctx_reduce`, reminders hold
  through the rest of the current tool loop and after the queued drops land at the
  next allowed pass, until the reclaimable mass regrows past the refire threshold
  or the band escalates above its pre-reduce level. Nagging right after compliance is
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
PI_CONTEXT_PRUNE_DRY_RUN=1 pi
```

Counts what would be pruned and changes no message bytes. `/context-prune` shows
the last pass: how many results were pruned, how many placeholders replayed,
roughly how many characters were reclaimed, and how many more are eligible at
the next user turn.

## Interaction with other extensions

Pruned sets, queued drops and nudge grace are kept per session (`sessionId`), so
concurrent sessions in one process — subagents, `/fork`, `/switch` — never bleed
state into one another.

Only one extension should rewrite the conversation or register `ctx_reduce` /
`ctx_expand` / `ctx_search`. Do not load `context-prune` alongside Magic Context.
The 400k compaction rule is unaffected by that choice: `auto-compact` registers
no tools.
If `context` sees structural markers from Magic Context (`§N§`, `[dropped §`,
`<session-history>`), pi-lcm, or pi-condense already on the transcript, this
extension steps aside for that session instead of undoing or re-rewriting their
placeholders. Pi's own compaction is fine and expected — this extension does not
hook `session_before_compact`.

## Install

Part of [pi-extensions-collection](../#install):

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Pi reads the root manifest and loads it.

This extension registers `ctx_reduce` / `ctx_search` / `ctx_expand`, the same tool
names `@cortexkit/pi-magic-context` provides. Pi refuses to start when two extensions
register one tool name, so load only one of them: run `pi config` and toggle
`context-prune` off. `auto-compact` is unaffected.

Restart or reload Pi afterwards.
