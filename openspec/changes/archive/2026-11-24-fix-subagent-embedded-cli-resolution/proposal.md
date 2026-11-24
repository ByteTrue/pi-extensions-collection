# Proposal

## Why

Commit `c6590d4` (`fix(subagent): resolve Pi CLI from current process`) updated `resolvePiCli()` in `subagent/src/index.ts` to derive the child Pi entrypoint strictly from `process.argv[1]` (requiring an unresolved `.js`/`.cjs`/`.mjs` suffix) or a self-contained binary (`Node SEA` / `Bun`). This introduced a severe regression in two real-world launch modes:

1. **Symlinked CLI launches (including Paseo's RPC spawn and Pi's managed `~/.pi/agent/bin/pi` launcher)**: When Node is invoked via a symlink such as `~/.pi/agent/install/releases/<ver>/node_modules/.bin/pi` (which points to `../@earendil-works/pi-coding-agent/dist/bundle/cli.js`), `process.argv[1]` is the symlink path ending in `/pi` (no `.js` suffix). Because `resolvePiCli()` checked `/\.[cm]?js$/i` before resolving symlinks with `realpathSync`, it rejected `process.argv[1]`.
2. **Embedded SDK hosts (and non-CLI entrypoints such as `rpc-entry.js`)**: When a host process embeds `@earendil-works/pi-coding-agent` as an SDK library without invoking `cli.js` as `process.argv[1]`, `process.argv[1]` is either empty or points to the host's own script (e.g. `daemon.js`). `resolvePiCli()` has no package-root fallback and fails before spawning any child subagent process.

## What Changes

- Update `resolvePiCli()` in `subagent/src/index.ts` to resolve the Pi CLI script deterministically using symlink dereferencing (`realpathSync`), `@earendil-works/pi-coding-agent` package manifest (`package.json#bin`) verification, and `getPackageDir()` fallback:
  1. `PI_CLI_JS` explicit path override when set (used by test harnesses and explicit overrides).
  2. `process.argv[1]` resolution (checking both `resolve(process.argv[1])` and `realpathSync(process.argv[1])`):
     - If the path belongs to a `@earendil-works/pi-coding-agent` package root (found by walking ancestor `package.json` files), resolve its runnable CLI entry from `package.json#bin` (`dist/bundle/cli.js` / `dist/cli.js`). This cleanly handles symlinked `.bin/pi` launchers and `rpc-entry.js` launches alike.
     - If the path is an existing `cli.{js,mjs,cjs}` script (or `rpc-entry.{js,mjs,cjs}` with a sibling `cli.js`) in a custom embedded layout without a package manifest (such as AGCopilot's `resources/pi-runtime/dist/cli.js`), use that `cli.js`. Non-Pi host scripts (e.g., `daemon.js`, `server.mjs`, `vitest`) are never mistaken for Pi's CLI.
  3. Self-contained binary (`Node SEA` where `resolve(process.argv[1]) === resolve(process.execPath)` with `PI_CODING_AGENT === "true"`, or `Bun` standalone binary).
  4. Active Pi SDK package fallback via `getPackageDir()` from `@earendil-works/pi-coding-agent` (reading `package.json#bin` or `dist/bundle/cli.js` / `dist/cli.js`), covering embedded SDK hosts where `process.argv[1]` is absent or points to the host application.
- Expand unit tests in `subagent/src/index.test.ts` to cover symlinked `.bin/pi` entrypoints, `rpc-entry.js` entrypoints, embedded SDK hosts (both missing `process.argv[1]` and non-Pi host scripts in `process.argv[1]`), and custom embedded `cli.js` layouts.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `subagent-process-launch`: Expand child Pi CLI resolution requirements to support symlinked CLI entrypoints (`.bin/pi`), package-manifest `bin` resolution for `rpc-entry.js` and SDK packages, and embedded SDK host processes via the loaded `@earendil-works/pi-coding-agent` package root.

## Impact

- `subagent/src/index.ts`: `resolvePiCli()` and helper functions, plus importing `getPackageDir` from `@earendil-works/pi-coding-agent`.
- `subagent/src/index.test.ts`: Unit test suite for `resolvePiCli()`.
