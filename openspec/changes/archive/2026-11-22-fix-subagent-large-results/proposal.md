# Proposal

## Why

Pi's JSON `agent_end` event embeds the entire accumulated session, so ordinary tool-heavy runs can emit a line larger than the extension's 1 MiB guard even when the final report is small. The guard currently aborts the child, and close handling can then report an already completed model run as failed; separately, reports over the notification batch limit can lose their inline body.

## What Changes

- Handle redundant oversized `agent_end` payloads without aborting, while preserving bounded streaming memory.
- Recover an oversized final assistant report from the child's session log with bounded file reads instead of truncating it or parsing an unbounded event.
- Deliver small results inline and large results through a unique, readable UTF-8 result file whose path is returned to the parent; never substitute accumulated intermediate events for the final report.
- Settle success or failure at process close using lifecycle, final-message, and delivery evidence. Preserve real authentication, cancellation, timeout, pause, assistant-error, and ordinary nonzero-exit failures.
- Add regression coverage for oversized reports with and without a trailing newline, exact boundaries, Unicode, small results, cleanup-exit races, delivery failures, and real execution failures; update the subagent README.

## Capabilities

### New Capabilities

- `subagent-result-delivery`: Complete, bounded, and truthful delivery of final subagent results from Pi JSON streaming to the parent agent.

### Modified Capabilities

None.

## Impact

- Affects `subagent/src/index.ts`, focused subagent lifecycle/notification tests, and `subagent/README.md`.
- Uses existing Node.js filesystem APIs; adds no runtime dependency and requires no BySpace change.
- Synchronizes the verified extension fix to the actual runtime checkout at C:/Users/byte/.pi/agent/git/github.com/ByteTrue/pi-extensions-collection while preserving its unrelated package-lock.json changes.
- Leaves unrelated extensions, the archived standalone checkout, and BySpace untouched.
