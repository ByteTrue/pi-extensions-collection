# 对齐台账

接着做或改这张表之前，先读同目录 `spec.md` 的「已定方案与必须守住」。

## 枚举来源

参照物固定为 opencode v2.2.7，commit `2c1e17b58173f3a14c927b427d3778a2fadb2f31`。

```bash
REF=/Users/zijie/workspace/reference/opencode
git -C "$REF" rev-parse HEAD
rg -n 'export const name = ' "$REF/packages/core/src/tool/plugin/"{question,shell,subagent}.ts
rg -n 'export const description|export const Input|export const Output' "$REF/packages/core/src/tool/plugin/"{question,shell,subagent}.ts
rg -n 'DEFAULT_TIMEOUT_MS|background|timeout' "$REF/packages/core/src/tool/plugin/shell.ts"
sed -n '1,120p' "$REF/packages/core/src/shell/result.ts"
sed -n '1,80p' "$REF/packages/core/src/session/subagent-completion.ts"
sed -n '1,220p' "$REF/packages/core/src/plugin/goal.ts"
ls "$REF/packages/core/src/plugin/goal"
```

台账行是人从这些文件里读出来的设计元素，不是脚本自动生成；换 opencode 版本时整张表重列。

## 结论取值

- `没做`：初始值。
- `在做`：单元开工时。
- `做了`：证据写命令、测试名或 commit。
- `不做`：写清是谁定的（用户原话或 decision）。
- `不适用`：没有运行时行为的项，写理由。

## 台账

| 项 | 单元 | 结论 | 证据 |
|---|---|---|---|
| **ask-user ↔ question** | | | |
| A1 答案文本用 `User has answered your questions: "q"="a", … You can now continue with the user's answers in mind.`（question.ts:38-46） | U1 | 做了 | `formatAnswers`；`ask-user.test.ts` 27 passed |
| A2 多选答案保持每题一组、不拼成串；未答项显示 `Unanswered`（question.ts:96-108） | U1 | 做了 | `details.answers` 为 `string[][]`；空输入测试 |
| A3 工具描述带 opencode 式使用说明：自动追加自由输入、`multiple` 语义、推荐项放第一（question.ts:12-21） | U1 | 做了 | registration 测试断言 usage notes；`npm --workspace ask-user test` |
| A4 `header` 短标题与 `question` 分离（schema/question.ts:7-10） | U1 | 不适用 | pi 的 `ui.select` 只有 title + 行文本，没有第二块正文；把 header 当 title 会丢掉 question |
| A5 用户取消即取消工具调用（question.ts:87-95） | U1 | 不适用 | pi 没有「工具调用被取消」的结果类型；保留纯文本 dismiss，让模型回退散文 |
| A6 工具执行前 permission assert（question.ts:63-70） | U1 | 不适用 | pi 扩展没有 permission 服务 |
| A7 多选在同一对话框内连续勾选、最后一起提交（util/form.ts `formToggleMultiselect`；form.tsx confirm 页） | U1 | 做了 | TUI `ctx.ui.custom`：空格切换、回车提交；RPC 保留勾选循环。`ask-user.test.ts` 的 custom 测试覆盖 toggle、Other、Esc、空选 |
| A8 全部问题答完后统一复核/提交，可回到任意一题修改（form.tsx confirm tab） | U1 | 不做 | 用户 2026-11-12 选择「四项全删」：复核页已删除，保留逐题作答与回退 |
| A9 所有问题同屏分页（tab），而不是逐题弹窗 | U1 | 不做 | 拟：TUI 自定义组件能做到，但 RPC 只有 select/input 对话框，会失去 BySpace 的一致体验；逐题 + 统一复核是 pi 侧折中 |
| A10 空答案记为 `Unanswered`，不当作取消（form 校验里 question 字段没有 required） | U1 | 做了 | `collectFreeform` 区分 Esc（undefined）与空提交（""）；empty freeform 测试 |
| A11 选项标签 1-5 词、description 一行解释，并把约定写进工具描述（schema/question.ts:6-9） | U1 | 做了 | schema 描述与 tool description 的 usage notes |
| A12 答案以结构化 metadata 返回（question.ts:104-108） | U1 | 不做 | 用户 2026-11-12「四项全删」：删除无人消费的 `details.answers` |
| A13 每个选项的 `description` 必填（schema/question.ts:6-9） | U1 | 不做 | 拟：pi 的 selector 把 description 拼在行尾，没有它选项仍可读；强制会让模型为琐碎选择补空话。A11 只在 schema 与工具描述里给出写法约定 |
| **bash-timeout ↔ shell 超时** | | | |
| B1 前台默认 2 分钟（shell.ts:26,333） | U2 | 做了 | `DEFAULT_TIMEOUT_SECONDS = 120`；真实 pi 用临时 2s 副本验证注入与超时，仓库默认值有单测 |
| B2 `timeout: 0` 显式关闭超时（shell.ts:61,333） | U2 | 做了 | 真实 pi：`timeout: 0` + `sleep 3` 成功（pi 会拒绝 0，hook 删除参数后跑的是无超时） |
| B3 显式超时值不设上限（shell.ts:333） | U2 | 做了 | 真实 pi：2s 默认下 `timeout: 5` 跑满 3s；另有单测 |
| B4 超时提示按 opencode 文案说明「需要更久就用更大超时」，保留 pi 的 background_run 指引（shell/result.ts:50-56） | U2 | 做了 | 真实 pi 超时结果带 steering；`TIMEOUT_STEERING` 单测 |
| B5 超时后自动转后台（shell.ts:401-440） | U2 | 不适用 | pi 内建 bash 超时直接杀进程，扩展拿不到活着的进程转后台 |
| B6 后台命令默认无超时（shell.ts:61-66） | U2 | 不适用 | 属于 background-terminal 的寿命策略，不属于本单元 |
| B7 超时单位：opencode 用毫秒，pi 内置 bash 用秒 | U2 | 不适用 | 参数单位由宿主工具定义，扩展只能沿用秒 |
| B8 在 shell 工具描述里说明默认超时与后台语义 | U2 | 不适用 | 内置 bash 的描述由 pi 提供，扩展改不了 |
| **background-terminal ↔ shell 后台** | | | |
| C1 启动结果写状态 `running`、任务 ID、可得时 PID、输出文件（shell.ts:105-121） | U3 | 做了 | 真实 pi 结果文本含 `status: running` + id + output path；PID 不暴露，见 C10 |
| C2 启动结果写明不要轮询、等待完成通知（shell.ts:30-31,88） | U3 | 做了 | 真实 pi 结果文本与 `background_run` 指南 |
| C3 完成通知用 `<shell id state command>` 包住，正文带输出（shell/result.ts:75-93） | U3 | 做了 | 真实 RPC 会话收到 `<shell … state="completed">` 通知；notice-format 测试 |
| C4 通知里的输出有界，取尾部若干行而不是整份文件（shell/result.ts:33-48 的截断思路） | U3 | 做了 | 真实 RPC 通知正文带输出；50 行 / 4000 字符 + `[earlier output omitted]` 单测（含 51 行无尾换行与 ANSI 清理） |
| C5 后台任务默认无寿命上限（shell.ts:61-66） | U3 | 做了 | 真实 pi：无 timeout 的 `sleep 5` 任务，pi 退出后探针未写入；真实 SIGKILL 下任务存活，下一次 pi 启动由 journal reaper 杀掉；单测覆盖 session 退出清理 |
| C6 服务重启后接管仍在跑的后台命令（shell.ts:218-248） | U3 | 不适用 | pi 的子进程随 Pi 进程退出，没有 daemon handoff |
| C7 不提供 status / kill 工具（opencode 靠会话取消） | U3 | 不做 | 用户 2026-11-12 同意保留：pi 没有 job service，`background_status` / `background_kill` 是必要超集 |
| C8 非零退出/信号在通知里明确写退出码（shell/result.ts:50-63） | U3 | 做了 | 真实 RPC 通知含 `Exit code: 0`；单测覆盖 `Exit code: 3`；pi 的操作已把信号折成 128+n |
| C9 超时通知提示不要另起一份同样的命令（shell.ts:114） | U3 | 做了 | 单测断言 `state="timed_out"`、`Timed out after 1 seconds`、`Do not start another copy` |
| C10 启动结果里的 PID | U3 | 不适用 | pi 的 `BashOperations.exec` 只返回 exitCode，不暴露 pid |
| C11 进程内后台工作注册表，供 E6 / D10 读取本会话运行中的 shell 与 subagent | U3 | 做了 | `registerBackgroundWorkProvider` / `runningBackgroundWork`；registry 测试 |
| C13 SIGKILL/crash 后的孤儿任务回收 | U3 | 做了 | 任务 journal（owner/task pid/start）+ 启动 `reapOrphans`；真实 SIGKILL 探针；`reap.test.ts` |
| C12 把 `background` 参数合并进同一个 shell 工具（shell.ts:63-66） | U3 | 不适用 | pi 的内置 bash 不能加参数，也无法覆盖；独立 `background_run` 是 pi 侧唯一可行形态 |
| **subagent ↔ subagent** | | | |
| D1 增加 `description`（3-5 词短标签，必填）用于通知、任务列表与子会话标题（subagent.ts:34） | U4 | 做了 | schema required；`--name` 传入；launch 测试断言 `--name` |
| D2 结果与指南补「不要 sleep/poll、避免同文件、做非重叠任务」（subagent.ts:18-27） | U4 | 做了 | tool description / guidelines / result 文本 |
| D3 完成通知用 `<subagent sessionID state description>` 包住（subagent-completion.ts:53-74） | U4 | 做了 | 真实 RPC 会话收到 `<subagent sessionID=… state="paused" description="…">`；notice shape 测试 |
| D4 无 `description:` 的角色在 roster 里用默认触发句（subagent.ts:262-270） | U4 | 做了 | `buildAgentRosterText` 默认句 |
| D5 运行中的子会话接收 follow-up 并加入当前 run（subagent.ts:147-208） | U4 | 不做 | 用户 2026-11-12 确认不做：不重写持久子会话/运行中 follow-up；子进程仍是 `pi -p`，只能结束后 resume |
| D6 默认递归深度 1（subagent.ts:117-133） | U4 | 做了 | 已有 `PI_SUBAGENT_CHILD` 硬防递归（index.ts 入口），本单元核实；subagent 93 tests passed |
| D7 工具暴露 `model` 覆盖（subagent.ts:36-39） | U4 | 不做 | 用户 2026-11-12 同意：模型选择留在用户侧 settings / 角色文档 |
| D8 `agent` 必填、拒绝 primary agent（subagent.ts:134-137） | U4 | 做了 | schema required；normalizeTask / resolveAgentRole 报错；plain child 路径删除；测试 |
| D9 启动前 permission assert（subagent.ts:138-145） | U4 | 不适用 | pi 扩展没有 permission 服务 |
| D10 完成通知附「仍在运行的后台工作」（subagent-completion.ts:37-51） | U4 | 做了 | 真实 RPC：父会话 `background_run sleep 20` 期间 subagent 完成，通知列出 `- shell (bg_…): sleep 20`；notice shape 测试 |
| D11 `resume` 只允许续本会话创建的子会话（subagent.ts:158-161） | U4 | 做了 | 真实 pi 传父会话 id 被拒；tool execute 也剥掉未声明的 raw `id`；只接受 `sub_` 前缀；`--session-id` 会话不记录 parentID，无法做精确父子校验；byte6 测试 |
| D12 新子会话 prompt 前置 `You are a subagent spawned by another session.`（subagent.ts:205-207） | U4 | 做了 | 真实子会话第一条 user 消息以该句开头 |
| D13 空结果回退 `Subagent completed without a text response.`（subagent-completion.ts:9,24-33） | U4 | 做了 | formatter；notice shape 测试（真实通知有输出，未触发回退） |
| D14 子会话标题用 `description`（subagent.ts:181-186） | U4 | 做了 | 真实子会话 `session_info.name` 为 description；launch 测试 |
| D15 工具结果返回 sessionID + `status: running` + 等待说明（subagent.ts:18-27,224） | U4 | 做了 | 工具 result 文本 |
| D16 角色名册按 permission 过滤并在每次请求时动态追加（subagent.ts:247-274） | U4 | 不适用 | pi 的工具描述在注册时固定，也没有 permission 系统 |
| D17 输入字段叫 `prompt`（subagent.ts:35） | U4 | 不做 | 拟：pi 侧既有字段是 `task`，改名会破坏现有调用与文档；语义相同 |
| D18 续聊参数叫 `sessionID`（subagent.ts:40-42） | U4 | 不做 | 拟：pi 侧用 `resume`；工具结果与通知里已经返回 child sessionID，语义可对应 |
| D19 工具声明结构化 `Output` schema（subagent.ts:45-49） | U4 | 不适用 | pi 的工具结果是 text + details，没有 declared output schema；结构化指针放在 details 里 |
| D20 SIGKILL/crash 后的子进程回收 | U4 | 做了 | 子进程 journal（owner/child pid/start）+ 启动 `reapSubagentOrphans`；真实 SIGKILL 探针；`reap.test.ts` |
| **goal ↔ goal plugin** | | | |
| E1 objective 包成 `<untrusted_objective>` 并声明是数据不是指令（goal.ts:439-449；kickoff.txt / continuation.txt） | U5 | 做了 | 真实 pi system section 已验证转义；continuation 也重复 objective，覆盖 goal_start 中途建 goal；goalSection 测试 |
| E2 objective 上限 4000 字符（goal.ts:15,388-391） | U5 | 做了 | `/goal` 与 `goal_start` 都拒绝；测试 |
| E3 轮次上限 50，超限暂停（goal.ts:16,154-155） | U5 | 做了 | `settleDecision` rounds 检查；测试 |
| E4 连续 3 次停滞才暂停（opencode 用 reason + 无工具；pi 没有 judge，只用「这次 continuation 没调工具」）（goal.ts:17,184-187） | U5 | 做了 | stalls 计数，第三次暂停；settleDecision + loop 测试 |
| E5 LLM judge 决定是否完成（goal.ts:104-136；judge.txt） | U5 | 不适用 | pi 扩展 API 没有模型生成入口；`goal_done` + evidence 是 pi 侧替代 |
| E6 judge 可回答 `wait`：自己的后台 shell 还在跑时暂不继续（goal.ts:159-180） | U5 | 做了 | 真实 pi：goal + 运行中的 `sleep 20`，settle 后 goal 仍 active 且无 continuation；有后台工作时 hold 到报告，无 30 分钟定时器（E19 删除） |
| E7 中断或 provider 失败时暂停（goal.ts:299-309） | U5 | 做了 | 已有 `settleDecision` 分支，测试覆盖 |
| E8 resume 重置轮次预算（goal.ts:364-381） | U5 | 做了 | resume 计 1/50（opencode 把 resume continuation 当第 1 轮），stalls 归零；测试 |
| E9 进程重启后把上次遗留的 active goal 标成 paused（goal.ts:20-24,314-341） | U5 | 做了 | 真实 pi：kill 后重开同一 session，goal 变 paused 并写重启原因 |
| E10 kickoff 用 synthetic 消息而不是用户消息（goal.ts:411-432） | U5 | 不做 | 用户 2026-11-12 同意：pi 用 `sendUserMessage` 启动一轮是原生方式，目标原文可见也有利于用户核对 |
| E11 目标不在上下文时在尾部补 reminder（goal.ts:220-231） | U5 | 不做 | 用户 2026-11-12 同意：pi 侧目标在 system prompt section，每次请求都在 |
| E12 `/goal "..."` 去掉成对引号（goal.ts:473-479） | U5 | 不做 | 用户 2026-11-12「四项全删」：删除 `unquoteObjective` |
| E13 启动时用 objective 命名会话，仅在会话还没有名字时，截 60 字（goal.ts:403-410） | U5 | 不做 | 用户 2026-11-12「四项全删」：删除会话命名 |
| E14 持久化暂停原因并在 `/goal` status 展示（goal.ts:71-83,460-463） | U5 | 做了 | 真实重启暂停写入了 reason；`describeGoal` 展示 |
| E15 启动/继续文本要求「验证并展示证据」，阻塞时明确说出（kickoff.txt / continuation.txt） | U5 | 做了 | `CONTINUE_MESSAGE` / `RESUME_MESSAGE` / goalSection |
| E16 进程 boot id 识别重启，旧 active goal 标 paused（goal.ts:20-24,314-341） | U5 | 做了 | 同 E9；`BOOT_ID` 固定在进程全局 |
| E17 goal state 的 id / updatedAt 做 stale-write 保护（goal.ts:61-69） | U5 | 不适用 | 扩展在单线程里顺序处理，没有并发写 |
| E18 `/goal` status 显示 runs/50 与暂停原因 | U5 | 做了 | `describeGoal` / `statusText` |
| E19 后台工作在跑时最多等 30 分钟，超时暂停（goal.ts:18-19,237-259） | U5 | 不做 | 用户 2026-11-12「四项全删」：删除 30 分钟定时器；goal 仍 hold 到后台工作报告 |
| E20 judge 的 reason / next_step 反馈进 continuation（goal.ts:189-202） | U5 | 不适用 | 没有 judge 生成 reason；用固定 CONTINUE_MESSAGE |
| E21 用户说 stop/pause/abandon 时暂停（judge.txt 规则） | U5 | 不适用 | 没有 judge 识别自然语言，只靠 `/goal pause`；解析用户文本容易误判 |
| E22 goal 状态存 plugin storage，用 RPC `get` / `changed` 同步（goal.ts:43-59） | U5 | 不适用 | pi 扩展没有 plugin storage / RPC；session transcript entry 是 pi 原生的持久化与分支恢复方式 |

## 接续点

无。5 个单元全部完成；全量 `npm test`（290 passed）与 `npm run typecheck` 通过。
