# Project Spec

## 这个项目是什么

一个 git 分发的 Pi 包，包含 6 个扩展。`pi install git:github.com/ByteTrue/pi-extensions-collection` 安装：Pi clone 仓库、跑 `npm install`、按根 `pi.extensions` 清单加载。`pi update --extensions` 更新。每个带 `package.json` 的顶层目录就是一个扩展，放入口文件、测试和私有 `package.json`。

它来自 `ByteTrue/pi-package-mono`（已归档、只读）的分裂：5 个原 small-extension 加 1 个原 npm 包（background terminal）合到这里；subagent 曾另立 `ByteTrue/pi-subagent` 按 git 分发，2026-11-11 收回本仓。原来的 context-guard 后来拆成 `context-prune` 与 `auto-compact`；`context-prune` 于 2026-11-13 实测净亏 47% 后删除。分发形态先改成复制安装，2026-11-11 当天又改成 git 包。

## 统一语言

- **包与扩展**：整个仓库是 Pi 的一个包；根 `pi.extensions` 清单里的每一项是一个扩展。不再有「小扩展 / drop-in」这类按分发方式划分的概念。
- **分发清单**：根 `package.json` 的 `pi.extensions`。它是安装、加载与逐项开关的真源，`scripts/check-manifest.mjs` 守住它与扩展目录一一对应。
- **官方安装**：`pi install git:…`，更新 `pi update --extensions`。checkout 归 Pi：更新时 reset 到远端提交并清掉未跟踪文件，不能就地改。
- **版本**：整个包一条版本轴，发布与钉版本用 git tag（首个 `v1.0.0`，当前 `v2.0.0`）。旧的 `ByteTrue/pi-subagent` 仓库已归档，它的 `@v0.18.0` 安装命令不再有效。
- **一个上下文扩展**：`auto-compact` 管 400k 自动压缩，注册无工具。曾经的 `context-prune`（确定性剪枝 + 提醒 + `ctx_*` 工具）已在 2026-11-13 删除，理由与数据见 `decisions/2026-11-13-remove-context-prune.md`。
- **模型可见契约以 opencode 为参照**：工具描述、参数、结果文本、完成通知、错误文案与循环护栏对齐 opencode v2.2.7 的同类能力；内部架构（Effect、permission、job registry、plugin storage）不搬。`auto-compact` 不在对齐范围。
- **后台工作注册表**：`background-terminal` 与 `subagent` 在进程内注册 `Symbol.for("pi-extensions.background-work")`，`goal` 和 subagent 完成通知读取它。注册表是可选的：提供方没加载时退回原行为。

## 不可破的约束

- **依赖写进扩展自己的 `package.json`**：运行时依赖放 `dependencies`，Pi 在安装与更新时执行 `npm install --omit=dev`；`devDependencies` 只服务 CI。宿主模块（`@earendil-works/*`、`typebox`）不进 `dependencies`，Pi 会把它们映射到自己的副本，物理拷贝会造出重复的类与注册表。依赖装不上时 Pi 警告并跳过该包，不会因此起不来。
- **子目录 `package.json` 永远 private、永不发布**：npm 上找不到这个仓库的任何扩展，分发只走 git 包。
- **工具名必须全局唯一**：Pi 遇到两个扩展注册同名工具会拒绝启动，后加载的那个扩展整个不加载（连它别的工具一起失去）。扩展自身看不到别人注册了什么：加载期调用 `pi.getAllTools()` 会抛「runtime not initialized」。冲突只能靠不加载来预防（`pi config` 逐项过滤）。
- **后台任务默认无寿命上限**：`background_run` 不传 `timeout`（或传 `0`）就只在命令退出、显式 timeout 到期、`background_kill` 或 Pi 会话退出时结束；没有第二层硬顶。Pi 正常退出和 SIGTERM/SIGHUP 会杀掉任务；SIGKILL 或硬崩溃无法运行清理，但每个任务写 journal，下一次扩展加载会 `reapOrphans` 掉 owner 已死的进程组和日志；直到下次启动前，任务可能继续跑。
- **`subagent` 的 `agent` 与 `description` 必填**：没有匿名 plain child；未知角色报错并列出可选角色。`resume` 只接受本扩展创建的 `sub_…` 会话。子进程在 SIGKILL/crash 后由下一次扩展加载的 journal reaper 回收；直到下次启动前它可能继续跑。
- **`goal` 的循环护栏**：objective 包成 `<untrusted_objective>` 并转义，上限 4000 字符；50 轮、连续 3 次无工具调用会暂停；有后台工作在跑时 hold，不注入 continuation；进程重启后遗留的 active goal 恢复为 paused。

## 做 / 不做

**做**

- 一个 git 包维护 6 个扩展。
- 模型可见契约以 opencode 同类能力为参照，差异写在对应扩展的 `README.md` 与 `byissue/epics/2026-11-12-x-对齐-opencode-设计/`。
- 需要依赖就写进对应扩展的 `package.json`，由 Pi 安装。
- 保持无构建：Pi 用 jiti 直接加载 TS 入口，依赖来自 `node_modules`。
- 文档随行为改：用户可见的行为变化同时改该目录 `README.md` 与本文件。

**不做**

- 不发 npm，不加 `publishConfig` 或任何发布字段。
- 不把 `node_modules` 提交进仓库，也不手工 vendor 依赖。
- 不做安装器脚本、插件市场、通用框架。
- 不对齐 opencode 的内部架构：pi 没有 Effect service、permission 服务、job registry 或 plugin storage，这些位置标 `不适用`，不造替代框架。

## 已排除的方案

- **手工复制安装 / clone 进 `~/.pi/agent/extensions/`**：2026-11-11 短暂采用过 clone 方案（当天被 git 包取代）。复制路径没有人跑 `npm install`，依赖要么缺失要么靠用户手工补；同一扩展的副本还会和包里的那份撞工具名。维护者要改代码就在自己的 checkout 里改，用 `pi -e` 加载单个文件验证。
- **安装器脚本（`install.mjs`）**：曾用 curl 拉取文件并配箭头菜单，重跑即更新，还兼做 magic-context 预检。逐项选择现在由 `pi config` 的包级过滤提供，脚本已删除。
- **运行时自我禁用**：曾在 context-guard 里加「`session_start` 时比对 `getAllTools()`，被顶掉就停掉所有 hook」。实测冲突在**加载期**就失败，该分支永远不可达，已回滚。冲突只能靠不加载来预防。
- **拍平后再加依赖**：`background-terminal` 曾被拍平成单个文件，前提是它只 import 宿主模块和 `node:*`。拍平保留，但依赖规则已放宽：它需要第三方库时写进自己的 `package.json` 即可，不需要退回另一套分发。

## 阅读路径

- 每个扩展的行为与安装方式 → 各目录 `README.md`
- 当前分发形态的拍板 → `decisions/2026-11-11-git-package-install.md`
- 收回 subagent 的拍板 → `decisions/2026-11-11-merge-subagent.md`
- 被取代的中间形态（clone + pull） → `decisions/2026-11-11-clone-and-pull-distribution.md`
- 删除 context-prune 的实测依据 → `decisions/2026-11-13-remove-context-prune.md`、`notes/2026-11-13-context-prune-ab.md`
- 更早的停发 npm → `decisions/001-copy-in-distribution-no-npm.md`
- 分裂的来源与验证证据 → `byissue/epics/2026-11-04-x-仓库分裂与分发形态收敛/spec.md`
- 与 opencode 的对齐范围、逐项结论与取舍 → `byissue/epics/2026-11-12-x-对齐-opencode-设计/spec.md` 与同目录 `ledger.md`
- 扩展间后台工作注册表的契约 → `byissue/notes/2026-11-12-background-work-registry.md`
- Pi 扩展发现、开关、依赖解析的实测边界 → `byissue/notes/2026-11-11-pi-extension-loading-probes.md`
