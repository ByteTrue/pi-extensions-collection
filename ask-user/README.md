# ask-user

A minimal `ask_user` tool for Pi: when a user decision has concrete choices,
the model calls `ask_user` instead of writing a prose question, and you pick
options with arrow keys + Enter instead of typing `第一个…第二个…` by hand.

It exists because without a tool the model's question format drifts every
session — one structured tool with a fixed schema pins the format, and each
answer becomes a few keystrokes across both TUI and RPC (BySpace) modes.

## What it does

Registers one tool:

- **`ask_user(questions)`** — decision or clarification questions per call.
  - `questions`: array of `{question, options, multiple?}` items (a single
    question is simply a 1-item array). `options` is required and takes 2-8
    entries (soft cap: a longer list does not fit a picker); there is no bound on
    the number of questions. Option labels are
    meant to be 1-5 words with a one-line description. Labels identify answers:
    they must be unique within each question after trimming, even when their
    descriptions differ. The entire batch is validated before any UI opens.
    Labels and rendered rows must not overlap another option or use generated
    Other/Back/Done row text (including checklist prefixes and custom `Other: …`
    rows in multi-select). Invalid choices return an error identifying the
    question and options to rename; labels may repeat in different questions.
  - **Single-select (`options` without `multiple: true`)**: rendered through
    Pi's built-in `ctx.ui.select` dialog with an always-appended
    **"Other (type your answer)"** row.
  - **Multi-select (`multiple: true`)**: a loop of `ctx.ui.select` dialogs
    re-rendered as a checklist — Enter activates the highlighted row (toggle
    `[✓]` / `[ ]`, or open **"Other (type your answer)"** and merge it as
    `[✓] Other: …`), and submission is the explicit **"✓ Done (N selected)"**
    row (0 selected submits `Unanswered`). Enter never submits a half-built
    selection on its own: one key does one job, in every dialog.
  - **Back-navigation (`questions.length > 1`)**: questions 2..N include a
    **"← Back to previous question"** row so you can return to an earlier
    question and revise its answer. Picks and custom Other text are preserved,
    including changes made before pressing Done.
  - **Freeform answers** exist only through **Other**: the built-in multiline
    editor (TUI) or input dialog (RPC). There is no options-less question; the
    model gets an explicit error instead. **Other is generated, never supplied**:
    it is appended after the last option on every question, no matter how many
    options there are, so the model never lists it and cannot shadow it (see the
    collision checks above). Control rows stay below it — `✓ Done` in
    multi-select, `← Back` from question 2 on.
  - **Dismiss (Esc)**: cancelling freeform input opened from **Other** returns
    to the current options or checklist, preserving multi-select picks and saved
    custom text. Dismissing an option list or checklist keeps the answers already
    given and reports only the remaining questions as dismissed, so a
    half-finished batch is not thrown away; everything dismissed at once returns
    a fixed "dismissed" text so the model falls back to plain prose instead of
    re-asking.
  - **No dialog-capable UI (print/JSON mode)**: explicit error — the tool never
    guesses an answer.

No runtime imports and no config. Every dialog is a Pi built-in
(`ctx.ui.select` / `editor` / `input`) with the same arrow-keys + Enter
semantics, in TUI and RPC alike. No custom component, no overlay, no timeout.

### Every dialog runs with the working spinner hidden

While any of these dialogs is open, the extension calls
`ui.setWorkingVisible(false)` and restores it in a `finally` block. Pi's
working spinner (a `pi-tui` Loader) re-renders the whole alt-screen frame every
80ms — 12.5 frames/s, transcript included — for as long as the dialog waits.
Nothing on screen changes during that wait, and users routinely leave an
`ask_user` dialog open for over an hour (676 minutes in the longest recorded
call); that much sustained redraw was enough to wedge Windows Terminal
(`Application Hang` / `RADAR_PRE_LEAK_64` in the event log). Hiding the spinner
actually disposes the loader's `setInterval`, so the frames stop instead of
merely being drawn invisible.

Known limits, deliberately not fixed here:

- **Only `ask_user`.** Other extension dialogs (`/model` picker, confirmations,
  login prompts, `showExtensionConfirm` / `showExtensionEditor`) still spin
  while they wait.
- **Restore re-enables Pi's default, not the caller's value.**
  `setWorkingVisible` has no getter, so if some extension globally hid the
  spinner, `ask_user` turning it back on would override that. No extension in
  this repo does that today.
- **The terminal-side root cause is outside this boundary.** If hangs persist,
  the next step is a newer Windows Terminal (1.25+) or WezTerm, not another
  patch here. The real general fix belongs upstream: pause the working
  indicator while a dialog is pushed onto the extension-dialog stack.
- Non-TUI modes (print / JSON / RPC) are untouched — they have no spinner.

Tool calls execute sequentially so one dialog cannot restore the spinner while
another is open. The tool's `AbortSignal` is forwarded to RPC `select` and
`input` dialogs, allowing an RPC abort to dismiss the pending question. An
already-aborted call never opens a freeform editor, and answers arriving after
abort are ignored. Pi's TUI multiline editor has no signal/close API: if a run is
aborted while that editor is already open, dismiss it with Esc to release the tool.
Automatic closure requires a host editor cancellation/close API; the extension
keeps the built-in editor and discards any late answer.

The tool declares `constrainedSampling: {type: "json_schema", strict: "prefer"}`,
the same request Pi's built-in `read`/`bash`/`edit`/`write` tools make. Strict
mode lets the provider constrain the argument text to a valid JSON object, which
removes the whole class of "Invalid arguments: … after JSON at position N"
failures — trailing text, a doubled closing brace, or duplicated stream deltas
from a proxy. `prefer` means a provider without strict support still gets the
tool, just unconstrained.

### Where the model sees this (one sentence, no guidelines)

The registration text is the only lever this extension has, and it is
deliberately one sentence: mechanics (batching, `multiple`, Other/Back/Done
rows, no-re-ask) live in the schema and in the dialog itself, not in a prose
blurb the model has to read on every session. Same shape as pstack's
`ask_user_question`, minus its numeric limits.

Under `codemode.mode: "only"`, and any other mode that hides a tool
declaration, Pi leaves the tool out of `<tools>` *and* `<rules>`, so
codemode inlines that sentence into its own tool catalog. Nothing is lost —
there is no `promptSnippet`/`promptGuidelines` text to trail behind it.

## Install

Part of this repo's git package:

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Restart or reload Pi afterwards.

## History

The repo previously carried a fuller `@bytetrue/pi-ask-user` package and
removed it for the minimal-tool principle (issues 043/047). This single-file
form is the re-scoped version: the user re-judged the daily-interaction pain
(question format drift, typed answers) as worth one small tool, and asked for
the lightest possible shape — built-in dialogs, plain JSON schema, zero runtime
imports.

## Tests

`npm --workspace ask-user test` covers registration, single-select option
composition, the multi-select checklist loop (toggle row by row, submit from
`✓ Done`), custom
`Other` merging, cancellation recovery, and preservation across back-navigation, option identity and
generated-row collision checks before UI, the required-`options` rule,
rejection of the legacy single-question shape, partial answers on dismiss,
mode guards,
schema shape (plain JSON Schema, no TypeBox runtime symbols, still convertible
to the strict subset so `strict: "prefer"` can engage), and spinner suppression
(hide/restore on every path, one symmetric pair per dialog, fully skipped
outside TUI mode, restored even when the dialog throws).
