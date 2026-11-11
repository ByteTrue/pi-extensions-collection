---
kind: decision
title: "subagent 收进 collection，分发收敛为一个 git 包"
created: 2026-11-11
superseded-by: ""
---

# subagent 收进 collection，分发收敛为一个 git 包

用户原话（2026-11-11，本次对话）：「既然如此，隔壁我们的 subagent 扩展能收进来吗？」；选择「收进来」。适用范围：仓库划分与版本轴。

`ByteTrue/pi-subagent` 的源码、测试与 `agents/` 搬进本仓的 `pi-subagent/`，根清单增加一条入口；旧仓加归档提示后 archive。官方安装与更新只剩一条：`pi install git:github.com/ByteTrue/pi-extensions-collection@v1.0.0` 与 `pi update --extensions`。第一个 tag 用 `v1.0.0`，因为它同时是 subagent 旧 `v0.18.0` 安装方式的断点。

这条取代 2026-11-04 分裂 epic 里「subagent 另立仓库、按 git tag 分发」的结论。代价是 8 个扩展共用一条版本轴：subagent 不再单独升级，旧仓的 `@v0.18.0` 安装命令失效。
