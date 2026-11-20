# Pi 宿主实测行为

## 结论

以下都是探针实测的宿主语义，代码和文档读不出来；升级 Pi 后先复核再用。

发现与加载（Pi 1.5.2，macOS，Node 22）：

- 自动发现只扫一层：`<agentDir>/extensions/*.ts|js`，直接子目录里有 `index.ts`/`index.js`，或 `package.json` 带 `pi.extensions` 清单时按清单加载。
- `pi install`（npm 或 git）只读包根目录的清单，不扫 npm workspaces 子包；workspace 根没有清单时整仓安装得到 0 个扩展。
- clone 目录里的第三方 import 按 Node 规则从 `<clone>/node_modules` 解析；Pi 只把宿主模块别名到自己的副本。
- 依赖自动安装只在包路径上；clone 进 `extensions/` 的路径不安装任何依赖。软链目录会被跟随。
- `pi config` 只让 package manager 解析包（缺包时也会 clone），不加载扩展代码，所以工具名冲突时能先用它关掉一个再启动。
- `pi update --extensions` 会留下被 npm 改写的 `package-lock.json`，checkout 变 dirty 但不影响加载，下次更新 reset 掉。
- `discoverAndLoadExtensions()`（已安装包 `dist/index.js` 导出）只做原始发现；settings 的 `-路径` 过滤发生在它之前，拿它验证「关掉某扩展」会得到假阳性。
- `pi --help` 在工具名冲突时仍退出 0。退出码不能当证据，冲突文本才是。

生命周期与工具结果（Pi 1.5.0，2026-11-12）：

- Escape 中止的 run 不经过 `agent_before_settle`，直接到 `agent_settled {aborted:true}`（测试见 `goal/goal.test.ts`）。
- Pi 在当前 turn 的工具结束后才发下一次 `turn_start`；子代理轮次预算要在这里暂停，不能在 assistant `message_end` 后立即杀进程（`subagent/src/run-lifecycle.test.ts`）。
- `tool_result` 处理器替换 `content` 而不同时返回 `structuredContent` 时，ExtensionRunner 会删除该字段。
- RPC 的 select/input 支持 `opts.signal`，而 RPC abort 等待 agent idle；工具不把 AbortSignal 传给对话框就可能死等（`ask-user/ask-user.test.ts`）。
- `--no-tools` 不是 `--tools` 的空值形式：它设 `noTools: "all"`，初始工具与 MCP allowlist 都为空；省略 `--tools` 恢复默认（`subagent/src/security.test.ts`）。
- crash reaper 不能只查目录权限：journal/pid/start 必须是当前用户的 regular file，符号链接跳过整份记录；recorded/current start 都存在且不相等即证明 PID 复用，命令行 marker 不能覆盖这个矛盾，只有 start 不可取得时才回退（两个 `reap.test.ts`）。

当前扩展约定与验证（2026-11-20）：

- 子代理续跑必须属于当前父会话并使用子任务最初的工作目录。归属保存在子代理配置目录的 `subagent-sessions/<id>.json`；每次运行通过排他创建 `.lock` 避免本扩展跨进程并发写同一 transcript，续跑传递已核验的绝对日志路径。旧的无归属记录会话仅供查阅；崩溃锁需确认父子进程均已退出后手工删除。直接调用 Pi CLI 不参与此锁协议。
- 两个回收器的新 journal 都记录 owner PID 和 OS 启动身份。owner PID 存活时，仅在已记录和当前身份均可读且不一致时认定旧 owner 已退出；旧记录和未知身份保持保守处理。`EPERM` 不能当作死亡，子进程已知身份不一致时不能靠命令行标记覆盖。终止命令失败保留恢复记录。子进程存活但启动身份未知时，即使超过七天也保留 journal；不能把探测失败当成可清理的陈旧记录（`subagent/src/reap-failures.test.ts`）。
- 工具描述的静态角色表只含全局和内置角色；`before_agent_start` 依据 `ctx.cwd` 与信任状态补充当前角色表。缺少信任决定时不加载项目角色，SDK 工作目录和进程目录不同也按会话处理。
- `agents.<role>` 的项目配置逐字段继承全局配置；缺省继承，`null` 跳过该全局角色字段并继续文档/默认链，数组整体替换，`tools: []` 选择无普通工具。迁移细节见 `subagent/README.md`。
- Pi 1.5.0 已具备使用中的 `MessageRenderOptions.keyText`；1.1.0 缺少该接口。最低版本与真实加载验证见 `bywork/work/audit-followup/compatibility.md`。
- 两个回收器在 `session_start` 使用异步 OS 查询和 Windows 终止命令，每次查询仍有五秒上限；同一轮缓存 PID 查询，并合并重叠扫描。等待恢复期间事件循环可继续处理计时器，很多不同 PID 仍可能延迟会话启动完成。
- 续跑子进程的 journal 保存实际传入的绝对 transcript 路径。启动身份不可取得时，Windows 用 JSON 保留 CIM 命令行原文并严格解析完整参数，Linux 读取 `/proc/<pid>/cmdline`；已知身份不符仍优先拒绝。macOS 的平面命令行不能可靠核验这个路径回退，继续保留 journal。
- 待投递完成通知写入父配置目录的 `completion-notices`，按来源、父会话和任务 ID 隔离；原会话恢复时合并磁盘与内存记录。宿主 `sendMessage` 返回 void，没有持久化回执，交接窗口仍可能重复或丢失。后台日志的私有 `.log.profile` 文件指向所属通知目录，跨 Pi 配置清扫和残留 journal 恢复都保留未送达日志；目录不可读取或归属标记无效时保守保留。操作系统仍可能自行清理临时文件。
- 宿主 `BashOperations.onData` 返回 void，无法等待磁盘 drain。后台扩展使用可暂停 stdout/stderr 的执行器，在写入反压时等待 drain，磁盘错误终止生产者；继续使用 Pi 的 shell 发现、设置和会话环境。内置前台工具不受影响。
- 原同步实现的 Windows 受控恢复探针：六条记录、每条两次真实 PowerShell 身份查询，三次中位数 2,978.6 ms。仅测查询和夹具处理，终止被 mock，不是端到端启动耗时；原始记录见 `bywork/work/audit-followup/background.md`。

## 依据

- 类型：外部观察（可重跑证明）。
- 探针配方：临时 `PI_CODING_AGENT_DIR` + 把仓库软链到 `extensions/<名>`，跑 `pi --help`；写 10 行 Node 脚本调 `discoverAndLoadExtensions([], cwd, agentDir)` 打印每个扩展的 tools/commands/errors；验证某项被关掉时，放一个注册同名工具的探针扩展，看冲突报错是否消失。
- 原文：`archive/byissue/notes/2026-11-11-pi-extension-loading-probes.md`。

## 重访条件

Pi 版本升级后，发现规则、过滤时机与生命周期事件顺序都可能变；依赖这些语义写测试或护栏前，用上面配方在目标版本重跑。