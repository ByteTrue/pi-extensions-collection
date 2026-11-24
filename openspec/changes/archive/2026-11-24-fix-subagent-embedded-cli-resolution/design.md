# Design

## Context

See `proposal.md` for motivation and `specs/subagent-process-launch/spec.md` for behavior requirements.

In `subagent/src/index.ts`, `resolvePiCli()` currently checks:
1. `process.env.PI_CLI_JS`
2. `process.argv[1]` matching `/\.[cm]?js$/i` on the unresolved `path.resolve(process.argv[1])` string
3. `process.env.PI_CODING_AGENT === "true"` combined with `entry === resolve(process.execPath)` (Node SEA) or `Boolean(process.versions.bun)`

Comparison across the Pi subagent ecosystem (`examples/extensions/subagent`, `edxeth/pi-subagents`, and `nicobailon/pi-subagents`) highlights three failure modes that a universal subprocess resolver must handle:
- **Symlinked CLI entrypoints (`.bin/pi`)**: Managed Pi (`~/.pi/agent/bin/pi`) and npm/pnpm bin links execute Node with `process.argv[1]` set to `.../node_modules/.bin/pi`. Without `realpathSync`, checking `/\.[cm]?js$/i` on `process.argv[1]` rejects the valid CLI entry.
- **Non-Pi host scripts in `process.argv[1]`**: Naive checks like `fs.existsSync(process.argv[1])` (used in `examples/extensions/subagent` and `edxeth/pi-subagents`) mistakenly treat an embedded SDK host's script (`node daemon.js`, `vitest` worker) as Pi's CLI and re-spawn the host process with Pi flags.
- **RPC entrypoints and SDK-only hosts**: When Pi is started via `rpc-entry.js` (which hardcodes `--mode rpc`) or embedded via SDK imports, the runnable CLI entry must be resolved from the `@earendil-works/pi-coding-agent` package root (`package.json#bin` / `dist/bundle/cli.js` / `dist/cli.js`).

## Goals / Non-Goals

**Goals:**
- Resolve the active Pi `cli.js` reliably across direct CLI launches, symlinked bin launches (`.bin/pi`), `rpc-entry.js` launches, custom embedded `cli.js` layouts, self-contained binaries (Node SEA / Bun), and embedded SDK hosts.
- Verify package ownership or explicit Pi CLI script identity before trusting `process.argv[1]`, preventing host scripts from being spawned as Pi.
- Keep resolution zero-config and deterministic without scanning `PATH` or invoking external package managers.

**Non-Goals:**
- Switching from subprocess isolation to in-process `createAgentSession` execution.
- Reintroducing `PATH` lookup or `npm`/`pnpm` global prefix scanning.

## Decisions

### 1. Verify `process.argv[1]` via `realpathSync`, `@earendil-works/pi-coding-agent` package ownership, or explicit `cli.{js,mjs,cjs}` naming

- **Decision**: For `process.argv[1]`, inspect both `entry = resolve(argvEntry)` and `canonicalEntry = realpathSync(entry)` (when `realpathSync` succeeds):
  - First, if `entry` itself is an existing `cli.{js,mjs,cjs}` file (or `rpc-entry.{js,mjs,cjs}` with a sibling `cli.js`), return that `cli.js` directly (preserving the unresolved path on platforms like macOS where `/var` symlinks to `/private/var`).
  - Next, on `canonicalEntry`:
    - Walk ancestor directories for a `package.json` with `"name": "@earendil-works/pi-coding-agent"`. If found, resolve the CLI script from that package root (using `package.json#bin` -> `dist/bundle/cli.js` or `dist/cli.js`, or `canonicalEntry` itself if it is `cli.{js,mjs,cjs}`).
    - Otherwise, if `canonicalEntry` is an existing `cli.{js,mjs,cjs}` (or `rpc-entry.{js,mjs,cjs}` with a sibling `cli.js`), return that `cli.js` (supporting symlinked custom layouts without a package manifest).
  - Any other script in `process.argv[1]` (such as `daemon.js`, `server.mjs`, or `forks.js` in an embedded host or test runner) is rejected as a `process.argv[1]` candidate.
- **Rationale**: This combines the package-ownership guarantee of `nicobailon/pi-subagents` with support for custom manifest-less embedded `cli.js` layouts (like AGCopilot's `resources/pi-runtime/dist/cli.js`).

### 2. Resolve from `getPackageDir()` (`@earendil-works/pi-coding-agent`) when `process.argv[1]` is not a Pi CLI entry

- **Decision**: When `PI_CLI_JS`, `process.argv[1]`, and the self-contained binary check do not yield an entrypoint, resolve the Pi package root via `getPackageDir()` imported from `@earendil-works/pi-coding-agent` and resolve its runnable CLI script from:
  1. `<packageDir>/package.json` `bin.pi` (or string `bin`), if the target JS file exists
  2. `<packageDir>/dist/bundle/cli.js`
  3. `<packageDir>/dist/cli.js`
- **Rationale**: `getPackageDir()` is an official export of `@earendil-works/pi-coding-agent` (alongside `getAgentDir()`, which `subagent/src/index.ts` already imports). It honors `process.env.PI_PACKAGE_DIR` and otherwise resolves the loaded `@earendil-works/pi-coding-agent` package root directly from its module location, which works in every Node SDK host that imports `@earendil-works/pi-coding-agent`.

## Risks / Trade-offs

- **[Risk] Unit tests expecting `resolvePiCli()` to throw when `process.argv[1]` is invalid will find `node_modules/@earendil-works/pi-coding-agent` via `getPackageDir()` unless isolated** → **Mitigation**: Point `PI_PACKAGE_DIR` to the empty temporary directory in negative unit tests so `getPackageDir()` is isolated from the repo's `node_modules`, and add dedicated unit tests for `getPackageDir()` package-root resolution.
