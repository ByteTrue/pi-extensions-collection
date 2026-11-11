---
kind: issue
title: "分发改为 git 包安装，并把 context-guard 拆成 prune 与 auto-compact"
type: refactor
created: 2026-11-11
---

# 分发改为 git 包安装，并把 context-guard 拆成 prune 与 auto-compact

## 目标与范围

用户原话（2026-11-11，本次对话）：「我在想我们的分发方式能不能做到比如直接把我们仓库 clone 到一个目录，就可以用了，然后更新就只需要 pull」；「1 和 2 都按推荐来」（先做 clone 方案、删 `install.mjs`）；「4 按推荐，5 两个都改名吧」（两个独立目录、两个都改名，命名 `pi-context-prune` + `pi-auto-compact`）；随后改向：「去掉不能引入外部依赖的规则，或者说干掉小扩展这个概念。另一个是官方安装改成 pi install git，本身就没有你所谓可编辑那些需求，如果依赖安装 pi 会帮我解决那就全部走 pi 官方的安装更新方式」。

做这些：

- 根 `package.json` 的 `pi.extensions` 成为分发真源，列 7 个入口。
- 删除 `install.mjs`；`scripts/check-installer.mjs` 换成 `scripts/check-manifest.mjs`；CI 第一步跟着换。
- 官方安装改为 `pi install git:…`，更新 `pi update --extensions`；不再支持复制进 `~/.pi/agent/extensions/`。
- 去掉零依赖约束与「小扩展 / drop-in」概念：依赖写进扩展自己的 `package.json`，由 Pi 安装。
- `pi-context-guard` 拆成 `pi-context-prune`（修剪、提醒、会话文件、`ctx_*` 工具、`/context-prune`）与 `pi-auto-compact`（400k 自动压缩，无工具无命令）。
- 同步根 README、各扩展 README、`spec/index.md` 与决策记录。

不做：400k 阈值可配置、`pi-auto-compact` 的状态命令、不把 `node_modules` 提交进仓库。

## 必须保持的外部行为

`ctx_reduce` / `ctx_search` / `ctx_expand` 的工具名与语义不变；修剪、提醒、会话文件段落的行为不变；`/background`、`ask_user`、`/goal`、`/vendor`、bash 超时不变。

预期变化：`/context-guard` 改名 `/context-prune`；`PI_CONTEXT_GUARD_DRY_RUN` 改名 `PI_CONTEXT_PRUNE_DRY_RUN`；400k 压缩改由 `pi-auto-compact` 承担；装了 `@cortexkit/pi-magic-context` 的机器可以只关 `pi-context-prune`。

## 执行记录

- 拆分：`pi-context-prune.ts` 移除 `COMPACT_AT_TOKENS`、`shouldCompact` 和 `agent_settled` 里的压缩分支，保留修剪全套；新建 `pi-auto-compact/`，自带源码、测试、README、`package.json`、`tsconfig.json`。两边各监听 `agent_settled`，互不依赖。
- 测试：原 46 条里 6 条压缩用例迁到新扩展，另加 1 条新扩展的 module-surface 断言；现在 prune 40 条、auto-compact 7 条。
- 分发：根清单列出 7 个入口；`install.mjs` 与旧检查脚本删除；`check-manifest.mjs` 校验目录与清单一一对应。
- 方向调整：先按 clone 进 `extensions/` 落地并迁移了本机；用户随后决定改走 `pi install git:` 并放弃可编辑 checkout 与零依赖约束。clone 决策标记为被取代，README / spec / 各扩展 README / package.json 描述同步改回 git 包装。本机的 clone 暂时保留可用，等提交 push 后再换成官方安装。

## 验证

- `node scripts/check-manifest.mjs` 输出 `manifest OK (7 extensions)`。
- `npm run typecheck --workspaces --if-present` 7 个工作区全过。
- `npm test` 336 passed，拆分前 335（多出 1 条新增的 module-surface 测试），无失败。
- 真仓库加载：临时 `PI_CODING_AGENT_DIR`，把仓库软链成 `extensions/pi-extensions-collection`，用 `discoverAndLoadExtensions` 列出结果，7 个全部加载，`errors=0 warnings=0`。
- 工具名冲突与开关：探针注册 `ctx_reduce` 与 prune 同时存在时报冲突；包级过滤 `{source, extensions: ["-pi-context-prune/pi-context-prune.ts"]}` 后只加载 6 个，正是 `pi config` 写入的格式。
- 官方安装：`pi install git:github.com/ByteTrue/pi-extensions-collection` 在临时 agent 目录跑通——clone 到 `~/.pi/agent/git/github.com/ByteTrue/pi-extensions-collection`，执行 `npm install`（added 6 packages），settings 记下 `git:…`，`pi list` 可见。当前 GitHub 的 `main` 还没有这次清单提交，所以装下来是 0 个扩展，符合预期。
- 官方更新（用本地 `git daemon` 快照模拟远端新提交）：把该包的 origin 指向快照后跑 `pi update --extensions`，输出 `f29332d -> 13db6f4`，Pi 做了 fetch、`reset --hard`、清掉 `node_modules/`、重装依赖；随后 full resource loader 从包路径解析出 7 个扩展，工具与命令符合预期。
- 两条方法教训：`pi --help` 在冲突时仍退出 0，退出码不能当证据，冲突文本才是；`discoverAndLoadExtensions` 是原始发现，不应用 settings 的 `-` 条目，禁用证据要用完整 resource loader 或冲突探针。

## 未验证 / 接续点

- 真实交互会话里 `/context-prune`、`/background`、`ask_user` 是否都在，需要重启 Pi 看一眼；本轮只验证到加载层。
- 本机现在是临时状态：`~/.pi/agent/extensions/pi-extensions-collection` 是从 GitHub clone 后被工作区覆盖的 dirty checkout，旧副本在 `~/.pi/agent/extensions-backup-2026-11-11/`。push 之后要删掉这个目录，再 `pi install git:github.com/ByteTrue/pi-extensions-collection`，然后重启验证 7 个扩展。
- 迁移完成后 `extensions-backup-2026-11-11/` 可以删除；`settings.json` 的 `extensions` 为空，不需要改。
- `pi update --extensions` 在 checkout 里会留下被 npm 改写的 `package-lock.json`（工作区变 dirty），不影响加载；下一次更新会先 `reset --hard` 再 `clean -fdx` 清掉。

## 关闭时要回写

`spec/index.md` 已在本次更新；关闭时复核「依赖写进扩展 package.json」「工具名唯一」「分发清单」三条是否仍成立。机器切到官方安装后补一条实测：真实会话里 7 个扩展的加载结果。
