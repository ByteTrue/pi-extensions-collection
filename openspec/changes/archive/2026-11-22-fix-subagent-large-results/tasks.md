# Tasks

## 1. Bounded transport and recovery

- [x] 1.1 Replace oversized-line abortion with bounded type-aware handling in subagent/src/index.ts; add run-lifecycle cases for an oversized agent_end, an unsupported oversized event, and exact-boundary versus boundary-plus-one events, then verify the focused tests pass.
- [x] 1.2 Recover only the latest persisted final assistant stop from the child session log when message_end is oversized; add tests for a report over 1 MiB, absent/mismatched/unreadable recovery data, and no intermediate-event duplication, then verify the focused tests pass.
- [x] 1.3 Replace whole-session recovery reads with fixed-size bounded scanning that retains only necessary candidates; add an oversized final assistant message_end test without a trailing newline and explicit recovery-failure coverage, then verify focused tests pass.

## 2. Lossless delivery and truthful settlement

- [x] 2.1 Deliver large successful final text through unique owner-only UTF-8 result files and small text inline; add tests for Unicode fidelity, complete file contents, readable absolute paths, normal small output, and result-file write failure, then verify the focused tests pass.
- [x] 2.2 Track agent_end/final-stop evidence across retries and preserve close-time pause/cancel/error precedence; add tests for post-completion nonzero cleanup, ordinary nonzero execution, authentication failure, final assistant error, and zero-exit delivery failure, then verify lifecycle and existing cancellation/timeout tests pass.
- [x] 2.3 Add or update a focused completion-notification test proving a large result returns its file path without the 50,000-character summary fallback dropping it, and verify that test passes.
- [x] 2.4 Update subagent/README.md with oversized agent_end handling, session recovery, result-file location/lifecycle, and truthful status semantics; verify the documentation no longer claims that every event over 1,048,576 characters must abort.

## 3. Integration verification

- [x] 3.1 Run the complete subagent test suite with npm test --prefix subagent and confirm all tests pass after the revised recovery work.
- [x] 3.2 Run npm run typecheck --prefix subagent and openspec validate fix-subagent-large-results --strict; confirm both succeed.
- [x] 3.3 Review the final diff and repository status to confirm only the planned subagent and OpenSpec files changed, with no BySpace or archived standalone checkout edits.
- [x] 3.4 Copy only the verified subagent source, tests, and README to C:/Users/byte/.pi/agent/git/github.com/ByteTrue/pi-extensions-collection without changing its package-lock.json; run its complete subagent tests and typecheck, compare synchronized files, and confirm the final scope in both checkouts.
