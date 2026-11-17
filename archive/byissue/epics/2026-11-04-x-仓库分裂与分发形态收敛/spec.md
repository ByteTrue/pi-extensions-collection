---
kind: epic
title: "仓库分裂：npm monorepo → 三个独立仓库"
created: 2026-11-04
---

# 仓库分裂：npm monorepo → 三个独立仓库

## 要改变什么

`ByteTrue/pi-package-mono`（npm workspaces monorepo，两个发版包 + 5 个不发布的 small-extension）拆成三处：

| 去向 | 内容 | 分发形态 |
|---|---|---|
| `ByteTrue/pi-extensions-collection`（本仓） | 5 个原 small-extension + 拍平后的 background terminal | 复制进 `~/.pi/agent/extensions/` |
| `ByteTrue/pi-subagent` | subagent 扩展 | git tag，`pi install git:…@v0.18.0` |
| `ByteTrue/pi-package-mono` | 原样归档，只读 | — |

## 为何现在做

两个包 + 5 个小扩展共用一个工作区，代价落在不需要它的东西上：发版流水线、`npm ci`、worktree 项目级配置（`pi-dev-setup` 脚本本身就为了压住 monorepo 的同名包重复注册）全都在为「其实可以 cp」的扩展服务。这些扩展的 `dependencies` 全空，运行时只要 `node:*` 和 Pi 宿主模块。

## 当前方案（已落地）

- **background terminal 拍平**：7 个模块 → `pi-background-terminal/pi-background-terminal.ts`（761 行，0 个相对 import），`src/` 删除，8 个测试文件提到目录根并改指向单文件；42 个测试与改动前逐条一致。
- **其余 5 个原样搬**：只改 `tsconfig.json` 的继承层级（`../../` → `../`）和 README 里的相对路径。
- **安装器上提**：`scripts/install-small-extension.mjs` → 根 `install.mjs`，`REPO_RAW` 指向本仓，清单加入 background terminal；`scripts/check-installer.mjs` 改为扫描根目录 `pi-*`。`optIn` 机制删除，全部默认勾选。
- **subagent 转 git 包**：去掉 `publishConfig` 与 `release.yml`，保留 `pi.extensions: ["./src/index.ts"]`，首版 tag `v0.18.0`；用户命令从 `pi install npm:@bytetrue/pi-subagent` 换成 `pi install git:github.com/ByteTrue/pi-subagent@v0.18.0`。
- **旧仓收尾**：README 顶部加归档横幅后 archive。

## 架构与质量取舍

- **拍平换来了求值顺序依赖**：单文件里 `manager` 全局单例的初始化依赖区块顺序（`BackgroundManager` 定义在某行之后、任何使用之前）。原先是 import 图保证的，现在由 `// --- section ---` 分隔的物理顺序保证。重排区块会静默破坏它——这是本次唯一新增的隐性风险。
- **跨仓原子性没了**：`SHELL_TIMEOUT_SECONDS = 300` 这个数值契约本来就是两份（background terminal 用常量、`pi-bash-timeout` 独立实现），现分属两个目录但仍在同一仓，注释里互相指向。
- **宿主模块不能进 `dependencies`**：Pi 会把 `@earendil-works/*`、`typebox` 映射到自己的副本；物理拷贝会造出重复类与注册表。两个包原本就遵守，搬迁未改变。

## 验证证据

关闭时全部满足：

- **collection**：`npm run typecheck --workspaces` 全绿；`npm test` 360 passed（vendor 205 / background-terminal 42 / context-guard 41 / goal 34 / ask-user 24 / bash-timeout 14）；`node scripts/check-installer.mjs` 报 6/6。
- **subagent**：`tsc --noEmit` 干净，92 passed。
- **真实 Pi 冒烟**：`background_run` 起任务 → `background_status` 报运行中 → 退出通知以 followUp 唤醒新一轮并带退出码与末行 → 输出文件两行完整；`subagent` 子进程跑通并回报自身 tag `v0.18.0`。
- **本机迁移**：卸载 `npm:@bytetrue/pi-background-terminal` 与 `npm:@bytetrue/pi-subagent` → `pi install git:…@v0.18.0` → 安装器写入 5 个 drop-in（含 vendor 伴生脚本），`pi -p` 正常返回。
- **工具名冲突实测**：把 `pi-context-guard.ts` 临时装进 extensions 目录后 Pi 拒绝启动——`Tool "ctx_reduce" conflicts with …`，并提示 `pi -ne`；后加载的 `@cortexkit/pi-magic-context` 整个扩展加载失败。实验后已移除。

## 未确认问题 / 遗留

- **context-guard 与 magic-context 不可能共存**：原计划用运行时检测让前者自动让位，实测该分支不可达（冲突在加载期即失败）。结论改为只做安装器侧预防，见 `spec/index.md` 与 `decisions/001`。
- **交互菜单未在新仓实测**：非 TTY 环境用逐文件下载等价验证，菜单的箭头交互与 `--all` 未在真实终端跑过。
- **旧仓本地工作区仍有未提交改动**（context-guard 的 pruning 升级与一条未跟踪 issue 文档）：内容与本仓已提交版本逐字节一致，随旧仓归档不再维护。

## 推进视图

本 Epic 无独立 issue：切片在边界内直接推进，证据见上。关闭条件已满足，结论已毕业到 `spec/index.md`（分发形态、工具名唯一、已排除方案）与 `decisions/001-copy-in-distribution-no-npm.md`。
