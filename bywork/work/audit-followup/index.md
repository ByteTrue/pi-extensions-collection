# 审查建议后续处理

后续用户又批准五项顺序修复与发布；最新状态见[五项后续记录](../five-followups/index.md)。下文保留本轮完成时的结果与边界，恢复性能、绝对路径续跑回收、通知持久化、输出背压和安装状态以后续记录为准。

2026-11-20，按用户批准的 R1–R13 建议完成实现与整合验证。改动叠加在前次全仓修复和通知批处理之上，尚未提交或安装到 Pi 管理的 checkout。已有的 `bywork/work/paseo-compat/` 保持原样。初次问题列表见[全仓审查记录](../repository-audit-2026-11-20/index.md)。

## 逐项处理结果

| 项目 | 本次处理 | 保留边界 |
| --- | --- | --- |
| R1 工具权限 | 保留现有 shell/工具选择，README 明确 `explore` 和 codemode 的能力边界。 | 工具 allowlist 不是安全沙箱；不可信任务需要进程外隔离，本次不新增沙箱。 |
| R2 续跑归属与并发 | 新子会话持久化父会话和原工作目录；续跑核验归属、原目录及 transcript，用排他文件锁防止本扩展跨进程并发写入，并传递精确日志路径给 Pi。 | 旧无归属记录仅供读历史；崩溃锁需确认父子进程退出后手工移除。直接 Pi CLI 不参与锁协议，跨父会话续跑未开放。 |
| R3 PID 复用与孤儿回收 | 两个扩展 journal 新增 OS owner 启动身份；只有确认 owner 已消失或身份不一致才进入子进程核验。未知身份/权限错误保守保留。subagent 同次回收缓存相同 owner 的身份查询；终止失败保留记录以便重试，外部查询/终止增加超时。 | Windows Job Objects 未实现；POSIX `ps lstart` 仍为秒级精度。绝对路径续跑在启动身份不可读时无法使用旧的 session-id 命令行回退。 |
| R4 headless goal 启动 | 启动或恢复前检查选定模型和已配置/可解析的认证；可检测失败暂停目标并抛错。先登记 settlement 等待者再派发，失败时清理，支持 keyless/virtual provider。 | 宿主无可等待的 dispatch 结果；输入被消费或检查后的异步失败仍可能没有 settled 事件。没有添加总时限。 |
| R5 问答选项与编辑器 | 打开任何题目前，整批拒绝重复 label、相互歧义的显示行以及 Other/Back/Done 保留行碰撞，错误指出题号和需修改的选项。 | TUI 编辑器没有关闭/取消 API；已打开时仍需 Esc，迟到答案会丢弃。 |
| R6 角色表与信任 | 静态工具描述只含全局/内置角色；每次 `before_agent_start` 依据当前 `ctx.cwd` 和信任状态提供最新角色表。执行入口缺少信任决定时不读取项目角色。 | 不动态重新注册工具；普通预算默认值的静态说明仍在 reload 后刷新。 |
| R7 角色配置继承 | 改为逐字段继承；缺省继承，显式值覆盖，`null` 跳过全局该角色字段，数组整体替换。菜单区分 Inherit 与 Use role document/default。 | 继承行为有变化，迁移方式见下节；不自动猜测或重写用户配置。 |
| R8 通知持久化 | 保留已完成的统一批量派发、会话隔离、reload 与发送失败重试。 | 队列仍在内存；不增加落盘消息系统，进程退出/崩溃可丢失未送达通知。 |
| R9 最低 Pi 版本 | 根包和五个工作区统一为 `>=1.5.0`；CI 增加最低版本维度和真实加载检查，保留 Windows/Ubuntu、未固定 Node。 | Pi 1.1.0 缺少实际使用的 `MessageRenderOptions.keyText`；未来版本允许安装，不代表均已验证。 |
| R10 历史实验数字（已结案） | context-prune 已删除；按用户 2026-11-20 的明确更正，从待办中关闭该项。 | 历史材料原样保留，不再追查数字或重启扩展。 |
| R11 旧导出别名 | 保留两行兼容别名。 | 删除收益低于破坏外部调用的风险。 |
| R12 日志预览与写入 | 菜单复用已有尾部格式器，只显示末 50 行且至多 4,000 字符，附完整路径、遗漏说明和 50 MiB 文件上限。 | 写入背压不作未经测量的改造；文件保存前 50 MiB，尾部预览继续更新。 |
| R13 Windows 支持与性能 | 明确原生 Windows 需要支持 `/proc/<pid>/winpid` 的 Git Bash/MSYS2/Cygwin Bash、系统 PowerShell 和私有用户临时目录。完成受控恢复耗时探针。 | 恢复仍同步；六条记录三次测量中位数约 3 秒。异步恢复、批量 OS 查询和 ACL 检查需单独设计。 |

## 升级与迁移

1. **子会话续跑**：新子会话的归属文件位于 `<child agent dir>/subagent-sessions/<id>.json`，锁为同目录 `<id>.lock`。续跑必须来自原父会话、子任务最初的目录及相同 child agent dir。旧会话历史不删除，但无法通过工具继续运行；可启动新子代理并提供必要上下文。崩溃后只在确认父子进程均已退出时，按错误给出的完整路径删除对应 `.lock`。
2. **角色继承**：例如全局 `explore` 有 model/tools/maxTurns，项目只配置 thinking，现在其他字段会继承全局。希望某字段恢复角色文档/默认链时写 `null`；删除字段或选择 Inherit 才是继承全局。空 model/thinking 字符串也表示显式清空。`tools: []` 表示无普通工具，`tools: null` 表示角色文档/default。详见[继承与迁移](./inheritance.md)及 [subagent README](../../../subagent/README.md)。
3. **宿主最低版本**：Pi 1.5.0 起支持本包；消费端没有精确版本锁定。当前改动仍在维护用工作区，提交并经官方安装/更新流程分发后才会影响已安装包。更新前让任务结束，再重新启动 Pi。

## 验证

最终 `npm test` 在 Windows / Node v26.13.0 上通过：

| 检查范围 | 通过 | 跳过 |
| --- | ---: | ---: |
| 安装清单夹具 | 7 | 0 |
| ask-user | 62 | 0 |
| background-terminal | 93 | 8 |
| bash-timeout | 11 | 0 |
| goal | 69 | 0 |
| subagent | 182 | 4 |
| 合计 | **424** | **12** |

跳过项包含 Windows 不适用的平台用例，以及一个需显式启用的恢复性能探针。比通知批处理完成后的 349 个通过用例增加 75 个。

- 五个工作区 `tsc --noEmit --noUnusedLocals` 全部通过；安装清单核对五个入口通过；`git diff --check` 通过。
- 上述完整测试及类型检查使用的本地 `pi-coding-agent`、`pi-ai`、`pi-tui` 均为 1.5.0，已独立确认实际版本。
- 最终源代码分别通过 Pi 1.5.0、已安装的 1.6.0 SDK 真实加载检查：五个扩展、八个工具、三个命令，无加载错误。1.6.0 此项验证范围为加载/注册。
- 干净临时目录中的 `npm ci` 成功；lockfile 已有依赖解析版本未改变。详见[兼容性证据](./compatibility.md)。
- 回归检查覆盖跨进程锁争用、父会话/目录越权、未知历史、锁替换、真实新建后续跑、SDK 工作目录/信任变化、owner PID 复用、权限探测失败、角色继承与清空、选项歧义、goal 启动失败和有界日志预览。
- 额外复现并修复 subagent 终止失败仍删除 journal 的问题：新增用例先失败，修复后随全仓检查通过。
- 最终综合日志：`C:/Users/byte/AppData/Local/Temp/background-terminal/bg_0257d8c16ddde312.log`。

未在本机执行 Linux/macOS、真实模型驱动的 TUI/RPC、远端 BySpace 或 Paseo 桌面端到端流程。Ubuntu 覆盖由 CI 配置提供，尚未运行远端 Actions。

## 仍需宿主支持或另行决定

- **goal 无 settled 与编辑器取消**：扩展内可检测部分已修复；剩余依赖可等待的 dispatch 结果及 editor close API，详见[问答与 goal 记录](./dialog-goal.md)。
- **Windows 进程生命周期**：严格覆盖所有后代需要 Job Objects 等支持；身份不可核验时保持不终止。
- **恢复性能与输出背压**：受控探针六条记录为 2,978.6 / 3,177.8 / 2,883.0 ms；每条两次真实 PowerShell 查询，终止操作被 mock，未测磁盘慢写和端到端启动。同步恢复存在可见延迟；数据及复跑配方见[后台处理记录](./background.md)。
- **跨进程通知可靠性**：持久化通知未扩展。context-prune 历史实验问题已结案，不再等待原始证据。

以上边界均保留在当前 README/记录中；没有新增沙箱、Windows Job Objects、通知数据库或通用锁框架。

## 闭环复核（2026-11-20）

用户追问是否仍有未处理问题后，对照源代码、安装目录及当前工作记录复核。

- **补修一个遗漏**：`subagent/src/index.ts` 的旧分支会删除超过七天、身份未核验的存活子进程记录。现在只有已读取到双方启动身份、证明 PID 被复用的旧记录才可按该规则清理；查询失败或缺少身份时保留重试依据。`subagent/src/reap-failures.test.ts` 新增三个用例，其中两个在旧代码上失败；修复后子代理工作区 **185 通过、4 跳过**，类型检查（含 noUnusedLocals）和 `git diff --check` 通过。该轮只重跑受影响工作区，上节 424/12 保留前一次完整全仓运行的结果。日志：`C:/Users/byte/AppData/Local/Temp/background-terminal/bg_2d64b500a300d975.log`。
- **交付仍未完成**：代码尚未提交、推送或更新安装。当前配置指向 `git:github.com/ByteTrue/pi-extensions-collection`；检查 `C:/Users/byte/.pi/agent/git/github.com/ByteTrue/pi-extensions-collection` 确认安装目录没有 `shared/completion-delivery.ts`，且 `subagent/src/index.ts` 与本工作区不同。仅 reload 不会加载这份未提交的工作区代码。需通过开发加载方式验证，或完成分发后更新安装并重新启动。
- **实际运行验收（按用户要求暂缓）**：远端 CI、Linux/macOS 实机、真实模型 TUI/RPC、远端 BySpace、Paseo 桌面回放未验收。通知合批的真实宿主离线探针只运行过 Pi 1.6.0；Pi 1.5.0 虽通过全仓测试和加载，真实宿主通知顺序仍未测。
- **goal 的遗漏观察**：运行中更换或清除目标后，已开始的模型请求可能保留旧目标 system section；原审查记为未复现观察，仍不作为确认缺陷。headless 等待除缺失 settled 外，宿主认证解析本身也可能一直 pending，见[goal 记录](./dialog-goal.md)。
- **外部 BOLDAPI 限制**：当前 memory 记录的 2026-11-09 实测中，至少六个工具加 `tool_removal` 会导致 HTTP 400 / `tool_reference_unresolved`；已有 `supportsMidConvoToolChanges: false` 配置绕过，工具集变化时会损失一次 prompt cache。上游修复状态尚未复测，本次未访问或修改外部服务/模型配置，见[BOLDAPI 记录](../../memory/boldapi-inline-tools.md)。
- **已有暂缓决定**：permission/deny、跨进程 job registry、LLM goal judge、运行中子代理 follow-up、可配置嵌套深度，以及 Claude Code 风格 memory 系统仍遵循原暂缓决定，不新增为本轮实现任务。

其余尚存的进程生命周期、编辑器取消、输出背压、同步恢复、通知持久化和人工解除崩溃锁，仍以上文 R1–R13 的边界为准。context-prune 及其历史数据事项已结案，环境验收按用户要求暂缓，均不再列为当前待推进工作。全部审查子任务和本次验证任务均已完成；迟到的旧任务通知不表示还有运行中的修复。
