# Item 1 — background-terminal async recovery

Completed the background-terminal side only. No commit was made. Existing uncommitted audit edits were preserved; backend execution/output code and README documentation were not changed.

## Implementation

- `background-terminal/background-terminal.ts`: replaced recovery `execFileSync` calls with callback-based async `execFile`. Start-time queries, command-line fallback queries, and Windows `taskkill.exe` share a 5,000 ms timeout, `SIGKILL` timeout signal, UTF-8 output, and hidden Windows console. POSIX liveness/signaling still uses the existing direct `process.kill` calls.
- `reapOrphans(): Promise<void>` shares one in-flight pass. A new pass gets a fresh PID-keyed cache of liveness, start-query promises, command-query promises, and termination results. Multiple journals for one owner/child do not repeat those probes or termination attempts; failures are retried on the next pass.
- Moved orphan recovery and the subsequent old-log sweep from the synchronous extension factory into the awaited `session_start` handler. Registration performs no OS query. Recovery can delay completion of session startup, but pending probes leave the event loop responsive.
- Owner identity for new task journals is now one cached async promise, including concurrent task starts. Commands still wait for the private journal to be written. A cancellation during that identity wait is checked before journal creation/backend entry so a cancelled task never launches.
- Kept existing state-directory ownership/mode checks, owned non-symlink file reads, journal-derived task IDs, canonical in-directory metadata paths, conservative unknown/EPERM handling, authoritative known child-start mismatches, and cleanup only after a successful kill or already-absent child.
- Kept synchronous filesystem bookkeeping. Did not add a Windows bulk-query parser: per-pass PID reuse removes the repeated PowerShell launches without extra platform-specific parsing.

## Tests changed

- `background-terminal/reap.test.ts`: await reaping and mock async `execFile`; retained real orphan-tree, denied/failed kill, startup grace, PID mismatch, owner liveness, and platform-specific symlink/macOS coverage.
- `background-terminal/owner-identity.test.ts`: retained owner identity cases; added concurrent owner-query reuse and prelaunch cancellation, in-flight reap coalescing, per-pass PID/start/command deduplication, failed-query retry, timeout-option checks, and a timer heartbeat while `session_start` awaits a delayed query. The opt-in real-OS probe measurement uses async probes and updated deduplicated counts.
- Necessary caller-test adjustments beyond the two recovery suites: `background-terminal/security.test.ts` awaits the two successful reaper calls (the synchronous private-directory refusal assertion remains); `background-terminal/stop-and-wait.test.ts` waits for the synthetic backend signal before fake timers; `background-terminal/background-kill.test.ts` waits for synthetic backend entry before fake timers. These last two are fixture-only timing fixes: their unconfirmed-stop expectations and production stop behavior are unchanged.

## Verification

- Focused recovery/manager/sweep/security run: 5 files passed; 45 tests passed, 8 skipped.
- Final `npm run test --workspace background-terminal`: 11 files passed; 98 tests passed, 8 skipped; no unhandled errors.
- `npm run typecheck --workspace background-terminal`: passed, including test sources.
- `git diff --check -- background-terminal`: passed.
- Opt-in measurement: `PI_BACKGROUND_RECOVERY_PROBE=1 npm run test --workspace background-terminal -- owner-identity.test.ts -t 'measures recovery probes' --reporter=verbose` passed on win32 / Node v26.13.0. Three passes of six synthetic journals sharing one owner/child used **6 real OS start probes total** (2 per pass; previous fixture expected 36) and **3 mocked terminations total** (previous fixture expected 18). Pass times: **878.9, 843.4, 749.8 ms**. This is a controlled process-query measurement, not end-to-end startup performance; liveness and termination remain mocked.

## Handoff / limits

- The public reaper now returns a Promise; all successful test callers await it, and `session_start` awaits it before sweeping. Private-directory rejection intentionally remains synchronous.
- `BackgroundManager.start()` still returns a task immediately, but initial OS identity acquisition/journal creation/backend entry is asynchronous. Tests that need an already-entered backend must wait for backend entry before exercising stop-deadline behavior.
- Item 4/backend-output work was not implemented. No other workspace tests or real Linux/macOS executions were run; those platform-specific cases remain for CI.
- Each OS subprocess is bounded individually; a pass with many distinct slow/unresponsive PIDs can still take multiple timeout intervals, while the event loop remains free.
