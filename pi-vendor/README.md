# pi-vendor (small extension)

Pi-specific `/vendor` interactive wizard for adding a custom provider or model to
`~/.pi/agent/models.json`.

It is Pi-specific because it owns Pi's `models.json` transaction and model-registry
refresh. The agent-facing workflow — adding models from official metadata, discovering
and exactly synchronizing a provider's upstream list, drift and ordering audits — is not
part of this extension. It lives in the `provider-model-config` skill, which covers
opencode's `opencode.jsonc` with the same workflows.

## Install

Use the repository's small-extension installer and select `pi-vendor`, or install all
small extensions:

```bash
node /tmp/install-small-extension.mjs --all
```

The installer places `pi-vendor.ts` in `~/.pi/agent/extensions/`.

Restart or `/reload` Pi, then `/vendor` opens the interactive wizard. Choose **Add
provider** or **Add model**. The wizard supports official-catalog metadata, upstream
model discovery, API/base URL and credential configuration, model defaults, and refresh
after saving.

## Safety and behavior

- Reads and writes Pi's `models.json`; it does not use Satchel's MCP configuration.
- Uses revision checks and atomic writes so a concurrent edit is not silently overwritten.
- Existing provider/model edits are narrow; malformed configuration fails closed.
- Saving refreshes Pi's model registry and reports any rejection.
- `/vendor` requires interactive TUI mode; non-interactive sessions should edit
  `models.json` directly or use the `provider-model-config` skill.
- API keys remain local. Do not paste credentials into Agent conversations.

## Small-extension packaging

The executable extension entry is exactly `pi-vendor.ts`. It has no build step, no
companion resource files, and no runtime dependency on the retired `@bytetrue/pi-vendor`
package: static runtime imports use only `node:*` built-ins, while Pi host modules
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) are resolved dynamically
from the running Pi installation.

It is a small extension (never published to npm) that drops straight into
`~/.pi/agent/extensions/` and works without `npm install`.

## Development

```bash
npm --workspace pi-vendor test
npm --workspace pi-vendor run typecheck
```

Tests exercise the single-file exports, the `/vendor` command and its TUI flows, and the
configuration transactions (revision checks, atomic writes, validation). Declaration
files under `types/` preserve strict development-time types; they are not part of the
installed artifact.
