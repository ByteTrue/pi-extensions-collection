# Proposal

## Why

The goal extension should remain a small autonomous-continuation loop, but each hidden continuation currently repeats an objective that is already retained in the system prompt, and the completion guidance does not explicitly require a clause-by-clause audit against current evidence. The persisted record also carries an unused timestamp, adding state without improving continuation behavior.

## What Changes

- Strengthen completion guidance so the agent checks every part of the objective against the current worktree, tool results, or external state before calling `goal_done`; plans, intentions, and memory alone are not evidence.
- Keep the objective in the existing system-prompt section and stop duplicating it in every hidden continuation message.
- Remove the unused `updatedAt` field and its writes while continuing to restore older session entries that contain it.
- Document the existing limitation that a long-lived background process can hold a goal indefinitely; do not change background-work behavior in this change.
- Preserve the command surface, 50-round budget, three-stall guard, pause/resume/clear controls, persistence and branch restore, and print/json support.

## Capabilities

### New Capabilities

- `goal-continuation`: Retain one user-supplied objective as durable model context, automatically continue active work with evidence-focused guidance, and stop on an evidence-backed `goal_done` or the existing safety controls.

### Modified Capabilities

None; this repository has no existing OpenSpec capability specs.

## Impact

- Runtime and exported test helpers: `goal/goal.ts`.
- Behavioral coverage and fixtures: `goal/goal.test.ts`.
- User-facing behavior and known limitations: `goal/README.md`.
- Older persisted goal entries remain readable; their extra `updatedAt` data is ignored.
- No new dependencies, tools, commands, judge model, token accounting, timers, or background-work policy changes.
