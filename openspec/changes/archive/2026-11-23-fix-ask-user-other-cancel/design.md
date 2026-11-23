# Design

## Context

The single-select flow already runs inside the per-question loop in `ask-user/ask-user.ts`, while the multi-select checklist has its own loop. Both Other branches currently convert `collectFreeform()` returning `undefined` into dismissal. That value represents either user cancellation or an aborted tool, so the fix must distinguish those cases without adding a host-specific dialog.

## Goals / Non-Goals

**Goals:**
- Reuse the existing loops to redisplay the current question after cancelled Other input.
- Preserve all multi-select draft state and existing behavior outside the Other path.
- Keep TUI and RPC behavior identical.

**Non-Goals:**
- No custom UI component, Paseo patch, tool-schema change, or new navigation control.
- No change to purely open questions, empty submissions, or cancellation of an option list itself.

## Decisions

1. **Continue the existing loop on user cancellation.** In the single-select Other branch, a cancelled input continues the outer question loop; in the multi-select Other branch, it continues the checklist loop. This reuses current rendering and state handling instead of introducing another outcome type or navigation abstraction. A nested dialog API was considered but is unnecessary and would not be portable across Pi hosts.
2. **Check the abort signal before continuing.** If `signal?.aborted` is true, retain the current dismissal/termination path; otherwise `undefined` means user cancellation and triggers redisplay. This prevents an aborted RPC call from reopening dialogs.
3. **Mutate custom-answer state only after a non-cancelled result.** The existing multi-select code already updates its draft after input returns, so cancellation naturally preserves prior picks and custom text.

## Risks / Trade-offs

- [Treating every `undefined` as Back could reopen UI after abort] → Guard both Other branches with the existing abort signal and add a regression test.
- [A cancelled input now intentionally keeps the interaction alive] → Direct cancellation of the option list or checklist remains the explicit way to dismiss an option question.

## Migration Plan

No data or configuration migration is needed. Ship the extension change with focused tests and a README behavior update; rollback is reverting those edits.
