# Design

## Context

See proposal.md - Why. `goal/goal.ts` already rebuilds the `goal` system-prompt section on every `before_agent_start`, including continuation, retry, and compaction runs. The hidden continuation can therefore use the shared `CONTINUE_MESSAGE` alone. Session restore reconstructs a fresh `GoalRecord` from known fields, so legacy extra fields can be ignored without a data migration.

## Goals / Non-Goals

**Goals:**
- Keep one authoritative copy of the objective in model context and shorten hidden continuations.
- Improve the agent's completion audit through existing prompt surfaces only.
- Simplify persisted goal state without invalidating existing sessions.

**Non-Goals:**
- Do not add independent completion judging or claim that evidence text is verified by the extension.
- Do not change background-work detection, hold behavior, continuation limits, command controls, or headless dispatch handling.
- Do not introduce a migration tool, timer, dependency, or new public API.

## Decisions

### Use the system section as the only objective copy

Keep `goalSection(goal)` unchanged as the owner of the escaped objective. At `agent_before_settle`, append a hidden custom message whose content is exactly `CONTINUE_MESSAGE`, rather than prefixing `objectiveBlock(goal.objective)`.

This uses the existing per-run system-prompt injection and avoids up to 4,000 repeated objective characters per continuation. Keeping the duplicate would only add transcript and prompt bulk; adding a reference or placeholder format would add indirection without value.

### Strengthen existing completion guidance, not the state machine

Add the clause-by-clause audit requirement to the active `goalSection` guidance and `CONTINUE_MESSAGE`: check current worktree contents, tool results, or external state, and do not substitute plans, intentions, or memory for evidence. Keep `goal_done` validation limited to nonempty `summary` and `evidence`.

The same execution agent remains responsible for checking and reporting. A reviewer model, judge verdicts, or tool-output validation would create a different product and are rejected for this change.

### Drop `updatedAt` through normal record normalization

Remove `updatedAt` from `GoalRecord`, `toGoalRecord`, every state write, and test fixtures. `toGoalRecord` already copies recognized fields into a new object, so older entries containing `updatedAt` require no special branch: the field is ignored on read and disappears on the next write.

A versioned migration is unnecessary because no behavior reads this field and the previous reader already tolerates a missing value by defaulting it to zero.

### Document, rather than redefine, permanent background work

Add a README note that any running shell reported through the shared background-work registry—including a dev server or other permanent process—holds the goal indefinitely until that process exits. No continuation prompt can override this because the hold occurs before continuation injection.

Do not infer process type from labels or add a watchdog. The current registry exposes only kind, id, and label, not whether work is finite, so reliable service classification needs a separately designed contract.

## Risks / Trade-offs

- [A shorter continuation could expose a host-context regression after compaction] → Test that `before_agent_start` reapplies the same objective section across continuation/retry/compaction lifecycle events and that the hidden message is exactly `CONTINUE_MESSAGE`.
- [Stronger audit wording still relies on agent self-report] → Retain required evidence and document that the extension does not independently verify it.
- [Removing an exported TypeScript field could affect an unseen consumer] → Repository search shows only `goal/goal.test.ts` uses `GoalRecord`; keep runtime session compatibility and cover a legacy entry containing `updatedAt`.
- [Documenting indefinite background holds exposes rather than fixes the limitation] → Keep the scope explicit; changing process semantics without lifecycle metadata risks prematurely continuing past real work.

## Migration Plan

1. Read existing goal entries normally, ignoring their legacy `updatedAt` field.
2. Persist subsequent goal transitions without `updatedAt`; do not rewrite unrelated history.
3. Roll back by restoring the previous extension code if needed. Older code defaults a missing `updatedAt` to zero, and no continuation decision depends on it.
