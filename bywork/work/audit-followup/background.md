# Background terminal audit follow-up: R3, R12, R13

R3 now persists `ownerPid` and `ownerStart` in new task journals. The start identity comes from the OS, not the task creation timestamp or a wall-clock/uptime estimate. It is captured once on the first task start per module load. Recovery proceeds past a live owner PID only when its recorded and current start identities are both readable and differ. Child start matching, command-marker fallback, state-file checks, startup grace, and failed-kill retention remain in place.

Legacy journals without the field, invalid/empty fields, and failed owner identity queries retain conservative PID-only behavior. A definitely absent owner PID permits the existing child recovery checks. No journal rewrite is needed. An unavailable initial owner identity is cached as unknown for that module load; those journals retain the conservative fallback. Let tasks finish and restart Pi when updating.

R12 replaces the menu's whole-log read with the existing sanitized tail formatter: last 50 lines, up to 4,000 characters, plus small fixed metadata and the complete log path. Earlier-output omission and the log's first-50-MiB retention limit are explicit. The output stream and its backpressure behavior are unchanged.

## Controlled R13 measurement

Measured on Windows x64, Node v26.13.0, on 2026-11-20. The opt-in fixture uses six one-hour-old dev-server journals with PID/start/log files in a private temporary directory. It exercises the owner-PID-reuse path: two real synchronous Windows PowerShell start-time queries per record, redirected to the test process. Liveness and termination are mocked; only the fixture directory is scanned. No unrelated process is signaled. Setup and the initial identity lookup are outside the timed region.

| Run | Six-record recovery pass |
| --- | ---: |
| 1 | 2,978.6 ms |
| 2 | 3,177.8 ms |
| 3 | 2,883.0 ms |

Median: 2,978.6 ms for six records (about 496 ms/record). The three passes made 36 real OS identity queries and 18 mocked tree terminations. This measures synchronous probe and fixture-file handling cost, **not end-to-end orphan termination or Pi startup**. Actual termination, command-marker fallback queries, access failures, five-second timeouts, and slow disks are excluded. Owner-already-gone records require fewer identity queries. No latency bound is inferred from three local samples.

Reproduce from the repository root using Git Bash:

```bash
PI_BACKGROUND_RECOVERY_PROBE=1 node node_modules/vitest/vitest.mjs run --root background-terminal owner-identity.test.ts -t "measures recovery probes" --reporter=verbose --silent=false
```

The probe is skipped during ordinary tests. Recovery still runs synchronously, and each OS query/Windows termination command has a five-second timeout. Several stale records can visibly delay loading; batching or asynchronous recovery would be follow-up work.

Native Windows support requires Git for Windows Bash, MSYS2 Bash, or Cygwin Bash with `/proc/<pid>/winpid` plus the system Windows PowerShell. Native PowerShell/cmd and WSL-backed shells are outside this wrapper's supported command-shell contract. Multi-user installations must supply per-account private temp directories with ACLs that prevent other users from modifying state files; ACLs are neither inspected nor repaired here.

## Verification and remaining host work

- Focused regressions reproduced missing owner identity, skipped recovery after owner PID reuse, and the menu's whole-log read before the fix; all passed after it.
- Owner tests cover actual probe-value persistence, matching/missing/invalid/unreadable owner identity, legacy dead-owner recovery, and preserving child identity mismatch safeguards.
- Menu tests cover the character and line bounds, control stripping, omission marker, complete path, cap notice, and zero log reads.
- Recovery fixtures use isolated temp directories. A concurrent run exposed the old shared-directory race between test reapers; the isolation removes it.
- `npm --workspace background-terminal test`: all 11 files passed, 93 tests passed and 8 skipped (Windows platform exclusions plus the opt-in probe). `npm --workspace background-terminal run typecheck`: passed. Scoped `git diff --check`: passed.
- No root suite, dependency install/sync, commits, or lifecycle API changes.

Host/platform support is still needed for strict Windows descendant lifetime guarantees (for example Job Objects) and for shell-output pause/resume backpressure. POSIX `ps lstart` retains its existing second-level time representation; cross-platform real-machine coverage and slow-disk memory peaks were not measured.
