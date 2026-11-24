# Tasks

## 1. Universal Subprocess Pi CLI Entry Resolution

- [x] 1.1 Update `resolvePiCli()` in `subagent/src/index.ts` to dereference `process.argv[1]` symlinks via `realpathSync`, resolve `@earendil-works/pi-coding-agent` package roots via `package.json#bin` (or sibling `cli.js` for `rpc-entry.js` and custom `cli.js` layouts), reject non-Pi host scripts in `process.argv[1]`, and fall back to `getPackageDir()` for embedded SDK hosts; verify with `npm --prefix subagent test`
- [x] 1.2 Expand `resolvePiCli` unit tests in `subagent/src/index.test.ts` to cover symlinked `.bin/pi` launches, `rpc-entry.js` launches, embedded SDK hosts (missing `process.argv[1]` and non-Pi host `.js`/`.mjs` scripts resolved via `getPackageDir()`), and isolated failure cases; verify all tests pass with `npm --prefix subagent test`
