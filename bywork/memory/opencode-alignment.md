# 模型可见契约对齐 opencode

## 结论

- 本仓扩展补齐 Pi 缺少、agent 客户端普遍有的能力。模型可见契约（工具描述与参数、结果文本、完成通知、错误文案、循环护栏、持久化与恢复语义）以 opencode 同类能力为参照；内部架构（Effect、permission、job registry、plugin storage）不搬，pi 没有对应设施的位置标「不适用」，不造替代框架。
- `auto-compact` 不在对齐范围（用户 2026-11-12 明确排除，当时一并排除的 `context-prune` 已删除）。
- 保留 pi 超集能力，不回退成 opencode 的窄接口：`ask_user` 多问题回退，`subagent_status` / `subagent_stop` / `resume`，`background_status` / `background_kill`。工具名不变，改名破坏现有会话与配置。
- 对齐落定的关键行为（2026-11-12/13 用户逐项确认，已实现）：`bash-timeout` 默认 120s、显式 `timeout: 0` 关闭、更大值不压回；`background_run` 默认无寿命上限，Pi 退出清理；`subagent` 的 `agent` 与 `description` 必填，内置角色只剩 `general` 与 `explore`，触发句与 explore prompt 从 opencode `packages/core/src/plugin/agent.ts` 原样复用；`resume` 只接受本扩展创建的 `sub_…` 会话；`goal` 的 objective 包 `<untrusted_objective>` 并转义、上限 4000 字符，50 轮、连续 3 次无工具调用暂停，重启后恢复为 paused。
- 明确不做（用户 2026-11-12 拍板）：所有问题同屏分页（A9）、选项 description 必填（A13）、字段叫 `prompt`（D17）、续聊参数叫 `sessionID`（D18）、subagent 持久子会话与运行中 follow-up（D5）。「四项全删」：ask-user 批次复核页（A8）、结构化 `details.answers`（A12）、goal 30 分钟 shell 等待定时器（E19）、goal 会话命名与去引号（E12/E13）。
- pi 侧没有对应设施、暂不推进：permission/deny 流程、job registry 跨进程恢复、LLM goal judge（扩展 API 没有生成入口）、运行中 subagent 接收 follow-up（`pi -p` 一个进程只处理一个 prompt）、可配置嵌套深度（用 `PI_SUBAGENT_CHILD` 硬防递归）。

## 依据

- 类型：用户决定 + 逐项实现台账。
- 参照物：`/Users/zijie/workspace/reference/opencode`，dev HEAD commit `2c1e17b58173f3a14c927b427d3778a2fadb2f31`（2026-11-11，package version 2.2.7，含 #63382「always run subagents in the background」）。本机 `@opencode/cli` 2.2.7 release 早于 #63382，不作为对齐目标。换参照版本时台账要整张重列。
- 逐项结论与证据：`archive/byissue/epics/2026-11-12-x-对齐-opencode-设计/spec.md` 与同目录 `ledger.md`（每行 做了/不做/不适用 + 证据）。行为差异同时写在各扩展 `README.md`。
- 用户原话（2026-11-12）：「这次我想直接对齐头部开源 agent 客户端 opencode 来完善我们的扩展……那两个 context 和 compact 的扩展不需要对齐」。

## 重访条件

opencode 参照版本升级、或 Pi 提供了 permission / 生成入口 / 子会话 follow-up 设施时，重列「不适用」各行。新的模型可见行为先对照 opencode 再自创。