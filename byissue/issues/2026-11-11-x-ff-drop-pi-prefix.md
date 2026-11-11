---
kind: issue
title: "去掉扩展目录的 pi- 前缀，subagent 入口统一成 subagent.ts"
type: ff
created: 2026-11-11
---

# 去掉扩展目录的 pi- 前缀，subagent 入口统一成 subagent.ts

用户原话：「我觉得我们还是让名字好看一点比较好，这样我可选关闭的时候也方便。同时这些名字的 pi 前缀我感觉也都可以去掉？」

- 做了什么：8 个扩展目录去掉 `pi-` 前缀，入口文件、测试文件和 workspace 包名同步改名，`pi config` 现在显示 `ask-user/ask-user.ts` … `vendor/vendor.ts`；`subagent` 加一行转发入口 `subagent/subagent.ts`，不再显示成 `src/index.ts`。
- 改了哪些：8 个目录（用 `git mv` 保历史）、根 `package.json`（workspaces 改成显式 8 项、清单换路径）、`scripts/check-manifest.mjs`（不再依赖 `pi-*` 命名，改为扫有 `package.json` 的顶层目录，并校验 workspaces 与目录一致）、根与各扩展 README、`byissue/spec/index.md`、加载探针 note。历史的 `@bytetrue/pi-*` 包名与 `ByteTrue/pi-subagent` 仓库名保留原样。
- 怎么验证：`node scripts/check-manifest.mjs` 报 8 个；8 个工作区 typecheck 全过；`npm test` 428 passed；临时 agent 目录加载 8 个，路径与工具一一对应。
- byissue：已同步 `spec/index.md`（扩展命名、清单口径）与 note 的示例路径；decisions 与已关闭 issue 保留旧名作为历史。

顺手发现：`pi config` 的条目名由「上一级目录名/文件名」拼出，目录与入口文件同名时必然重复一次；`subagent` 的转发入口就是为此加的。
