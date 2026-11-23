# Tasks

## 1. Nonessential oversized-event handling

- [x] 1.1 Add run-lifecycle regressions for oversized tool_execution_update, tool_execution_end, toolResult message_end, and turn_end events followed by a valid final report; verify the cases reproduce the unwanted abort or failed status before the fix.
- [x] 1.2 Extend the bounded oversized-line classifier in subagent/src/index.ts to skip those supported nonessential events without streamError or abort while preserving assistant recovery and unknown-type failures; verify the new lifecycle cases succeed.
- [x] 1.3 Add fragmented-chunk, next-line, CRLF, and EOF-without-newline regressions for skipped events and adjust drain handling only if those tests expose framing errors; verify no discarded suffix corrupts the following final assistant event.

## 2. Tool progress completion

- [x] 2.1 Add oversized tool_execution_end regressions for both isError values, then extract bounded toolCallId/isError metadata and update the matching ToolTrace through the existing terminal-state logic; verify matching traces settle and the runs still deliver their final reports.

## 3. Integration verification

- [x] 3.1 Run npm run test --workspace subagent and npm run typecheck --workspace subagent, then openspec validate fix-subagent-oversized-json-events --strict; verify all commands pass and existing recovery, failure, cancellation, and timeout tests remain green.
