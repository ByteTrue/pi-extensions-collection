# Spec Delta

## MODIFIED Requirements

### Requirement: Installation-layout-independent launch
The system SHALL derive the default child Pi entry from the active parent runtime and MUST NOT require a global installation or a `pi` command on `PATH`.

#### Scenario: Embedded AGCopilot runtime
- **WHEN** the parent Pi runs from an arbitrary embedded layout such as `resources/pi-runtime/dist/cli.js`
- **THEN** the child uses that same entry with the current runtime without consulting global installations

#### Scenario: Conventional package runtime
- **WHEN** the parent Pi runs from a conventional `node_modules` package layout
- **THEN** the child uses the active parent entry rather than searching for another installed copy

#### Scenario: Symlinked CLI launcher
- **WHEN** the parent Pi is launched via a symlink whose `process.argv[1]` path has no JavaScript file extension (such as `node_modules/.bin/pi` or a managed bin symlink targeting `cli.js`)
- **THEN** the system resolves the symlink target with `realpathSync` to the underlying Pi `cli.js` entry and launches the child with the current JavaScript runtime

#### Scenario: Sibling CLI resolution from RPC entry
- **WHEN** the parent Pi is launched via `rpc-entry.js` inside `@earendil-works/pi-coding-agent` or alongside a sibling `cli.js`
- **THEN** the child process resolves and uses `cli.js` (via the package manifest `bin` entry or sibling `cli.js`) so child CLI mode flags are not overridden by the parent RPC entrypoint

#### Scenario: Embedded SDK host runtime
- **WHEN** the parent process embeds Pi as an SDK host and `process.argv[1]` is absent or points to a non-Pi host script
- **THEN** the system does not spawn the host script as a Pi CLI and instead resolves `cli.js` from the loaded `@earendil-works/pi-coding-agent` package root (`getPackageDir()`)

#### Scenario: Unrelated global installation
- **WHEN** a different Pi version is globally installed or available on `PATH`
- **THEN** its presence does not change the selected child entry or runtime
