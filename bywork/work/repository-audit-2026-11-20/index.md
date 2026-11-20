# 全仓审查与修复记录

审查日期：2026-11-20。范围包括五个扩展的运行时代码、测试、角色文档、配置、安装清单、依赖锁文件、CI 和现有文档。历史归档核对其证据和引用关系，不改写历史记录。审查开始时已有的 `bywork/work/paseo-compat/` 保持原样。

状态：全仓审查、确定性修复和最终验收已完成。改动尚未提交。下表是本次发现的具体问题，不代表已证明不存在其他缺陷。

用户随后批准了 R1–R13 的处理建议，最新实现、迁移方式及剩余限制见[后续处理记录](../audit-followup/index.md)。本页的待审核表和测试数字保留初次审查时的状态。

## 已修复

### 子代理执行与结果

- 最终 assistant 消息为 `error`/`aborted` 时，子进程即使以 0 退出也判为失败，并保留已有回答及失败原因；`agent_end` 不再提前宣布任务成功。
- 重试成功会清除先前的错误；最后一条空回答不再被早先的回答覆盖。
- stdin 非 EPIPE 错误会先停止并排空子进程，再报告失败，避免返回后遗留运行中的进程。POSIX 组长先退出后仍会清理后代；Windows `taskkill` 非零退出会触发直接终止回退。
- 清理 journal 的文件系统异常不再阻断完成处理；会话关闭时保留尚未送达的通知及尚未退出的子进程记录，并清理不再需要的等待计时器。
- 设置、角色及相对工作目录按当前会话 `ctx.cwd` 解析，避免 SDK 会话与进程工作目录不同时读取错项目。
- 带 BOM 的角色 frontmatter 现在按去掉 BOM 后的字符串切片，不再错切正文。
- JSON 输出先逐行处理，再检查单条事件大小。原来一次读取中的 20 条事件只处理了 17 条；超过原有 1,048,576 字符上限的单条事件会明确失败，避免截断错误事件后误报成功。

位置：`subagent/src/index.ts`；覆盖执行生命周期、失败回退、通知及角色解析测试。

### 子代理设置、界面与报告

| 位置 | 问题与修复 |
| --- | --- |
| `subagent/src/tui-picker.ts`、`subagent/src/progress-view.ts` | RPC 中也存在 `ui.custom`，但调用不显示界面。现在只在 TUI 使用自定义界面，其他模式使用标准选择或通知。 |
| `subagent/src/tui-picker.ts` | 输入框焦点改为跟随宿主组件，避免光标标记与实际焦点不符。 |
| `subagent/src/progress-view.ts` | 关闭进度页时清理刷新计时器；标题、正文及提示按终端宽度截断。 |
| `subagent/src/command.ts` | 状态页和角色菜单传递项目信任状态；仅在受信任时读取项目设置位置；自定义角色名先校验再写入。初始工具描述的角色名单仍有独立限制，见 R6。 |
| `subagent/src/settings.ts` | 新设置路径为目录、断链或不可读时，不再重新激活旧设置；保存失败后清理临时文件，减少环境变量凭证残留。 |
| `subagent/src/settings.ts`、`subagent/src/command.ts` | 使用无原型字典保存角色及环境映射，保留 `__proto__`、`constructor` 等键。 |
| `subagent/src/byspace-report.ts` | 同一任务的状态请求按顺序发送，避免慢的 running 请求覆盖终态；队列跨 `/reload` 延续，不同任务仍可并行。旧请求失败时只清理对应快照的去重状态。 |
| `subagent/src/byspace-report.ts` | 没有进度事件的快速任务也能从启动指针解析日志路径；有进度时保留子代理自己的 `agentDir`，避免误用父会话配置目录。 |

### ask-user 与 goal

- `ask-user` 多选过程中按 Back 会保留尚未提交的勾选和 Other 文本；删除不可达的 `other` 分支。
- 旧版顶层 `{question, options, multiple}` 在宿主 schema 校验前转换；schema 和运行时都限制每次 1–4 题。
- 已取消的调用不再打开自由文本编辑器；取消后到达的答案会被丢弃。已经打开的 TUI 编辑器仍有宿主限制，见 R5。
- `goal` 的重试和 compaction 不再重置当前 continuation 的停滞计数及工具使用记录，防止绕过连续无工具调用的暂停规则。
- 在完成目标后的最终回复被中断时，`goal_done` 也会从可用工具中撤下。
- 恢复持久化计数时，只接受非负安全整数，拒绝负数、小数和不安全的大整数。

位置：`ask-user/ask-user.ts`、`goal/goal.ts`，均补充回归测试及对应 README。

### 后台终端

- Windows 原先记录 MSYS PID，并使用 Git Bash 不支持的 `ps` 参数，孤儿回收可能失效；现在记录原生 PID/启动时间，使用系统 `taskkill.exe`，并在命令前缀执行前记录身份。普通命令、显式 `exec` 和阻塞前缀均以真实子进程验证。
- 权限探测 `EPERM` 不再被当作进程死亡；身份不能确认或终止失败时保留 journal/日志，不因超过七天就丢掉恢复依据。
- journal 写入失败、后端同步抛错会进入统一失败收尾并关闭输出流；journal 写入失败不会启动命令。
- 越过 50 MiB 文件上限的 chunk 保留额度内的前缀，明确标记截断；完成时刷新 UTF-8 decoder，避免尾部字符丢失。
- `background_kill` 和菜单停止操作等待终止确认；五秒后仍未确认则报错并保留任务，不再提前宣布成功。
- reload 时清除旧宿主上下文及 UI 回调，通过全局队列交接通知。
- 使用宿主 `getAgentDir()` 构建 PATH，正确处理空值与 `~`；输出写入失败的折叠通知显示 failed；通知过滤 OSC 标题/链接等终端控制序列。
- 修正 Windows 回收测试假阳性、测试子进程清理遗漏，以及没有实际断言的环境测试。

位置：`background-terminal/background-terminal.ts` 及测试；模块最终为 82 通过、7 跳过。

### 安装、检查与过时内容

- 安装清单检查现在拒绝目录入口、异常类型、越出扩展目录的路径和 Windows 反斜杠绕过；新增 7 个独立夹具测试并接入根 `npm test`。
- CI 增加 Ubuntu/Windows 矩阵；遵循已有“不新增版本锁定”决定，保留不固定 Node 版本的方式。`subagent.ts` 真实入口纳入类型检查。
- 修正依赖声明：补齐实际使用的宿主 peer，移除 subagent 未使用的 TypeBox peer；锁文件仅同步工作区元数据，没有升级依赖或新增运行时依赖。
- 删除私有工作区无效的 npm `files` 字段、未使用导入和已不可达分支。修正已删除安装脚本、300 秒上限、单题限制、parallel/chain、默认角色、设置迁移和工具权限等过时说明。
- 安装示例不再指向不存在的 `v1` 或包含旧功能的历史 `v2.0.0`。历史版本安装仍可通过真实 tag/commit 明确选择。
- 当前 memory 不再把缺少 ModelRegistry 生成 API 当作暂缓 goal judge 的理由；保留暂缓决定。context-prune 的历史实验数字冲突已明确标注，当前文档不再把争议幅度当成已核实结论。

## 待审核

优先级：P1 可能影响权限、会话数据或进程存活；P2 是行为契约、运行限制或兼容性缺口；P3 是证据与可选清理。以下没有擅自更改行为。

### R1 · P1 · 子代理工具选择不构成权限隔离

`subagent/agents/explore.md:9` 仍包含 `bash`；shell 本身可写文件。`subagent/src/index.ts:2672` 说明 codemode/deferred 工具可能超出普通活动工具选择，宿主还可能保留 MCP 工具。已修正“强制只读”和“安全 allowlist”的不实描述。

需要决定：继续接受提示词约束，还是要求真正的执行权限边界。建议若需要处理不可信项目或任务，单独实现宿主工具权限控制；仅删 `write/edit` 或 `bash` 不能完整隔离，删 shell 也会影响现有搜索工作流。

### R2 · P1 · resume 只有命名检查，没有所有权和并发锁

`subagent/src/index.ts:1862` 只校验合法格式及 `sub_` 前缀。它不能证明会话由当前父会话创建，也不能阻止两个子进程同时恢复同一日志。文档已明确限制。

需要决定：是否允许跨父会话恢复，以及是否需要跨 Pi 进程的互斥。建议恢复前验证会话归属，并为会话文件建立可靠锁；单进程 Map 检查不足以覆盖多个 Pi 实例。

### R3 · P1 · 孤儿回收的身份与平台边界

`background-terminal/background-terminal.ts:352` 的 journal 记录 owner PID，未记录 owner 的启动身份；原宿主退出后 PID 被其他活进程复用，会把真实孤儿当成仍有宿主而跳过。建议为 owner 也保存启动身份，并确定旧 journal 的迁移策略。

`subagent/src/index.ts` 和后台终端使用 Windows `taskkill /T /F`。父节点已退出或后代脱离可追踪进程树时，不能保证整棵树退出。已有修复覆盖可识别进程树和失败回退，没有把它描述为强保证。若必须保证所有后代随父进程退出，需要 Windows Job Object 等平台机制，应单独确认平台支持和依赖策略。

### R4 · P2 · headless goal 可能永远等不到 settled

`goal/goal.ts:380` 发送用户消息，`goal/goal.ts:440` 等待 `agent_settled`。宿主发送接口没有可等待的派发结果；缺少模型/认证导致运行未开始，或另一扩展消费输入时，不一定产生 settled。已在 README 公开该限制。

建议优先推动宿主提供可等待的派发结果；若要在扩展侧加超时，需要先确定上限及错误语义，不能悄悄恢复此前删除的固定等待计时器。

### R5 · P2 · ask-user 选项身份与编辑器取消

`ask-user/ask-user.ts:277` 用 label 作为多选状态键，`:328` 按显示文字找第一项；重复 label 或与 Other/Back 相同的文字可能产生歧义。建议拒绝重复/保留标签，或改用稳定选项 ID；两者都会改变输入或显示契约。

`ask-user/ask-user.ts:252` 的宿主 TUI 编辑器没有 signal/close API。运行取消后，已经打开的编辑器仍需 Esc 关闭；已避免接收迟到答案。完全解决需要宿主能力，或改掉现有多行输入体验。

### R6 · P2 · 初始角色名单与实际会话目录、信任状态不同步

`subagent/src/index.ts:898` 在不知道会话信任状态时发现项目角色名；`:2631` 在加载时用 `process.cwd()` 构建静态工具描述。执行阶段已改为正确的 `ctx.cwd` 和信任检查，但 SDK 指定另一个 cwd 或切换会话时，模型看到的名单仍可能旧于实际可用角色；项目文档正文此时不会注入。

建议在宿主支持的会话生命周期中更新工具描述，或者明确只在静态描述中列出全局/内置角色。需要验证宿主对动态注册及缓存的契约。

### R7 · P2 · 同名角色配置按整项覆盖

`subagent/src/settings.ts:295` 浅合并 `agents`。例如全局 `explore={model, tools}`，项目 `explore={thinking}`，会丢掉该角色全局的 model/tools 字段。

需要决定整项替换还是逐字段继承。建议若界面继续使用“继承”，按字段合并并定义如何显式清除字段；直接深合并可能使原本希望移除的全局工具限制重新生效。

### R8 · P2 · 崩溃后的通知不持久化

进程内通知队列已覆盖 reload、切换会话和发送失败重试；进程崩溃/退出仍可能丢掉未送达结果。当前 memory 已明确暂缓跨进程 job registry 恢复。

建议维持现有范围并接受限制；只有确实需要崩溃恢复时，再设计持久队列和去重确认，避免误承诺 exactly-once。

### R9 · P2 · 最低宿主版本声明未经兼容矩阵验证

五个工作区 peer 都声明 Pi `>=1.1.0`；本次测试依赖锁定环境是 Pi 1.5.0，参考运行宿主是 1.6.0。新增/现有 API 在所有 1.1–1.4 版本上的支持没有证据。

建议实际测试最低版本，或在有证据后提高最低支持版本；不要把“未固定版本”混同于“已验证所有历史版本”。本次没有擅自改版本下限。

### R10 · 已结案 · context-prune 历史实验记录

`bywork/memory/context-prune-removal.md` 与拍板记录中的只剪枝结果是 $0.219 / peak 182k；`archive/byissue/notes/2026-11-13-context-prune-ab.md` 的 auto 行是 $0.237 / peak 215k / 未缓存 input 617k。仓库没有原始 run 数据，不能确认哪组正确。

已保留删除决定及历史记录，当前 memory 标明争议。2026-11-20 用户明确更正：扩展已删除，该事项应当结案；不再追查原始数据或将其列为待处理问题。历史记录保留，不据此重启扩展。

### R11 · P3 · 可选兼容性清理

`SubagentBackgroundManager` 在 `subagent/src/index.ts` 仅作为旧名称别名导出，仓库内部已无调用。删除可减少两行，但可能破坏仓库外的旧导入；建议保留，除非明确放弃该兼容接口。

### R12 · P2 · 大量输出仍可能占用较多内存或卡住界面

`background-terminal/background-terminal.ts:482` 的后端回调没有暂停接口，写文件忽略背压；快生产者遇到慢磁盘时，每任务最多可能积压接近 50 MiB，并发会放大占用。`:1008` 的“查看输出”会一次读入最多 50 MiB 并交给编辑器。

建议先选择日志菜单使用有界预览还是分页；生产端若要真正背压，需要后端增加暂停/恢复能力。现有 `background_status` 尾部预览和内置 `read` 已可用于有界查看。本次没有实测多任务慢磁盘峰值，不把静态上限当成测量结果。

### R13 · P2 · Windows 恢复环境与同步探测成本

`background-terminal/background-terminal.ts:200` 的恢复依赖 MSYS/Cygwin `/proc/<pid>/winpid` 及 Windows PowerShell，不覆盖 WSL。`:104` 在 Windows 上依赖临时目录既有 ACL；没有主动校验目录 ACL。`:247` 的同步身份探测一次最多阻塞五秒，大量孤儿记录可能累加启动延迟。

建议明确支持的 shell 与多用户部署要求；有大量孤儿记录的实测延迟后，再决定并发/异步回收方式。当前 README 已公开环境限制，没有声称覆盖所有 Windows shell。

### 仍需实机复现的观察

运行过程中替换或清除 goal 时，当前模型请求可能仍持有先前注入的系统 section。尚未实机复现，不列为确认缺陷；如用户观察到旧目标继续影响当前轮，应联合宿主 prompt 生命周期检查。

## 验证

- 修改前：280 个测试通过，12 个平台测试跳过；五个工作区类型检查通过。
- 最终 `npm test`：345 通过、12 个平台相关测试跳过；其中清单夹具 7、ask-user 35、background-terminal 82、bash-timeout 11、goal 53、subagent 157。比修改前增加 65 个通过的回归/夹具用例。
- `npm run typecheck`：全部五个工作区通过。
- `npm run typecheck --workspaces --if-present -- --noUnusedLocals`：全部通过，检查发现的废弃导入/局部绑定已清理。
- `node scripts/check-manifest.mjs`：五个扩展入口有效；`git diff --check` 通过。
- `npm audit --json`：已知漏洞 0；依赖安装版本没有变动。
- 大输出新增的 3 个测试先在旧逻辑上失败，再在修复后通过；其他模块也增加了对应边界的回归测试。

最终测试日志：`C:/Users/byte/AppData/Local/Temp/background-terminal/bg_7a0d748d123c2165.log`。普通类型检查：`C:/Users/byte/AppData/Local/Temp/background-terminal/bg_6fdc820d04f88d84.log`；未使用代码检查：`C:/Users/byte/AppData/Local/Temp/background-terminal/bg_1cc473311b9d05b2.log`。

本机 Windows、Node 26.13.0。托管 Linux/Windows CI、真实远端 BySpace 服务、各种终端及历史 Pi 版本未做端到端验证；相关边界以上述测试与源码检查为限。
