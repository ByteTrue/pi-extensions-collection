# Project Spec

## 这个项目是什么

`pi-extensions-collection` 是一个**零安装分发**的 Pi 扩展集合：每个 `pi-*` 子目录是一个 drop-in 扩展，把文件复制进 `~/.pi/agent/extensions/` 就能运行——没有 npm 发布、没有构建步骤、目录里不需要 `node_modules`。

它来自 `ByteTrue/pi-package-mono`（已归档、只读）的分裂：5 个原 small-extension 加 1 个原 npm 包（background terminal）合到这里；subagent 另立 `ByteTrue/pi-subagent`，按 git 分发。

## 统一语言

- **drop-in**：复制文件即生效的扩展。本仓唯一的分发形态。
- **伴生资源**：必须与扩展文件一起复制的非入口文件。目前只有 `pi-vendor/scripts/*`（`/vendor-ai` 命令以相对路径调用它们）。
- **安装器清单**：`install.mjs` 的 `EXTENSIONS` 数组。它是分发真源，`scripts/check-installer.mjs` 守住它与 `pi-*` 目录一一对应。

## 不可破的约束

- **零第三方运行时依赖**：扩展只能 import `node:*` 内置模块、Pi 宿主模块（`@earendil-works/*`、`typebox`，Pi 会映射到自己的副本）和同目录文件。`~/.pi/agent/extensions/` 下没有 `node_modules`，`cp` 也不会跑安装——要 npm 依赖就不再是 drop-in。
- **子目录 `package.json` 永远 private、永不发布**：它存在只为让 CI 能 typecheck 和跑测试。
- **宿主模块不得进 `dependencies`**：物理拷贝会绕过 Pi 的扩展模块映射，造出重复的类、注册表和初始化开销（Pi 会就此报警告）。它们只属于 `peerDependencies`。
- **工具名必须全局唯一**：Pi 遇到两个扩展注册同名工具会**拒绝启动**，后加载的那个扩展整个不加载（连它别的工具一起失去）。`pi-context-guard` 的 `ctx_reduce` / `ctx_search` / `ctx_expand` 与 `@cortexkit/pi-magic-context` 同名，所以安装器在用户设置里读到该包就跳过 `pi-context-guard`。这件事只能在安装器里判断：扩展在加载期调用 `pi.getAllTools()` 会抛「runtime not initialized」，看不到别人注册了什么。

## 做 / 不做

**做**

- 维护 6 个 drop-in，保持「复制即用」。
- 安装器覆盖即更新：不打 tag、不发版、不做版本提示。
- 文档随行为改：用户可见的行为变化同时改该目录 `README.md` 与本文件。

**不做**

- 不发 npm，不加 `publishConfig` 或任何发布字段。
- 为了功能给 drop-in 引入 npm 依赖或构建步骤。真要依赖，就另立仓库按 package 分发——subagent 就是这样出去的。
- 不做插件市场、不做通用框架。

## 已排除的方案

- **拍平后再加依赖**：`pi-background-terminal` 被从 7 个模块拍平成单个 761 行文件（`pi-background-terminal.ts`），前提正是它的 import 只有宿主模块和 `node:*`。若哪天它需要真依赖，正确做法是退回 package 分发，而不是在扩展目录里塞 `node_modules`。
- **运行时自我禁用**：曾在 `pi-context-guard` 里加「`session_start` 时比对 `getAllTools()`，被顶掉就停掉所有 hook」。实测冲突在**加载期**就失败，该分支永远不可达，已回滚（41 个测试恢复原状）。冲突只能靠安装器预防，不能靠运行时发现。
- **opt-in 默认不勾**：安装器曾让 `pi-context-guard` 默认不勾选。现改为全部默认勾选，冲突改由安装器按已装包判断并跳过，机制只有一处。

## 阅读路径

- 每个扩展的行为与安装方式 → 各目录 `README.md`
- 分裂的来源、验证证据与遗留风险 → `byissue/epics/2026-11-04-x-仓库分裂与分发形态收敛/spec.md`
- 停发 npm 的拍板 → `byissue/decisions/`
