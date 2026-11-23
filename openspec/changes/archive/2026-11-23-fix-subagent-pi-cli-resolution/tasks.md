# Tasks

## 1. CLI 入口解析与单元回归

- [x] 1.1 在 `subagent/src/index.ts` 按 design.md 重写 `resolvePiCli()`，保留 `PI_CLI_JS` 校验，直接使用当前进程 JS 入口或已确认的自包含 Pi，可解析失败时显式报错；删除布局/PATH 扫描、`PI_CLI_SEGMENTS` 和 `"pi"` 兜底，并运行 `npm run typecheck --prefix subagent` 验证导入与类型。
- [x] 1.2 在 `subagent/src/index.test.ts` 替换过宽的 CLI 解析测试，覆盖有效/缺失 `PI_CLI_JS`、AGCopilot `pi-runtime/dist/cli.js`、常规 npm 布局、无关全局安装、自包含可执行文件和不可解析错误，且逐项恢复 argv/env；运行 `cd subagent && npx vitest run src/index.test.ts -t "resolves pi cli"` 验证。

## 2. 集成与规格验证

- [x] 2.1 运行 `npm test --prefix subagent` 与 `npm run typecheck --prefix subagent`，确认现有 fake Pi 生命周期、安全、恢复测试及新增解析测试全部通过。
- [x] 2.2 运行 `openspec validate fix-subagent-pi-cli-resolution --strict`，确认变更的 proposal、spec、design 和 tasks 完整且规格校验通过。
