# Tasks

## 1. Other Cancellation Recovery

- [x] 1.1 In `ask-user/ask-user.ts`, make cancelled single-select Other input continue the current-question loop unless the abort signal fired; add TUI and RPC regression tests proving the options reappear and a built-in option can then be answered, plus an abort test proving no dialog reopens, and verify with `npm --workspace ask-user test`.
- [x] 1.2 Make cancelled multi-select Other input continue the checklist loop unless aborted; add regression tests proving picked options and saved custom drafts survive and that abort does not reopen the checklist, and verify with `npm --workspace ask-user test`.
- [x] 1.3 Document the Other cancellation behavior in `ask-user/README.md`, then run `npm --workspace ask-user test` and `npm --workspace ask-user typecheck` to verify the completed extension change.
