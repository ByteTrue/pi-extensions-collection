# Design

## Context

`subagent/src/index.ts` 的 `resolvePiCli()` 目前扫描特定 npm 路径、全局安装目录与 `PATH`，最终回退到 `"pi"`。所有同步、异步和恢复执行都共享这一入口，而 `runPi()` 的 spawn 参数、环境继承与任务管理无需改变。详见 proposal.md 的 Why。

## Goals / Non-Goals

**Goals:**
- 用当前进程已经持有的启动信息确定同版本子 Pi，消除宿主目录布局假设。
- 保留现有 `PI_CLI_JS` 覆盖和 fake Pi 测试契约。
- 对不支持的启动形态在 spawn 前失败，并给出明确修复提示。

**Non-Goals:**
- 不为 AGCopilot 增加专用路径分支，也不要求宿主新增环境变量。
- 不使用 `shell:true`，不恢复 `pi`/`pi.cmd` 的 PATH 查找。
- 不调整 AGCopilot 的 Electron `--no-maglev` 策略或通用 runtime 参数传播；这是独立于入口 ENOENT 的兼容性议题。
- 不改变 `runPi()` 的输出解析、取消、超时、后台任务或恢复逻辑。

## Decisions

### 1. 固定解析优先级，显式覆盖优先

顺序为：`PI_CLI_JS` → 当前 Node 托管入口 → 当前自包含 Pi 可执行文件 → 显式错误。

`PI_CLI_JS` 继续经 `resolve()` 转为绝对路径并用现有 `exists()` 校验；缺失时保留 `PI_CLI_JS missing: <path>`。有效覆盖仍返回 `{ command: process.execPath, args: [entry] }`，避免改变现有测试与调试入口。

备选方案是让 AGCopilot 写入 `PI_CLI_JS`。该方案只能修复一个宿主，且把本可由进程自身回答的问题变成跨仓库契约，因此不采用。

### 2. Node 托管时直接采用 `process.argv[1]`

当 `process.argv[1]` 解析后是磁盘上存在的 `.js`、`.cjs` 或 `.mjs` 文件时，返回当前 `process.execPath` 与该入口。该值是 Node 的实际脚本入口，与它位于 `pi-runtime`、`node_modules` 或其他目录无关。

删除 `PI_CLI_SEGMENTS`、argv 正则扫描、npm prefix/APPDATA/PATH 遍历和 `"pi"` 兜底。仅清理由此不再使用的 import；`resolve` 等仍被其他模块代码使用的导入保留。

备选方案是放宽现有正则或增加 `pi-runtime` 分支。它继续枚举宿主，无法根治下一种布局，因此不采用。

### 3. 仅对已确认的自包含 Pi 使用当前可执行文件

当 JavaScript 入口不成立时，仅在 `PI_CODING_AGENT === "true"` 且启动形态符合自包含可执行文件时返回 `{ command: process.execPath, args: [] }`：Node SEA 形态的 `argv[1]` 与 `process.execPath` 指向同一文件，或 Bun 编译运行时没有磁盘 JS 入口。

Pi 标记防止在普通 Node 进程中误把 `node` 当作 Pi；入口/运行时检查防止在异常 Node 启动中无参数 spawn Node REPL。普通 `bun run cli.js` 会先命中有效 JS 入口，不走二进制分支。

备选方案是只检查 `PI_CODING_AGENT` 就回退 `process.execPath`。它在入口异常的 Node 宿主中可能启动 REPL，而不是快速报错，因此不采用。

### 4. 解析失败不进入 spawn

其余情况抛出包含 `PI_CLI_JS` 设置建议的错误，不返回任何猜测命令。这样配置/打包问题会直接呈现为可操作的解析错误，而不是操作系统的 `ENOENT` 或一个意外启动的无关进程。

### 5. 用隔离的单元测试覆盖解析矩阵

在 `subagent/src/index.test.ts` 中为 `resolvePiCli()` 建立临时入口文件，分别模拟 AGCopilot 布局、普通 npm 布局、Node SEA 和不可解析入口；断言 command/args，而不依赖开发机是否全局安装 Pi。另测覆盖优先级与缺失覆盖路径。

每个用例在 `finally` 中恢复 `process.argv[1]`、`PI_CLI_JS` 与 `PI_CODING_AGENT`，避免污染共享进程中的其他测试。现有通过 `PI_CLI_JS` 启动 fake Pi 的集成测试作为 `runPi()` 行为不变的回归保障。

## Risks / Trade-offs

- [某些打包器使用虚拟或非磁盘入口，无法被通用逻辑确认] → 在 spawn 前给出 `PI_CLI_JS` 提示；Bun/SEA 自包含形态走当前可执行文件分支，不为未知布局继续加扫描规则。
- [直接读取并修改全局 `process.argv` 的测试可能串扰] → 每个用例保存并恢复原始值，且不断言机器上的全局安装状态。
- [Windows Electron-as-Node 若必须携带 `--no-maglev`，仅继承 executable 与 env 不一定复制该参数] → 本变更不假装解决该独立问题；入口 ENOENT 修复后如实际复现 runtime 参数问题，再单独设计参数继承或宿主 `NODE_OPTIONS`。
- [单元测试无法证明真实 Windows 打包应用端到端行为] → 实现后运行完整 subagent 测试与 typecheck；Windows 打包烟测作为发布验证，不扩大本次代码范围。
