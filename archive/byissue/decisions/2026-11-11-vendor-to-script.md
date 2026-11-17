---
kind: decision
title: "vendor 扩展退役，模型配置统一走 CFG 的 vendor.mjs"
created: 2026-11-11
superseded-by: ""
---

# vendor 扩展退役，模型配置统一走 CFG 的 vendor.mjs

用户原话（2026-11-11，本次对话）：「我想把 vendor 砍掉，换成脚本了，我突然发现其实这扩展，用一个交互式脚本应该也能搞定，甚至可以和 cfg 那边的那个技能合并，一个脚本，可以ai用也可以人类用，我想手动添加也可以直接通过脚本简单快速添加」。适用范围：长期。

`vendor` 扩展从本仓删除；读写 `models.json` 的能力合并进 CFG 的 `provider-model-config` 技能脚本 `vendor.mjs`：`add-provider` / `add-model` 带 flag 给 agent、不带参数时逐项提示给人类，`set-key` 保留。代价是保存后不能刷新运行中的 Pi（要重开 `/model` 或 `/reload`），以及 TUI 的模糊选择不再有；脚本改写 opencode 的 JSONC 时只在无注释时进行，有注释直接拒绝。

依据（2026-11-11 实测）：脚本在临时 agent 目录加 provider/model 后 `pi --help` 正常启动；flags 与交互两条路径都跑过；`node --test scripts/vendor.test.mjs` 10 条通过。
