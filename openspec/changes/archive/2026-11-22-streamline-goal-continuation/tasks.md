# Tasks

## 1. Continuation and completion guidance

- [x] 1.1 Update the active-goal section and `CONTINUE_MESSAGE` in `goal/goal.ts` to require a clause-by-clause audit against current worktree, tool results, or external state, explicitly rejecting plans, intentions, and memory as evidence; add focused assertions in `goal/goal.test.ts` and verify them with `npm --workspace goal test`.
- [x] 1.2 Make each hidden continuation's content exactly `CONTINUE_MESSAGE`, update the continuation test to reject repeated objective text, and add lifecycle coverage showing `before_agent_start` reapplies the escaped objective section across continuation, retry, and compaction runs; verify with `npm --workspace goal test`.
- [x] 1.3 Update `goal/README.md` to remove the claim that every continuation restates the objective and to describe the stronger completion audit; verify the documentation matches the prompt behavior covered by the tests in 1.1 and 1.2.

## 2. State cleanup and background limitation

- [x] 2.1 Remove `updatedAt` from `GoalRecord`, record normalization, all state writes, and ordinary test fixtures; add a raw legacy-entry test proving restore preserves goal behavior while ignoring `updatedAt`, then verify with `npm --workspace goal test` and `npm --workspace goal run typecheck`.
- [x] 2.2 Document in `goal/README.md` that a dev server or other permanent process reported as running background work holds the goal until it exits, without changing `runningBackgroundWork` or `settleDecision`; verify the note against the existing background-hold tests with `npm --workspace goal test`.

## 3. Integration verification

- [x] 3.1 Run `npm test` and `npm run typecheck` from the repository root, confirming the existing command controls, 50-round and three-stall guards, persistence and branch restore, background holds, and print/json tests remain green.
- [x] 3.2 Run `openspec validate streamline-goal-continuation --strict` and confirm the proposal, capability delta, design, and completed task checklist remain consistent with the implemented behavior.
