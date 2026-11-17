---
kind: note
title: "BOLDAPI 的 inline-tools 在 6 个以上 tool 时拒绝任何 tool_removal"
created: 2026-11-09
---

# BOLDAPI 的 inline-tools 在 6 个以上 tool 时拒绝任何 tool_removal

**结论：** 经本机 magpie 转发到 BOLDAPI（`ai-gateway.insta360.cn`）时，只要请求里的 tools 有 6 个及以上，带 `tool_removal` 的请求一律 400，`error_code` 为 `tool_reference_unresolved`。tools 在 5 个以内正常，`tool_addition` 在任何数量下都正常。

**何时用：** 排查 Pi 会话突然每个请求都 400、错误里出现 `tool_addition/tool_removal references unknown tool` 时；给这类 provider 写会在中途增删工具的扩展或配置时。

**细节：** 最小复现是带 `anthropic-beta: inline-tools-2026-09-15`，tools 放 5 个空 schema，messages 为一条 user 加一条只含 `{"type":"tool_removal","tool":{"type":"tool_reference","name":"t0"}}` 的 system，返回 200；只把 tool 加到 6 个，同一请求返回 400。removal 指向哪个 tool 不影响结果，指向第一个也失败。本地 magpie 源码 `internal/gateway/anthropic_shapes.go` 里没有这条校验，判罚在托管上游，本地改不了。

一条 `tool_removal` 一旦写进会话转录就会一直重发，之后每个请求都 400，重试和补发消息都救不回来，只能绕开或换 provider。绕过办法是 `~/.pi/agent/models.json` 里把 bytetrueapi 三个 anthropic 模型（`claude-fable-5-1`、`claude-opus-5-5`、`claude-sonnet-5-5`）的 `compat.supportsMidConvoToolChanges` 改成 `false`。pi-ai 会折叠 system 消息、tools 取当前集合，不再发 `tool_removal`/`tool_addition`，代价是工具集变化的那一轮重写顶部 system 与 tools，丢一次 prompt cache。

**依据：** 2026-11-09，Pi 1.5.0，本机 magpie 监听 3425，上游 `ai-gateway.insta360.cn`，用上面的最小请求实测；同一天把受影响会话的 307 条消息重放，改配置后 0 个变更块、16 个 tool、网关 200。改动前的配置备份在 `~/.pi/agent/models.json.bak-before-toolchanges`。

**相关：** `byissue/issues/2026-11-09-x-ff-goal-done-while-paused.md`。上游修好后把三个模型的开关改回 `true`，并复测 6 个 tool 的 removal。
