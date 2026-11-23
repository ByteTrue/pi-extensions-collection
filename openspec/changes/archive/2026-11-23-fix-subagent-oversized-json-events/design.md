# Design

## Context

subagent/src/index.ts already bounds each NDJSON line at 1 MiB and has a droppingOversizedLine state that drains discarded bytes through the next newline. Its oversized-line classifier currently recovers agent_end and final assistant message_end events, but treats oversized tool and turn events as fatal even though applyEvent does not consume their large payloads. Existing close settlement and session recovery already distinguish confirmed completion from genuine execution failures.

## Goals / Non-Goals

**Goals:**
- Reuse the existing bounded prefix classifier and drain state for all supported nonessential oversized events.
- Keep stream framing, final-result recovery, and completion evidence intact across chunk and EOF boundaries.
- Settle tool progress from bounded tool_execution_end metadata when available.

**Non-Goals:**
- Do not raise the line limit, parse oversized payloads, or retain partial oversized content in RunState.
- Do not change public APIs, result recovery rules, timeout/cancellation behavior, or handling of unsupported oversized event types.

## Decisions

### Keep the 1 MiB limit and classify before discarding
Use jsonEventTypePrefix and the existing assistant/toolResult role-prefix convention to classify an oversized line. Allow agent_end, turn_end, tool_execution_update, tool_execution_end, and message_end only when its role is toolResult. Return without setting streamError or calling abort for these nonessential events. Keep the existing fatal path for unknown types and the recovery path for assistant message_end.

Raising MAX_LINE_BUFFER would only postpone the failure and increase peak memory. Parsing a discarded prefix as JSON is impossible because it is intentionally incomplete.

### Preserve drain-until-newline as the sole discard mechanism
When processStdout crosses the limit, pass only the bounded prefix to the classifier, clear buf, and keep droppingOversizedLine set until a newline arrives. At EOF, discard any unfinished oversized line instead of flushing it as a new event. This prevents the tail of one event from being combined with subsequent bytes and needs no second buffering algorithm.

### Recover tool completion from bounded metadata
For an oversized tool_execution_end, extract toolCallId and the boolean isError only from the retained prefix using a small dedicated helper, then update the matching ToolTrace with the same terminal-state logic as applyEvent. Missing or ambiguous metadata leaves progress unchanged but does not fail the run; payload text must never become a fabricated final answer or error.

A full JSON parser, streaming JSON dependency, or unbounded suffix buffer would add complexity without improving final-result correctness.

### Preserve lifecycle and failure semantics
Oversized nonessential events must not clear a recovered final report or synthesize agent completion. Where a normal-sized tool event currently resets stale completion evidence after retry activity, the oversized equivalent should follow the same transition. Existing assistant errors, missing recovery, nonzero exits without completion evidence, cancellation, timeout, and pause continue to take precedence at close.

## Risks / Trade-offs

- [Tool metadata appears after the bounded prefix] → The run remains successful, but that tool trace can remain running; tests cover the normal Pi field order and avoid speculative payload extraction.
- [Prefix regular expressions misclassify a nonstandard event] → Keep a strict allowlist and retain the fatal unknown-type path; do not broaden classification to arbitrary message_end roles.
- [Chunk boundaries split multibyte UTF-8 or CR/LF] → Continue using StringDecoder and the existing CR stripping logic, with fragmented-write regression tests.

## Migration Plan

This is a backward-compatible runtime bug fix. No data or settings migration is needed; rollback restores the previous oversized-event behavior.
