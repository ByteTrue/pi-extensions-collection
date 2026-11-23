# Proposal

## Why

Subagent runs can be killed or marked failed after completing useful work when a single NDJSON event exceeds the 1 MiB streaming line limit. Large tool results and aggregate lifecycle events are common during codemode searches, reviews, and long sessions, but their payloads are not needed for the parent's final report.

## What Changes

- Treat oversized tool-result, tool-progress, turn-summary, and aggregate session-history events as bounded, skippable stream data instead of fatal execution errors.
- Drain an oversized event through its terminating newline before resuming NDJSON parsing, so bytes from a discarded event cannot corrupt the next event.
- Preserve tool progress completion when an oversized tool_execution_end event contains enough bounded prefix metadata to identify its outcome.
- Continue to deliver a confirmed final assistant report successfully, while preserving existing recovery and failure behavior for oversized final reports and genuinely malformed or unsafe streams.
- Add regression coverage for mid-run oversized tool events and end-of-run oversized turn_end or agent_end events, including events split across chunks and without trailing newlines.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- subagent-result-delivery: Expand bounded oversized-event handling from aggregate agent_end and recoverable assistant reports to nonessential tool and turn events without changing truthful run completion or failure semantics.

## Impact

- Affects subagent/src/index.ts NDJSON stream handling, tool progress state, and close settlement.
- Affects focused lifecycle tests under subagent/src/, with subagent test and typecheck commands used for verification.
- No public subagent tool API, settings, dependency, or persisted-result format changes.
