# Proposal

## Why

Choosing **Other** in an `ask_user` option question currently commits the user to the freeform path: cancelling that input dismisses the entire tool call instead of letting them return to the choices. This makes an exploratory click unnecessarily destructive in both TUI and RPC hosts such as Paseo.

## What Changes

- Cancelling the freeform input opened from **Other** returns to the current question's option list for single-select questions.
- Cancelling that input returns to the checklist for multi-select questions, preserving existing selections and custom-answer drafts.
- Cancelling the option list itself, dismissing a purely open question, submitting an empty answer, and aborting the tool retain their current behavior.

## Capabilities

### New Capabilities
- `ask-user-dialogs`: Interaction behavior for answering and dismissing `ask_user` option, multi-select, and freeform dialogs.

### Modified Capabilities

## Impact

Affected: `ask-user/ask-user.ts`, focused regression tests in `ask-user/ask-user.test.ts`, and user-facing behavior documentation in `ask-user/README.md`. No tool schema, result format, dependency, or Paseo-specific API changes.
