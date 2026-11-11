---
kind: issue
title: "把 pi-subagent 收进 collection，分发收敛为一个 git 包"
type: refactor
created: 2026-11-11
---

# 把 pi-subagent 收进 collection，分发收敛为一个 git 包

## 目标与范围

用户原话（2026-11-11，本次对话）：「既然这样，隔壁我们的 subagent 扩展能收进来吗？」，随后选定「收进来」。

做这些：

- 把 `ByteTrue/pi-subagent` 的 `src/`、`agents/`、README 搬进 `pi-subagent/`。
- 根 `pi.extensions` 增加 `./pi-subagent/src/index.ts`；根 README 表格加一行。
- 旧仓加归档提示并 archive；本机卸载旧包、更新 collection。
- 打第一个 tag `v1.0.0`。

不做：改写 subagent README 的功能段；保留它的 npm 元数据（`files`、`keywords`、`repository`）。

## 必须保持的外部行为

`subagent` / `subagent_status` / `subagent_stop` 三个工具名与语义不变；`/subagent` 菜单不变；92 条测试逐条通过；`agents/reviewer.md` 与 `src/` 的相对位置不变（内置角色按 `import.meta.url` 找 `../agents`）。

## 执行记录

- 搬入 `src/`、`agents/`、README；丢弃它自己的 `tsconfig.base.json`（与根逐字相同）和 `package-lock.json`（根统一）。
- `package.json` 改为 private workspace `pi-subagent`，只留 `test` / `typecheck` 脚本与 peer / dev 依赖；版本归 0.0.0，发布靠 git tag。
- 根清单加一条；根 README 表格加一行；subagent README 的标题与安装段改为 collection + `v1.0.0`，drop-in 复制段删除。
- `spec/index.md` 从 7 个改为 8 个，记录「subagent 曾另立仓库、2026-11-11 收回」；新增 decision `2026-11-11-merge-subagent.md`。

## 验证

- `node scripts/check-manifest.mjs` → `manifest OK (8 extensions)`。
- `npm run typecheck --workspaces --if-present` 8 个工作区全过。
- `npm test` 428 passed（原 336 + subagent 92），无失败。
- 临时 agent 目录软链整仓后加载：8 个扩展全部加载，`subagent` / `subagent_status` / `subagent_stop` 与 `/subagent` 都在，`errors=0`。
- 已提交 `b49f183` 并 push，打 `v1.0.0` 并推 tag；旧仓 README 加了归档横幅，`gh repo archive` 后 `isArchived=true`。
- 本机先 `pi remove git:github.com/ByteTrue/pi-subagent@v0.18.0`，再 `pi update --extensions`（`2825cd8 -> b49f183`，重装 8 个包）；完整 loader 列出 11 个扩展，subagent 的工具来自 collection 路径，`errors=0`；旧 checkout 目录已被 remove 清掉。

## 接续点

- 重启 Pi 后在真实会话里确认 `/subagent` 菜单与一次 subagent 调用；本轮只验证到加载层。
- 确认后可以关闭这条 issue；旧仓已归档，`v0.18.0` 的安装命令不再可用，外部引用需要改成 collection 的 tag。

## 关闭时要回写

`spec/index.md` 已更新；关闭时复核 subagent 的入口路径与 `agents/` 位置说明，以及「一个包一条版本轴」的代价是否仍被接受。
