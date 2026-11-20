# Step 3 — shared durable completion delivery

Scope: shared/completion-delivery.ts and focused subagent tests only. Extension integrations and output-file retention are handled separately.

## API decisions

- Completion.ids?: string[] identifies the tasks covered by a preformatted card. Omission preserves memory-only callers/tests; durable callers should always supply IDs, including grouped memory cards.
- Source.storageDir?: string enables persistence. Pass the profile's join(getAgentDir(), "completion-notices"). The helper resolves the path once; omitting it keeps the original memory-only behavior.
- handle.persist(parentSessionId, completion): void requires exactly one task ID. Call synchronously at task settlement, after retaining the notification in memory, even when that parent is inactive. It does not schedule delivery or modify the memory queue. It throws storage/validation errors so the caller can report them without dropping that queue entry.
- Supply the minimal source-specific message: customType, content (at most 50,000 characters), display, and small JSON replay details. The helper serializes only this message plus identity metadata, never the completion callback or a task object. The caller remains responsible for keeping task objects out of details. Serialized records are capped at 1 MiB; identifiers are nonempty strings of at most 4,096 characters.
- The latest registration for a source ID replaces that source's previous handle, as before. Stale handles cannot send, persist, cancel, or schedule. Separate copies of the module share the global registry and reentrant-flush guard.

## Record format and storage

Each JSON record has { version: 1, profile, source, sessionId, taskId, message }, where profile is the resolved storage directory. The filename is sha256(JSON.stringify([profile, source, sessionId])) + "-" + sha256(JSON.stringify([profile, source, sessionId, taskId])) + ".json". This binds the record to its profile/source/original parent/task and lets restoration select only the active parent's records. Copying a record to another profile does not restore it there.

Creation uses a random private temporary file, synchronous write/fsync, and an atomic hard-link publication that cannot replace an existing target. The temporary link is then removed. Repeated persistence of a pending stable ID keeps its first valid record. Filesystems without hard-link support report a write failure; the caller's in-memory notice remains available. Temporary files left by an interrupted write are ignored, not replayed or swept.

Directories are created with mode 0700 and records with 0600. Existing nonprivate/unowned POSIX directories or files are refused, not chmodded. Symlinks and nondirectory ancestors are rejected; records must be regular owned private files. Reads use no-follow flags where supported, descriptor identity checks, bounded buffers, JSON validation, and filename/identity validation. Invalid or foreign matching records remain untouched and fail the flush. Unrelated source/parent/profile filenames are ignored. Only ENOENT is treated as an already-absent record; other filesystem errors propagate. Windows relies on the profile's inherited ACLs because Node's portable uid/mode checks do not establish Windows ownership/privacy.

## Delivery behavior

Memory cards retain their source formatting and grouped IDs. Their covered disk records are suppressed; disk-only notices restore as individual cards. Repeated memory groups/subsets covering a single earlier card share its acknowledgment callbacks. Partially overlapping opaque groups are rejected before sending because the helper cannot safely split their preformatted content. Integrations should provide disjoint groups.

Flushes batch all sources sharing the current profile and parent; steering remains deliverAs: "steer" and only the last card requests a continuation. Idle scheduling remains 50 ms; flush(false) remains available for a busy boundary. Sends are checked against the current registered source before each card. After send returns synchronously, covered records are validated/removed and existing memory callbacks run. A thrown send retains that card and the remaining batch. Disk-only records have no callback to revive after restart. Deletion errors propagate before memory callbacks run. Explicit flush errors reach the caller; scheduled flush errors are reported through console.error and retain rejected records.

No exactly-once guarantee: sendMessage returns void, so a crash after send but before deletion can replay a notice, while a later asynchronous host failure after deletion can lose the handoff. There is no permanent delivered-ID ledger or power-loss transaction. The parent integration separately preserves output paths referenced by pending durable notices.

## Validation

Focused tests cover process-global/source loss, a real two-process Node restart, source/parent/profile isolation, grouped-memory/disk deduplication, accepted-vs-failed sends, duplicate persistence, malformed/foreign/oversized records, symlink paths, private POSIX ownership, write/fsync/publication/removal failures, scheduled-error reporting, reload staleness, and reentrant sends. Existing shared batching/idle/busy tests remain unchanged.

- `npm exec --workspace subagent -- vitest run src/completion-delivery.test.ts src/completion-delivery-durable.test.ts`: 29 passed, 1 POSIX-only ownership/permission test skipped on Windows. The real two-process restart test passed.
- `npm exec --workspace subagent -- tsc --noEmit --noUnusedLocals`: passed.
- `npm exec --workspace background-terminal -- tsc --noEmit --noUnusedLocals`: passed.

The full integration suites were left to the parent while its integration edits were in progress. No commits or global settings/environment writes were made.
