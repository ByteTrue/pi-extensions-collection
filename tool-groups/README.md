# Tool groups

Folds consecutive displayed-context tool calls into one summary, closed by default. History follows Pi's active branch and compaction, while live events remain visible until persisted:

```text
▸ read: 2 succeeded · bash: 1 running, 1 failed
```

User messages, assistant text, and thinking break groups, even when thinking is
hidden. Calls stay in source order; execution updates only change their outcome
counts, never the open/closed choice. A single call is also a group.

## Controls

- **Alt+O** toggles the latest group.
- **/tool-groups** opens a newest-first selector; arrows navigate, Enter toggles the selected group and closes the selector, and Escape cancels. Empty or non-TUI contexts do nothing.
- **Ctrl+O** (Pi’s global tool-expansion action) opens or closes all groups.
- In **fullscreen mode**, left-click a summary to toggle just that group.
- Within an open group, native tool rows keep their own click-to-expand behavior.
  Dragging, wheel scrolling, selection, and copying stay with Pi.

Opened groups use Pi’s public `ToolExecutionComponent` with the downstream
renderer definition unchanged, including missing/throwing renderer fallbacks.
Native argument streaming, partial results, error rendering, padding, renderer
state, and invalidation are preserved. This extension does not execute tools or
change messages. RPC, JSON, and print mode retain the original renderers.

## Native terminal verification

- Resume a session with persisted adjacent tool calls and confirm summaries follow the active compacted context.
- Navigate to another tree branch while a live call is unpersisted; confirm the old summary and picker choice do not survive.
- Open `/tool-groups` in regular scrollback with more groups than terminal rows, use arrows and Enter, then reopen and use Escape; keep the selected row visible.
- Start a tool call and open the picker before its result is persisted; confirm it is listed once and updates in place.

## Install and develop

Installed with the root git package; requires Pi **1.5.0 or newer**. To try only
this extension from a checkout:

```bash
pi -e ./tool-groups/tool-groups.ts
npm test -w tool-groups
npm run typecheck -w tool-groups
```

## Current limits

- Groups follow the active displayed branch; hidden/compacted calls are not reconstructed.
- Codemode summaries use Pi's structured nested-call lifecycle and persisted metadata.
  Reported internal calls replace the codemode wrapper count; tools without nested
  calls keep the wrapper count. Pi bounds persisted metadata to 256 calls, 8 KiB
  of arguments per call, and 32 KiB total argument data. Calls or arguments may
  be omitted, and unfinished calls remain unfinished, so summaries marked
  `incomplete` count only reported calls and are not totals. The extension does
  not infer calls from codemode output text. Hosts or tools that do not report
  structured nested-call metadata retain wrapper counts. Live events can report
  more calls than the persisted cap; known calls remain counted, with the
  incomplete marker retained when Pi marks its record incomplete.
- Pi still owns image output: images can remain visible while a group is closed
  and may appear twice when opened. No private host internals are used to hide them.
- A renderer resolver loaded before this one that does not call `next()` can
  prevent grouping. Put tool-groups before such an overriding extension.
- Summary lines truncate to terminal width; opening shows the full native rows.
