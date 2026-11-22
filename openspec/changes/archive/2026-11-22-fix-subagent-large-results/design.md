# Design

## Context

See proposal.md — Why. The collection extension already uses bounded stdout/stderr tail buffers and StringDecoder, persists each child's session JSONL path, and sends completion through a 50,000-character notification formatter. Its tests use a fake Pi CLI and hermetic agent directories. No receiver-side protocol extension is available.

## Goals / Non-Goals

**Goals:**

- Keep stdout line handling bounded while distinguishing redundant history from a final report that must be recovered.
- Return either the exact final report or an exact, readable result-file path through the existing parent notification.
- Make close settlement depend on final lifecycle and delivery evidence, without weakening existing failure and retry behavior.

**Non-Goals:**

- Do not truncate reports, split JSON payloads into artificial fragments, raise the line limit, or concatenate intermediate events into a result.
- Do not change Pi's JSON producer, BySpace, the archived standalone repository, or the parent notification schema.
- Do not add a dependency or a general-purpose result storage service.

## Decisions

### Replace whole-line rejection with bounded type-aware line handling

Retain complete lines up to the existing 1,048,576-character limit. Once a line crosses that limit, identify only Pi's leading JSON `type` field from the bounded prefix:

- Discard an oversized `agent_end` payload and record its lifecycle marker; its accumulated `messages` are redundant.
- Discard an oversized assistant `message_end` payload and mark that final-message recovery is required.
- Fail explicitly for an unknown, malformed, or non-recoverable oversized event.

A line at exactly the limit is still parsed normally. New run or message activity after `agent_end` resets provisional completion evidence so automatic retries cannot inherit success.

**Alternatives rejected:** raising the limit still fails on larger sessions; removing the guard permits unbounded memory; regex-extracting report text from a giant JSON line is not a valid JSON parser.

### Recover only the latest persisted successful assistant message

At close, when recovery is pending, locate the current run's session JSONL using the existing session-log resolver. Read the log in fixed-size chunks and retain only the current candidate line and the latest assistant message needed for validation; never read or split the entire session into memory. Scan backward to the latest assistant message, require `stopReason: "stop"`, and pass that one message through the existing event application logic. Do not fall back to an earlier successful assistant message when the latest is a tool call, error, abort, or missing. Recovery must also work when the oversized stdout event has no trailing newline.

This uses Pi's own persisted final message rather than reconstructing JSON fragments. If the log cannot be found, read, matched, or confirmed within the bounded recovery strategy, delivery fails explicitly. Recovery occurs before successful result formatting and before close chooses its final status.

**Alternative rejected:** returning only the session-log path makes the parent reconstruct the report and does not provide a dedicated complete result file.

### Spill large final text to a private result file

Keep results below 40,000 characters inline. For larger final text, create a unique `pi-subagent-result-*` temporary directory, write `result.md` as exact UTF-8 with owner-only permissions, and return a short message containing its absolute path, character count, and an instruction to read the complete untruncated report.

The 40,000-character threshold leaves headroom below the existing 50,000-character notification batch limit for XML metadata and session-log notes. The extension does not delete the file after delivery; tests remove their own files after verifying them. Failure and pause formatting remain unchanged.

**Alternatives rejected:** inline chunking requires new receiver support and can duplicate batching; using the existing session log mixes the report with intermediate events; merely bypassing the notification summary can reintroduce oversized parent events.

### Settle success at close with explicit evidence

Track `agentEndSeen`, a confirmed final `stopReason: "stop"`, and pending recovery separately from the run's public status. Preserve the current pause, cancellation, timeout, and assistant-error branches first.

- Exit zero retains existing success behavior, but any required recovery or file-write error makes the run failed.
- A nonzero close preserves success only when `agentEndSeen`, a confirmed final stop, and successful result delivery are all present and no assistant error is recorded.
- Every other nonzero exit remains failed with stderr/stdout evidence, even when partial assistant text exists.

This distinguishes a post-completion cleanup/transport exit from ordinary execution failure without using "any output means success."

## Risks / Trade-offs

- [Pi changes its leading JSON event shape] → Fail explicitly when the bounded prefix cannot identify an oversized event; never guess success.
- [A result contains sensitive material] → Use a unique owner-only result file and document that the parent should read it promptly; normal temporary-directory cleanup still applies.
- [The latest session message cannot prove a clean stop] → Fail delivery rather than reusing stale output.
- [The session log contains very large history entries] → Use fixed-size file reads and retain only recovery candidates; fail explicitly if a complete final candidate cannot be recovered.
- [Large reports move from inline to file delivery] → This is intentional lossless behavior and uses the existing notification contract, so no BySpace migration is needed.

## Migration Plan

Implement and verify the extension change with its regression tests and README update in the workspace, then copy only the verified subagent files to the actual runtime checkout and rerun its tests and typecheck. Preserve unrelated package-lock changes. Parents consume either inline text or the returned file path with existing file-read tools. Rollback is reverting the extension change; doing so restores the previous oversized-event failure behavior.
