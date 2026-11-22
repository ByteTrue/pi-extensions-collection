# goal-continuation Specification

## Purpose

Keep one user-defined objective visible to the agent across automatic continuations, while requiring concrete completion evidence and avoiding repeated objective content in the transcript.

## Requirements

### Requirement: Durable objective context
The system SHALL keep an unfinished goal's objective in model-visible system context. Automatic continuation messages SHALL provide next-step guidance without duplicating the objective text.

#### Scenario: Active goal continues without repeated objective
- **WHEN** an active goal reaches a healthy settlement and automatic continuation is allowed
- **THEN** the objective remains in system context for the next run
- **AND** the hidden continuation contains next-step guidance but not another copy of the objective text

### Requirement: Completion audit guidance
Before completion, the system SHALL direct the agent to audit every part of the objective against current worktree, tool results, or external state. Plans, intentions, and memory alone SHALL NOT qualify as evidence.

#### Scenario: Objective has multiple expected outcomes
- **WHEN** the agent receives active-goal and continuation guidance for an objective with multiple expected outcomes
- **THEN** the guidance requires checking each expected outcome against current concrete evidence before calling `goal_done`
- **AND** the guidance rejects plans, intentions, and memory as substitutes for those checks

### Requirement: Evidence-backed completion
The system SHALL require a nonempty summary and evidence when the agent marks a goal complete, and SHALL stop automatic continuation after successful completion.

#### Scenario: Agent supplies completion evidence
- **WHEN** the agent calls `goal_done` with a nonempty summary and evidence for an unfinished goal
- **THEN** the system records the completion and stops automatic continuation

#### Scenario: Completion evidence is missing
- **WHEN** the agent calls `goal_done` without both a nonempty summary and evidence
- **THEN** the system rejects the completion request and leaves the goal unfinished
