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

## 依据

- 类型：外部观察（可重跑证明）。
- 探针配方：临时 `PI_CODING_AGENT_DIR` + 把仓库软链到 `extensions/<名>`，跑 `pi --help`；写 10 行 Node 脚本调 `discoverAndLoadExtensions([], cwd, agentDir)` 打印每个扩展的 tools/commands/errors；验证某项被关掉时，放一个注册同名工具的探针扩展，看冲突报错是否消失。
- 原文：`archive/byissue/notes/2026-11-11-pi-extension-loading-probes.md`。

## 重访条件

Pi 版本升级后，发现规则、过滤时机与生命周期事件顺序都可能变；依赖这些语义写测试或护栏前，用上面配方在目标版本重跑。