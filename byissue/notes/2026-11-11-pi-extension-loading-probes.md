---
kind: note
title: "Pi 扩展加载与开关的实测边界"
created: 2026-11-11
---

# Pi 扩展加载与开关的实测边界

测于 Pi 1.5.2（`~/.pi/agent/install/releases/1.5.2`），macOS，Node 22。方法是给每次验证一个临时 `PI_CODING_AGENT_DIR`，不碰真实配置。

## 发现规则

- 自动发现只扫一层：`<agentDir>/extensions/*.ts|js`，以及直接子目录里有 `index.ts` / `index.js`，或 `package.json` 带 `pi.extensions` 清单时按清单加载。
- 安装一个包（`pi install`，npm 或 git）时只读那个包根目录的 `package.json` 清单，不会扫描 npm workspaces 的子包。workspace 根没有清单时，整仓安装会得到 0 个扩展；这正是旧 monorepo 只能逐包 npm 分发的原因。
- 从 clone 目录加载的扩展，第三方 import 按 Node 规则从 `<clone>/node_modules` 解析（2026-11-11 用假包实测）。Pi 只把宿主模块别名到自己的副本，其余裸 import 不做隔离。
- 依赖的自动安装只在包路径上：`pi install git:` 克隆后跑 `npm install --omit=dev`，更新时 `git reset --hard` + `git clean -fdx` 再跑一遍；clone 进 `extensions/` 的路径不会安装任何依赖。
- `pi config` 只让 package manager 解析包（缺包时也会 clone），不加载扩展代码。所以存在工具名冲突时，还能先用它关掉一个再启动。
- `pi update --extensions` 更新后会留下被 npm 改写的 `package-lock.json`，checkout 变 dirty，但不影响加载；下次更新会 reset 掉。
- 软链目录会被跟随，所以 `extensions/<名>` 可以指向任意位置的 checkout。
- `discoverAndLoadExtensions()`（从已安装包的 `dist/index.js` 导入）只做原始发现。settings 里 `extensions` 的 `-路径` 条目由 resource loader / package manager 在它之前过滤，所以拿这个函数验证「关掉某个扩展」会得到假阳性。

## 开关与冲突

- `pi config` 给顶层扩展写的是相对 agentDir 的条目，例如 `-extensions/pi-extensions-collection/context-prune/context-prune.ts`。加上 `-` 后该扩展不加载。
- 工具名冲突在加载期判定，报错点名冲突扩展的路径。
- `pi --help` 在冲突时仍退出 0，退出码不能当证据，冲突文本才是。

## 探针配方

- 临时 agent 目录 + `PI_CODING_AGENT_DIR=...`，把仓库软链到 `extensions/<名>`，跑 `pi --help`。
- 验证清单真的加载：写 10 行 Node 脚本调 `discoverAndLoadExtensions([], cwd, agentDir)`，打印每个扩展的 `tools` / `commands` 与 `errors`。
- 验证某项被关掉：在同一目录放一个注册同名工具的探针扩展，看冲突报错是否消失。
