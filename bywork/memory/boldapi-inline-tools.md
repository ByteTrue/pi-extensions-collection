# BOLDAPI inline-tools 的 tool_removal 限制

## 结论

经本机 magpie 转发到 BOLDAPI（`ai-gateway.insta360.cn`）时，请求里 tools 有 6 个及以上，带 `tool_removal` 的请求一律 400，`error_code` 为 `tool_reference_unresolved`。tools ≤5 正常，`tool_addition` 任何数量都正常，removal 指向哪个 tool 不影响结果。判罚在托管上游，本地 magpie 源码 `internal/gateway/anthropic_shapes.go` 没有这条校验，本地改不了。

一条 `tool_removal` 写进会话转录后会一直重发，之后每个请求都 400，重试和补发消息救不回来，只能绕开或换 provider。绕过办法：`~/.pi/agent/models.json` 把 bytetrueapi 三个 anthropic 模型（`claude-fable-5-1`、`claude-opus-5-5`、`claude-sonnet-5-5`）的 `compat.supportsMidConvoToolChanges` 设为 `false`。pi-ai 随之折叠 system、tools 取当前集合，不再发 removal/addition；代价是工具集变化那一轮重写顶部 system 与 tools，丢一次 prompt cache。

## 依据

- 类型：外部观察（可重跑证明）。
- 最小复现：带 `anthropic-beta: inline-tools-2026-09-15`，tools 放 5 个空 schema，messages 为一条 user 加一条只含 `{"type":"tool_removal","tool":{"type":"tool_reference","name":"t0"}}` 的 system，返回 200；tools 加到 6 个，同一请求 400。
- 2026-11-09，Pi 1.5.0，本机 magpie 监听 3425；把受影响会话的 307 条消息重放，改配置后 0 个变更块、16 个 tool、网关 200。改动前配置备份在 `~/.pi/agent/models.json.bak-before-toolchanges`。
- 原文：`archive/byissue/notes/2026-11-09-boldapi-inline-tools-tool-removal.md`。

## 重访条件

上游修好后把三个模型的开关改回 `true`，并用 6 个 tool 的 removal 复测。排查「会话突然每个请求都 400、错误含 `tool_addition/tool_removal references unknown tool`」时先想到这里。