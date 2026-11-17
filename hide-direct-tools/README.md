# hide-direct-tools

Makes `codemode.mode: "only"` a hard single entry point: the model can only call
`codemode` directly, and every other tool runs from inside the script.

## Why

With `codemode.mode: "only"`, Pi 1.5.x already leaves direct-exposure tools out of the
request declarations and the `<tools>` section, and marks skills' reader as indirect.
What it does not do is stop execution: hidden tools stay active, so a model that names
one anyway still gets it run. That is deliberate — scripts need those tools callable —
but it means the prompt alone is not a boundary.

This extension closes the gap with two event hooks:

- **`tool_call`** — blocks a top-level call to anything but `codemode`. Nested calls made
  by a codemode script carry `parentToolCallId` and pass through. The block reason names
  the script form (`await tools.<name>({ ... })`), so a model that guessed wrong corrects
  itself on the next turn.
- **`before_agent_start`** — appends one `<rules>` bullet saying codemode is the only
  direct entry. No prompt parsing or section rewriting: the tool list is filtered
  natively in 1.5.x.

No-op unless `codemode.mode` is `"only"`; it registers no tools and no commands.

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Then set the mode in `~/.pi/agent/settings.json`:

```json
{
  "codemode": { "mode": "only", "inlineBudget": 3000 },
  "defaultTools": ["+codemode"]
}
```

Keep `read`, `bash`, `edit`, `write` active — the codemode script needs them callable.
`+codemode` adds it to the built-in defaults; a plain `"defaultTools": ["codemode"]`
would make the other tools inactive and break scripts.

## Deliberate limits

- **One mode, no configuration.** Nothing to tune: if `codemode.mode` is not `"only"`,
  the extension does nothing.
- **Model-only tools stay declared.** Mode `"only"` hides only `exposure: "direct"` tools
  that are already declared, so a `model-only` tool (for example `tool_search`) can still
  appear — and this extension blocks it like any other top-level call. Strict single-entry
  is the point; do not enable those tools together with this mode.
- **Custom system prompts lose the rule.** `before_agent_start` options carry
  `promptGuidelines` only in Pi's default prompt; with `customPrompt` the bullet is not
  rendered. The `tool_call` block still enforces the boundary.
- **Error wording is the only steering.** If a model keeps retrying the blocked form, the
  reason says what to do instead; there is no escalating reminder.
