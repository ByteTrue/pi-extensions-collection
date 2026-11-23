# Proposal

## Why

`subagent` 当前通过 npm 目录形状、`PATH` 和全局安装位置猜测父 Pi 的 CLI 入口；在 AGCopilot 这类嵌入式宿主中全部猜测落空，最终执行不可直接 spawn 的 `pi`/`pi.cmd`，导致 Windows 上报 `spawn pi ENOENT`。同一套假设也会影响其他自定义打包布局，因此需要在扩展内消除宿主布局耦合，而不是要求每个宿主注入补丁环境变量。

## What Changes

- 保留 `PI_CLI_JS` 作为显式入口覆盖，并继续校验目标文件存在。
- 默认从当前 Pi 进程自身的启动信息解析子进程入口，不再扫描 argv 中的特定 npm 路径、全局 `node_modules`、`APPDATA` 或 `PATH`。
- Node 托管的 Pi 使用当前 runtime 与真实 CLI 入口启动子 agent；单文件 Pi 可执行文件使用当前可执行文件启动。
- 无法确认入口时立即给出可操作错误并提示设置 `PI_CLI_JS`，不再静默回退为 `spawn("pi")`。
- 增加覆盖 AGCopilot `pi-runtime/dist/cli.js`、常规 npm 布局、显式覆盖及失败路径的回归测试。
- 不修改 AGCopilot，不新增依赖，不改变 subagent 工具参数或任务生命周期语义。

## Capabilities

### New Capabilities

- `subagent-process-launch`: 定义 subagent 如何从当前 Pi 进程确定并启动同版本子 Pi，包括显式覆盖、嵌入式宿主、自包含可执行文件和解析失败行为。

### Modified Capabilities

无。

## Impact

- 修改 `subagent/src/index.ts` 中的 `resolvePiCli()`，删除 `PI_CLI_SEGMENTS` 及布局/PATH 探测逻辑。
- 更新 `subagent/src/index.test.ts`；现有通过 `PI_CLI_JS` 启动 fake Pi 的生命周期、安全与恢复测试保持不变。
- 影响所有调用 `runPi()` 的同步、异步、链式与恢复执行路径，因为它们共享同一 CLI 解析入口。
- 不修改 AGCopilot 仓库，不新增运行时依赖，不要求用户设置 `PI_CLI_JS` 作为常规 workaround。
