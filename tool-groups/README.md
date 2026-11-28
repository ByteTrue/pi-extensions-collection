# Tool groups

Folds consecutive current-session tool calls into one summary, closed by default:

```text
▸ read: 2 succeeded · bash: 1 running, 1 failed
```

User messages, assistant text, and thinking break groups, even when thinking is
hidden. Calls stay in source order; execution updates only change their outcome
counts, never the open/closed choice. A single call is also a group.

## Controls

- **Alt+O** toggles the latest group.
- **Ctrl+O** (Pi’s global tool-expansion action) opens or closes all groups.
- In **fullscreen mode**, left-click a summary to toggle just that group.
- Within an open group, native tool rows keep their own click-to-expand behavior.
  Dragging, wheel scrolling, selection, and copying stay with Pi.

Opened groups use Pi’s public `ToolExecutionComponent` with the downstream
renderer definition unchanged, including missing/throwing renderer fallbacks.
Native argument streaming, partial results, error rendering, padding, renderer
state, and invalidation are preserved. This extension does not execute tools or
change messages. RPC, JSON, and print mode retain the original renderers.

## Install and develop

Installed with the root git package; requires Pi **1.5.0 or newer**. To try only
this extension from a checkout:

```bash
pi -e ./tool-groups/tool-groups.ts
npm test -w tool-groups
npm run typecheck -w tool-groups
```

## Current limits

- Only calls observed since the current session start are grouped. History replay,
  a `/tool-groups` picker, and advanced session navigation belong to follow-up #4.
- Counts are top-level tools only; nested codemode aggregation belongs to #3.
- Pi still owns image output: images can remain visible while a group is closed
  and may appear twice when opened. No private host internals are used to hide them.
- A renderer resolver loaded before this one that does not call `next()` can
  prevent grouping. Put tool-groups before such an overriding extension.
- Summary lines truncate to terminal width; opening shows the full native rows.
