# Five approved follow-ups

User approved all five items in order, including commit, push, and the normal Pi package update. Environment acceptance remains deferred; context-prune remains closed.

## 1. Asynchronous orphan recovery — complete

Both extensions now recover at session start with asynchronous OS probes and bounded Windows termination commands. Per-pass PID caches avoid repeated queries; overlapping calls share a scan. Identity checks, private state files, conservative unknown identities, and retry records are preserved. Filesystem bookkeeping remains synchronous. Session initialization still awaits recovery, but the event loop stays responsive.

Subagent validation: 186 passed, 4 platform skips; typecheck with `--noUnusedLocals` passed. Background validation: 98 passed, 8 skips; typecheck passed. The controlled Windows fixture with six records sharing one owner/child now uses two identity probes per pass instead of twelve. Its three pass times were 878.9, 843.4, and 749.8 ms (median 843.4 ms); the earlier synchronous fixture median was 2,978.6 ms. Liveness and termination were mocked, so this is not an end-to-end startup benchmark. See [background details](step1-background.md).

## 2. Resumed-child recovery — complete

New journals record the verified absolute transcript path used by the child. Windows preserves CIM command lines through JSON and accepts only unambiguous complete arguments with Windows space/tab boundaries. Linux reads exact NUL-separated process arguments. Known start-identity mismatches remain authoritative; invalid paths, missing transcripts, ambiguous quoting, and macOS flat command lines retain the journal. Transcript files are never deleted by recovery.

Validation: full subagent suite 195 passed, 4 platform skips before the final three whitespace regressions; final focused recovery/ownership run 21 passed and `--noUnusedLocals` passed. New cases cover exact paths, same basename elsewhere, suffixes, script arguments, newline/NBSP preservation, missing files, malformed identity paths, and PID reuse. A child-process fixture verifies that the journal stores the exact path passed through argv.

## 3. Durable pending completion notices — complete

Both extensions persist one bounded private record per completed task under the parent profile’s `completion-notices` directory, including inactive parents. Restoration is bound to the original profile, source, parent session and task ID. Existing grouped memory cards suppress the same disk records; records are removed only after synchronous `sendMessage` acceptance. Corrupt or unsafe storage is reported without breaking lifecycle cleanup, and pending records remain available for retry. The host has no durable receipt, so a crash or asynchronous failure during handoff can still duplicate or lose a notice.

Pending background logs survive shutdown, orphan recovery and the seven-day sweep across parent sessions and Pi profiles. A private `.log.profile` sidecar locates the owning notice store. Unreadable stores and invalid markers preserve the log; acknowledgement permits normal cleanup. Final independent review caught the cross-profile sweep and residual-journal deletion cases; both were reproduced in regression tests and fixed before release. The operating system can independently clean its temp directory. Real two-process restart, memory/disk deduplication, profile/parent isolation, malicious storage, write/deletion failures and retry behavior are covered. See [shared implementation details](step3-shared.md).

Final focused integration: 50 subagent/shared tests passed with one POSIX-only skip; 30 background tests passed. Both workspace `--noUnusedLocals` typechecks and `git diff --check` passed. The two existing batch-stress tests now allow 30 seconds because they exercise durable disk writes (2,000 subagent notices and 600 shell notices).

## 4. Real output backpressure — complete

A small local shell executor reads stdout/stderr serially and pauses both while the output file awaits drain. No host internals or new dependencies are used. The 50 MiB cap and recent tail remain unchanged. Slow writes are awaited even after process exit; the 100 ms inherited-pipe idle grace is suspended while blocked. Disk failures terminate the producer and report failure. Abort/timeout remains responsive during a blocked write; failed termination cannot fabricate process completion.

Real local tests cover 4 MiB of combined output through a deliberately slow file sink, bounded queued writes, full byte retention, and ENOSPC termination. Backend tests cover exit/abort/timeout, two-pipe draining, callbacks, listeners and timers. Parent review additionally reproduced a retired PID remaining in the exit registry during a slow final write; the fix removes it on process exit, avoids later signals to it, and protects a replacement registration from old cleanup. See [backend handoff](step4-backend.md) and [durable notice review](step3-review.md).

## 5. Verification and release

Final local validation on November 21, 2026: **507 passed, 13 skipped** — manifest 7, ask-user 62, background-terminal 132, bash-timeout 11, goal 69, subagent 226. The skips are platform-specific cases and the opt-in recovery timing probe. All five workspace typechecks with `--noUnusedLocals`, manifest validation and `git diff --check` passed. Real extension loading through Pi 1.5.0 and 1.6.0 loaded all five extensions, eight tools and three commands without errors.

The final run supersedes two intermediate fixture failures: journal-write fault injection now targets the journal path instead of a write-call ordinal; bounded-history assertions wait for notification readiness rather than a status flip before the output stream closes. A separate regression checks that profile-marker creation failure removes the unused log and never launches a command.

Existing changes from the audit, batching fix and approved follow-up are included in the release; the preexisting `bywork/work/paseo-compat/` work is excluded. No dependency versions are upgraded. The managed checkout’s only dirty file, `package-lock.json`, was backed up outside the checkout before using the normal targeted command:

```sh
pi update git:github.com/ByteTrue/pi-extensions-collection
```

Publication and installation are verified against the released Git commit. Restart Pi after current tasks finish so process-global managers use the installed implementation. Environment acceptance remains deferred: no real Linux/macOS, remote BySpace, model-backed TUI/RPC or Paseo desktop run is claimed. The host’s notification handoff has no durable receipt, temporary logs remain subject to operating-system cleanup, and descendant lifetime retains the documented platform limits.
