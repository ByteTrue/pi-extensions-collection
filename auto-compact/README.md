# auto-compact

One context rule for Pi: a model whose context window is larger than 400k tokens
compacts once the context passes 400k, instead of Pi's default
`window - reserveTokens`. Models with a smaller window are not touched; Pi's own
compaction policy applies there.

Compaction itself stays Pi's own: synchronous, on the current model. This
extension only decides when to start it for large windows, and registers no
tools, commands, or prompt sections.

The check runs at the final `agent_settled` boundary, not after every automatic
continuation. A continuous goal loop therefore keeps Pi's default compaction
policy until the loop stops; the 400k rule is not a hard per-turn limit. Aborted
runs do not trigger compaction.

## Install

Part of [pi-extensions-collection](../#install):

```bash
pi install git:github.com/ByteTrue/pi-extensions-collection
```

Pi reads the root manifest and loads it. To drop it on one machine, run `pi config`
and toggle it off; nothing is deleted.

## Interaction with other extensions

It registers no tools, so it conflicts with nothing. Keep it when
`context-prune` is replaced by `@cortexkit/pi-magic-context`: the 400k rule is
useful whatever does the pruning.
