# Spec Delta

## ADDED Requirements

### Requirement: Oversized nonessential events are skipped safely
The system SHALL discard supported oversized tool-result, tool-progress, and turn-summary events without aborting or failing the run, and SHALL resume parsing only at the next complete NDJSON event.

#### Scenario: Oversized tool result occurs mid-run
- **WHEN** a tool_execution_update, tool_execution_end, or toolResult message_end exceeds 1,048,576 characters and a valid final assistant message follows
- **THEN** the child process is not aborted because of the oversized event
- **AND** the final report is delivered successfully

#### Scenario: Oversized turn summary surrounds completion
- **WHEN** a turn_end event exceeds 1,048,576 characters before or after the final assistant message
- **THEN** the event payload is discarded
- **AND** confirmed final completion and result delivery are preserved

#### Scenario: Oversized event spans chunks and has no trailing newline
- **WHEN** a supported oversized nonessential event is split across output chunks or ends at stream close without a newline
- **THEN** its remaining bytes are discarded without being prepended to another event
- **AND** any following complete event is processed normally

### Requirement: Oversized tool completion preserves bounded progress
The system SHALL update the matching tool trace to its terminal state when bounded metadata from an oversized tool_execution_end event identifies both the tool call and its outcome.

#### Scenario: Tool completion metadata is available
- **WHEN** an oversized tool_execution_end event identifies a running tool call and whether it failed
- **THEN** that tool trace becomes succeeded or failed accordingly
- **AND** the run continues without parsing or retaining the full tool result
