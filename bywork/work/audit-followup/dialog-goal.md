# R4 / R5: goal startup and question identities

Implemented after approval of the repository-audit recommendations.

`ask-user/ask-user.ts` validates the entire question batch before opening a dialog. Trimmed duplicate labels, overlapping rendered rows, and generated Other/Back/Done rows (including checklist variants) return an actionable question/option error. Descriptions cannot disambiguate duplicate labels. The existing editor and late-answer cancellation behavior are retained.

`goal/goal.ts` checks the selected model and configured or resolvable provider authentication before an idle print/JSON kickoff or resume. Detectable failures pause the stored goal and propagate an error. Settlement waiters register before dispatch and are removed on failure. Keyless/virtual providers remain valid, busy sessions still queue follow-ups, and no wall-clock timeout was added.

Focused checks: ask-user 62 tests passed; goal 69 tests passed; both workspace typechecks and scoped whitespace checks passed. The parent integration report records the final full-repository checks.

Remaining host limits:

- `ctx.ui.editor()` has no cancellation/close API. An already-open TUI editor still needs Esc; late answers are discarded.
- `pi.sendUserMessage()` has no awaitable dispatch outcome. Consumed input or asynchronous startup failure after preflight can prevent `agent_settled`, leaving a headless command pending.
- Host-owned authentication resolution can itself remain pending. A global goal timeout would also stop valid long-running work.

Live TUI/RPC and real-provider sessions were not exercised. No dependencies or dispatch API replacements were introduced.
