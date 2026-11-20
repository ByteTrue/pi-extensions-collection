# Step 4 execution backend handoff

Implemented only:

- background-terminal/execution.ts
- background-terminal/execution.test.ts
- This report

No edits to the manager, output sink, documentation, dependencies, or user settings. No installs or commits.

## API and integration

The requested API is unchanged:

    export type BackgroundOperations = {
      exec(command: string, cwd: string, options: {
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
        onData: (chunk: Buffer) => void | Promise<void>;
      }): Promise<{ exitCode: number | null }>;
    };

    export function createBackgroundBashOperations(
      killTree: (pid: number) => Promise<boolean>,
      shellPath?: string,
    ): BackgroundOperations;

Pass the existing killTaskTree as the first factory argument. The onData callback must return its sink's promise when blocked; a synchronous callback stays synchronous. The parent owns manager integration, sink propagation, documentation, and normal shutdown/journal recovery.

## Behavior

- Uses only public getShellConfig/getAgentDir APIs. No internal imports or dependencies.
- Preserves explicit env object identity. Default env clones process.env and adds agentDir/bin to the existing case-insensitive PATH key only when absent.
- Validates timeout as finite, positive, at most 2147483 seconds; preserves cwd error text, pre-abort and spawn-race checks, signal exit codes, detached POSIX groups, and windowsHide.
- Rejects commandTransport stdin with the existing native-Windows WSL support restriction; default Git Bash and Unix argv shells work.
- Reads child pipes explicitly through readable events. When the shared sink returns a promise, both streams pause and no more chunks reach the sink until it settles. Explicit reads also prevent Node's automatic stdio resume after child exit from discarding buffered output while the sink is blocked.
- After shell exit, completes when both pipes end or after 100 ms of actual idle. New output rearms the idle grace. The grace is suspended during a pending sink write; completion always waits for that write.
- Abort/timeout start the supplied killTree immediately, including while blocked. Errors retain the established aborted / timeout:<seconds> forms. Synchronous callback throws and rejected writes trigger termination and reject execution without unhandled rejections.
- A false, rejected, or synchronously throwing kill request cannot fabricate completion: execution remains pending until the child actually exits. This preserves the manager's bounded stop-wait and journal behavior. A confirmed exit still waits for the pending write and kill request to settle.
- One Symbol.for registry holds active PID-to-killTree callbacks across module reloads, with one process exit hook. It invokes each callback immediately, before any await. No per-child process exit listeners or replacement signal handlers. Pi's normal SIGTERM shutdown runs extension cleanup and exits; the parent retains lifecycle ownership.

## Validation

Passed on native Windows with the installed Git Bash and Node v26.13.0:

    npm run test --workspace background-terminal -- execution.test.ts

23 tests passed. Coverage includes both-pipe pressure, a sink blocked for 250 ms after shell exit with unread tails in both streams, simulated Node stdio resume, active inherited handles and 100 ms idle completion, abort/timeout while blocked, false/rejected/thrown kill requests, thrown/rejected callbacks, asynchronous and synchronous spawn failures, both pre-abort windows, timeout boundaries, cwd failure, unsupported stdin transport, env identity/default PATH, signal exits, and registry/listener/timer cleanup across reloads.

Two tests use real local shells: normal stdout/stderr with exit 7, and a 2 MiB producer (1 MiB on each pipe) with an asynchronous slow sink. Every byte arrived and maximum concurrent sink writes was one.

Passed the isolated strict backend typecheck using repository-equivalent compiler options:

    npx --no-install tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2023,DOM --strict --noUncheckedIndexedAccess --skipLibCheck --types node background-terminal/execution.ts background-terminal/execution.test.ts

An initial workspace typecheck reported output-pressure.test.ts(39,78): error TS18048: 'stream' is possibly 'undefined'. That concurrently edited parent-owned test was left untouched. The initial backend test run had a test-fixture PATH duplication, corrected before the passing run.

## Parent integration review

The parent added a failing regression for a child PID left registered after process exit while its final disk write was blocked. The registry entry is now removed at exit, subsequent aborts do not signal that retired PID, and a unique per-execution registration prevents delayed cleanup from removing a newer registration with the same PID. The parent also corrected the output-pressure test type and verified the backend together with the real manager/sink integration. Full repository results are recorded in `index.md`.

## Limits

No real POSIX/macOS process-tree or SIGTERM subprocess smoke test was run on this Windows host; cancellation and process-exit registry behavior have controlled tests. No complete manager/output integration suite was run in this subtask.

As required by the host policy, quiet inherited output handles are released after 100 ms; later descendant output is not retained. A sink promise that never settles or a child that survives killTree keeps exec pending; the parent's bounded shutdown and recovery journal must remain in place. Process exit cleanup starts OS termination but cannot await it, and hard process termination requires the existing journal/watcher recovery.
