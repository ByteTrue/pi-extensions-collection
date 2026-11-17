---
kind: issue
title: "删除 vendor 扩展，模型配置改由 CFG 的 vendor.mjs 负责"
type: ff
created: 2026-11-11
---

# 删除 vendor 扩展，模型配置改由 CFG 的 vendor.mjs 负责

用户原话：「我想把 vendor 砍掉，换成脚本了……一个脚本，可以ai用也可以人类用」。

- 做了什么：删除 `vendor/`（3838 行、172 条测试），根清单与 workspaces 从 8 项变 7 项；README 表格删掉该行；spec 的扩展数同步。模型配置的添加能力落在 CFG 的 `provider-model-config/scripts/vendor.mjs`（`add-provider` / `add-model`），`/vendor` TUI 不再存在。
- 改了哪些：`vendor/`、根 `package.json`、`README.md`、`byissue/spec/index.md`、新增 decision `2026-11-11-vendor-to-script.md`；CFG 侧脚本、测试与三份文档。
- 怎么验证：`manifest OK (7 extensions)`、7 个工作区 typecheck、`npm test` 256 passed（428 − 172）；CFG 侧 `node --test scripts/vendor.test.mjs` 10 条通过，生成的 models.json 能让 `pi --help` 正常启动。
- byissue：已同步 spec 的扩展数；decision 记录退役与脚本归属。

顺手发现：`add-provider --models` 只能建裸模型条目，之后 `add-model` 会因同 ID 已存在而拒绝，补元数据仍走手动编辑；这是刻意的不覆盖策略。
