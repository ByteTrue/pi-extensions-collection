# Spec Delta

## Purpose

Defines predictable `ask_user` cancellation behavior so users can reconsider an Other choice without losing the current question or their selections.

## ADDED Requirements

### Requirement: Other input cancellation returns to the current question
When a user cancels freeform input opened through Other, the system SHALL return to that question's options instead of dismissing the `ask_user` interaction.

#### Scenario: Reconsider Other in a single-select question
- **WHEN** the user selects Other and then cancels the freeform input in TUI or RPC mode
- **THEN** the system displays the same question's option list without submitting an answer
- **AND** the user can subsequently choose any built-in option or reopen Other

### Requirement: Multi-select state survives Other input cancellation
The system SHALL preserve the current question's picked options and saved custom-answer draft when cancelled Other input returns to a multi-select checklist.

#### Scenario: Cancel Other after making selections
- **WHEN** the user has picked options or saved a custom-answer draft and cancels a subsequently opened Other input
- **THEN** the system redisplays the checklist with those picks and that draft unchanged
- **AND** no answer is submitted until the user explicitly confirms or cancels the checklist

### Requirement: Existing dismissal boundaries remain intact
The system SHALL preserve dismissal behavior for option lists and purely open questions, and SHALL treat tool abortion as termination rather than a request to reopen a dialog.

#### Scenario: Cancel an option list
- **WHEN** the user cancels the single-select option list or multi-select checklist itself
- **THEN** the system dismisses the interaction using the existing unanswered result

#### Scenario: Cancel a purely open question
- **WHEN** the user cancels freeform input for a question that has no options
- **THEN** the system dismisses the interaction using the existing unanswered result

#### Scenario: Abort while Other input is open
- **WHEN** the tool's abort signal fires while Other input is open
- **THEN** the system terminates the interaction without reopening the option list or checklist
