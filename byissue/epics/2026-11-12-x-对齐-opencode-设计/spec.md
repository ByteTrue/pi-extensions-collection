---
kind: epic
title: "对齐 opencode 的扩展设计"
created: 2026-11-12
---

# 对齐 opencode 的扩展设计

## 要改变什么

把本仓 5 个扩展现有的模型可见契约，逐项对照 opencode 源码的设计思路，补齐或改掉不一致的地方：

- `ask-user` ↔ opencode `question`
- `bash-timeout` ↔ opencode `shell` 的超时语义
- `background-terminal` ↔ opencode `shell` 的后台执行、结果与完成通知
- `subagent` ↔ opencode `subagent` 与 subagent completion
- `goal` ↔ opencode goal plugin

对齐对象是**模型看得到的部分**：工具描述与参数、工具结果文本、完成通知的格式与内容、错误文案、循环护栏、持久化与恢复语义。内部实现架构不搬：opencode 的 Effect service、permission、job registry、plugin storage 在 pi 扩展里没有对应设施。

`context-prune` 与 `auto-compact` 不在边界内（用户原话，2026-11-12）。

## 为什么现在做

这些扩展最初是照一段功能描述写的，没有系统对照过头部开源 agent 客户端。opencode 已把同类能力打磨到 v2，直接读源码比重新设计便宜。

用户原话（2026-11-12）：

> 本仓库这些扩展其实本质上都是为了补齐 pi 中一些没有的，但是 agent 客户端中普遍有的那些好用的能力。…这次我想直接对齐头部开源 agent 客户端 opencode 来完善我们的扩展。…先把 opencode 源码拉到隔壁 reference 目录，然后我们逐个扩展去对齐 opencode 的源码，参照 opencode 源码的设计思路来对齐我们的扩展（那两个 context 和 compact 的扩展不需要对齐）

## 参照物

- 源码：`/Users/zijie/workspace/reference/opencode`
- 版本：dev HEAD，commit `2c1e17b58173f3a14c927b427d3778a2fadb2f31`（2026-11-11，package version 2.2.7），包含 #63382「always run subagents in the background」。
- 选择：用户 2026-11-12 确认以最新 dev 的「subagent 永远后台」为准。本机 `@opencode/cli` 2.2.7 release 早于 #63382，仍有 foreground/background，不作为对齐目标。
- 台账开头的列举命令可以重跑，换版本时整张表要重列。

## 已定方案与必须守住

- **只对齐模型可见契约。** 不把 opencode 的内部架构（Effect、permission service、job registry、plugin storage）搬进 pi 扩展。opencode 依赖这些设施的地方，在 pi 里找不到对应物时标 `不适用`，不造替代框架。
- **保留 pi 超集能力。** `ask_user` 的多问题回退、`subagent` 的 plain child / `subagent_status` / `subagent_stop` / `resume`、`background-terminal` 的 `background_status` / `background_kill` 都是 pi 侧已有的能力，不回退成 opencode 的窄接口。
- **工具名不变。** 根 `pi.extensions` 里已注册的名字是全局唯一约束的一部分，改名会破坏现有会话与配置。
- **不新增运行时依赖。** `ask-user`、`bash-timeout`、`goal` 保持单文件、零运行时 import；其余扩展不得为了对齐新增第三方依赖。
- **完成通知采用 opencode 的结构化标签。** 后台命令与 subagent 的完成消息用 `<shell …>` / `<subagent …>` 标签包住，正文带结果内容，不再只给输出文件路径。
- **目标视为不可信数据。** `goal` 的 objective 一律包进 `<untrusted_objective>` 并声明它不是高优先级指令；模型自己 draft 的 objective 也可能来自仓库内容，不能当系统指令执行。
- **提交前跑全量 `npm test` 与 `npm run typecheck`。** 行为变化同步改对应目录的 `README.md`。
- **`bash-timeout` 全量对齐 opencode 的 shell 超时语义**（用户 2026-11-12 确认，选择了「全量对齐」）：默认 120s，显式 `timeout: 0` 关闭超时，显式更大的值不再压回上限，300s 硬上限移除。`background_run` 仍是长任务的去处。
- **`background-terminal` 的后台任务默认无寿命上限**（用户 2026-11-12：对齐；「只要确保 pi 退出的时候能清理掉不要留僵尸进程」）。显式 `timeout` 仍然生效，但不再有 8 小时硬顶；Pi 会话退出时杀掉全部任务。
- **`subagent` 的 `agent` 必填，删除 plain child**（用户 2026-11-12：D8 对齐）。省略 `agent` 将报错并列出可选角色。
- **扩展之间允许为体验做进程内耦合**（用户 2026-11-12：「反正都是我们自己的扩展集合，这个耦合对体验的提升我觉得可以做」）。用于 `goal` 判断本会话是否还有后台任务在跑（E6），以及 subagent 完成通知列出仍在运行的后台工作（D10）。耦合必须可选：对方扩展没加载时读不到，就退回当前行为。
- **`ask-user` 的多选改成真多选**（用户 2026-11-12 指出：opencode 可以连续勾选后一起提交，我们是勾一个提交一个）。TUI 里用 `ctx.ui.custom` 实现空格切换、回车提交、Esc 取消；RPC 没有自定义组件时退回现有的勾选循环。用户 2026-11-12 选择「四项全删」，批次复核页不再保留，逐题作答 + 回退。
- **`subagent` 的 `resume` 只能续本会话创建的子会话**（D11）。当前只校验 id 形状，模型可以传父会话 id。校验失败时报错，不启动子进程。
- **`goal` 重启后暂停**（E9，用户 2026-11-12 确认对齐 opencode）：state 里记进程 boot id，`session_start` 发现不是本进程写的 active goal，就标 paused 并写原因。
- **D10 的实现形态**（用户 2026-11-12 确认按建议）：subagent 完成通知里列父会话仍在运行的后台工作，并注明子进程自己的后台任务已随退出停止。子进程的寿命模型不改。

## 统一语言

- **对齐项**：台账里的一行，对应 opencode 源码里一个可观察的设计元素（一个字段、一段结果文本、一种状态处理）。
- **超集**：pi 侧保留但 opencode 没有的能力；台账里标 `不做` 或 `做了` 都要说明它没有被对齐项挤掉。
- **模型可见契约**：工具 description / parameters / result text / completion message / error text，以及影响模型判断的循环护栏。

## 可推进与暂不推进

可推进：台账 `U1`–`U5` 五个单元，每个单元是一个扩展。

暂不推进（已识别的 opencode 能力，pi 侧没有对应设施）：

- opencode 的 permission / deny 流程。
- job registry 的跨进程恢复（`shell.handoffPrepared` / `reattach`）。
- opencode 的 LLM goal judge（pi 扩展 API 没有生成入口）。
- 运行中的 subagent 接收 follow-up（子进程是 `pi -p`，一个进程只处理一个 prompt）。
- `experimental.subagent_depth` 的可配置嵌套深度（pi 侧用 `PI_SUBAGENT_CHILD` 硬防递归）。

这些在台账里逐行标 `不适用` 或 `不做`，写清理由。

## 审查与修复

2026-11-12 做了三路只读审查（对抗性、正确性、过度设计），修掉的 P1/P2：

- subagent：子进程 journal + 启动时 `reapSubagentOrphans`，回收 SIGKILL/crash 遗留的子 `pi` 进程组；session shutdown 等待子进程也加 5s 超时，超时后留给下次启动回收；tool execute 剥掉未声明的 raw `id`（不能再用 `--session-id` 打开父会话）；`--name` 只给新会话；暂停通知/菜单的 resume 调用补齐 `agent`+`description` 并使用 child session id；notice 记录 launch 时的 sessionId、保留输出空白；D10 注册表项用 child session id + agent 标签；`/reload` 的通知走进程级 callback holder（不再 pin 旧 manager 实例）。
- goal：continuation 带上 `<untrusted_objective>`，修 `goal_start` 中途建 goal 时后续循环没有 objective；`turn_end` 让后台通知进入 goal 的下一轮；有后台工作在跑时 hold 到它报告，没有 30 分钟定时器（用户「四项全删」）；resume 计 1/50；`continuationInjected` 在 `agent_settled` 清零；旧版本 `boot=""` 用独立暂停原因；`goal_start` 不再在工具 execute 里改 active tools；阻塞文案不再承诺立即暂停。
- background-terminal：`background_kill` / `/background` 停止现在发 `state="killed"` 的完成通知；通知上限改成实际可达的 50 行 / 4000 字符；修 51 行无尾换行时丢首行且无标记；notice/status 剥 ANSI/控制字符；`timeout` 在 pi 平台上限处 clamp；orphan sweep 从 24 小时放宽到 7 天；新增任务 journal + 启动时 `reapOrphans`，回收 SIGKILL/crash 遗留的进程组和日志；session shutdown 等待 kill 加 5s 超时，超时后留给下次启动回收。
- ask-user：RPC fallback 始终提供 `✓ Done (0 selected)`（空选 = Unanswered）；删掉 write-only 的 `wasFreeform`；复核页和 `details.answers` 按「四项全删」删除。

两项既有问题已在本轮修掉：subagent `timeoutMs` 在 `resolveRunCfg` clamp 到 2,147,483,647 ms；background-terminal 与 subagent 的 session shutdown 等待都加了 5s 超时。

## 未确认问题

无。

2026-11-12 用户确认不做：A9（所有问题同屏分页）、A13（选项 description 必填）、D17（字段叫 `prompt`）、D18（续聊参数叫 `sessionID`）、D5（subagent 持久子会话/运行中 follow-up）。用户选择「四项全删」：ask-user 批次复核页（A8）、结构化 `details.answers`（A12）、goal 30 分钟 shell 等待定时器（E19）、goal 会话命名与去引号（E12/E13）。项目级 `.pi/agents/*.md` 的 trust gate 已加上（untrusted 项目忽略项目文档，用户/global 文档仍加载）。

## 验证

真实 `pi`（默认模型 `bytetrueapi/deepseek/deepseek-flash`，隔离 session 目录）跑过的探针：

- `bash-timeout`：`timeout: 0` + `sleep 3` 成功（若 hook 不删 0，pi 会报 Invalid timeout）；把临时副本的默认值改成 2s 后，`sleep 5` 在 2s 超时并带 steering；显式 `timeout: 5` 在 2s 默认下仍跑满 3s，证明没有压回默认。
- `background-terminal`：`background_run` 启动 `sleep 5; echo alive > probe`，不传 timeout；pi 退出后等 8s，探针文件不存在，说明 session 退出清理生效。启动结果包含 `status: running`、无寿命上限和不要轮询的说明。
- `goal`：system section 里的 objective 是转义后的内容，`</untrusted_objective>` 没有提前闭合。4001 字符的 objective 没有创建 goal。进程被 kill 后，下一次用同一 session 启动把 goal 恢复为 paused，原因是 “the Pi process restarted while the goal was active”。goal 运行时另有一个 `sleep 20` 后台任务，settle 后 goal 仍是 active、没有 continuation（当时还看到 `waitingSince`；30 分钟定时器后来按「四项全删」删除）。
- `subagent`：真实子会话文件头部的 `session_info.name` 是 `description` 的值 `name probe`；子会话第一条 user 消息以 `You are a subagent spawned by another session.` 开头；`resume` 传父会话 id 被拒绝，报 “only subagent sessions … (id starting with sub_)”。审查后补测：tool input 里塞未声明的 `id: "id-probe-parent"`，真实工具结果仍是新生成的 `sub_b70b…`，没有把父会话当子会话打开。
- `/goal Probe continuation objective` 的真实 continuation entry 里出现 `<untrusted_objective>Probe continuation objective</untrusted_objective>`，修掉了 `goal_start` 中途建 goal 时后续循环没有 objective 的问题。
- 真实 SIGKILL 回收（background-terminal）：RPC pi 启动 `sleep 30` 后 `kill -9` 父 Pi，任务 pid 仍存活；用同一扩展启动下一个 pi，`reapOrphans` 杀掉任务组并删除 journal/pid/start/log，任务 pid 不再存在。
- 真实 SIGKILL 回收（subagent）：RPC pi 用 fake `PI_CLI_JS` 启动一个 sleep 的子 `pi`，`kill -9` 父 Pi；子 pid 仍存活；下一个 pi 加载 subagent 扩展后杀掉子进程组并删除 journal/start，子 pid 不再存在。
- 完成通知（RPC 长会话，`RpcClient`）：`background_run` 的 `sleep 3` 结束后收到 `<shell id state="completed" command="...">`，正文是 `notice-ok`、`Exit code: 0` 和完整输出路径，并触发了下一轮。subagent 的完成通知是 `<subagent sessionID state description>`；另跑一次「父会话先 `background_run sleep 20`、再启动 subagent」，通知里出现 `Background work still running:` 和 `- shell (bg_…): sleep 20`，验证了 D10 的注册表读取。

没有真实跑到的部分：

- `ask-user` 的 TUI 多选和 Esc 行为——需要你看界面；单测用模拟按键覆盖。
- goal 的 50 轮上限、3 次空转——单测用纯函数覆盖；真实长跑不现实。
- 真实 `--reload` 后 goal 的等待计时恢复——逻辑有单测，未在真实 TUI 触发。

## 关闭条件

1. 台账每一行是 `做了` / `不做` / `不适用`，带证据。
2. 5 个扩展的 `README.md` 与根 `README.md`（若行为摘要变化）同步。
3. `npm test` 与 `npm run typecheck` 通过。
4. `byissue/spec/index.md` 补上仍然成立的新行为；需要拍板的取舍立 decision。

## 合并候选

- `byissue/spec/index.md`「做 / 不做」：补一条「扩展的模型可见契约以 opencode 同类能力为参照」。
- `byissue/spec/index.md` 关于 `ask-user` / `goal` / `subagent` / `background-terminal` 的一句话描述，按最终行为更新。

## 推进视图

单元与状态以同目录 [`ledger.md`](./ledger.md) 为准。`U1`–`U5` 各自是一个可在一个会话内完成并验证的切片；每个单元结束时该扩展测试与 typecheck 通过。
