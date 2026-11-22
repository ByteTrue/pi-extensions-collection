# subagent-result-delivery Specification

## Purpose

Deliver final subagent reports completely through bounded streaming and parent notifications, while preserving truthful lifecycle and failure states.

## Requirements

### Requirement: Redundant aggregate events are bounded
The system SHALL handle oversized aggregate lifecycle events without retaining or parsing their full payloads, and SHALL NOT abort solely because redundant session history exceeds the streaming line limit.

#### Scenario: Oversized agent_end follows a small final report
- **WHEN** a successful final assistant message is followed by an agent_end event larger than 1,048,576 characters
- **THEN** the final report is delivered exactly once
- **AND** the run is not failed merely because agent_end contains accumulated session history

#### Scenario: Oversized event type is not safe to ignore
- **WHEN** an event exceeds the streaming line limit and cannot be identified as a supported recoverable or redundant type
- **THEN** the run fails with a clear event-size or event-type error

### Requirement: Oversized final reports are recovered
The system SHALL recover an oversized final assistant report from the child's persisted session record using bounded, fixed-size file reads, retain only necessary recovery candidates rather than the entire log, and SHALL confirm it is the latest successful final message before treating it as complete.

#### Scenario: Report exceeds one MiB
- **WHEN** the final assistant message_end exceeds 1,048,576 characters and its persisted final stopReason is stop
- **THEN** the parent receives the complete report or a readable path to it
- **AND** no intermediate assistant or tool output is appended to that report

#### Scenario: Oversized final event has no trailing newline
- **WHEN** the final assistant message_end exceeds 1,048,576 characters and the stream closes without a trailing newline
- **THEN** bounded recovery still delivers the complete final report exactly once
- **AND** stream-close flushing does not discard or truncate the event

#### Scenario: Session history is larger than the final report
- **WHEN** recovery scans a session log containing large earlier history entries
- **THEN** the reader uses fixed-size chunks and does not load or split the entire session log
- **AND** failure to recover the complete required candidate is reported explicitly

#### Scenario: Streaming boundary is exact
- **WHEN** final report events are emitted at the exact streaming character boundary and one character above it
- **THEN** both reports are delivered completely
- **AND** the above-boundary report uses recovery rather than silent truncation

#### Scenario: Recovery cannot confirm final delivery
- **WHEN** the oversized final event has no readable matching persisted assistant message with a successful final stop
- **THEN** the run fails with an explicit recovery error
- **AND** stale or partial output is not reported as a successful final result

### Requirement: Result size selects a lossless delivery form
The system SHALL return small successful results inline and write large successful results verbatim to unique readable UTF-8 files, returning an absolute path and read instruction instead of a large inline body.

#### Scenario: Normal small result
- **WHEN** a successful final report is below the inline result limit
- **THEN** its exact text is returned inline without a result-file indirection

#### Scenario: Large Unicode result
- **WHEN** a successful report exceeds the inline limit and contains multibyte and astral Unicode characters
- **THEN** reading the returned result file as UTF-8 yields exactly the original report
- **AND** the parent notification contains the readable path without repeating or omitting the report through a batch-size fallback

### Requirement: Close settlement reflects completion evidence
The system SHALL settle runs at process close and SHALL preserve success after a later nonzero cleanup exit only when final agent completion, a successful final stop, and complete result delivery have all been established.

#### Scenario: Cleanup exits nonzero after completed delivery
- **WHEN** agent_end and a final stopReason of stop were observed and the complete result was delivered before a nonzero close
- **THEN** the delivered result remains successful

#### Scenario: Ordinary execution exits nonzero
- **WHEN** a child exits nonzero without the required completion evidence
- **THEN** the run fails even if some assistant output was observed

#### Scenario: Automatic retry follows agent_end
- **WHEN** further run activity follows an agent_end lifecycle marker
- **THEN** earlier completion evidence is reset until the retry completes

#### Scenario: Delivery fails on a zero exit
- **WHEN** result recovery or result-file writing fails even though the child exits zero
- **THEN** the run fails with the specific delivery error

### Requirement: Real failures retain precedence
The system SHALL preserve cancellation, timeout, pause, assistant errors, authentication failures, and other genuine execution failures regardless of partial output.

#### Scenario: Authentication failure after partial output
- **WHEN** a child reports an authentication failure and exits nonzero without confirmed final completion
- **THEN** the run remains failed with the authentication error visible

#### Scenario: Final assistant error
- **WHEN** the final assistant message has an error or aborted stop reason
- **THEN** later lifecycle or cleanup events do not convert the run to success

#### Scenario: Cancellation or pause races with close
- **WHEN** cancellation, timeout, or pause has already been requested
- **THEN** close handling preserves the corresponding cancelled or paused outcome instead of applying success-only completion logic
