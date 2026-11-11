---
kind: decision
title: "官方安装走 pi install git，放弃复制分发与零依赖约束"
created: 2026-11-11
superseded-by: ""
---

# 官方安装走 pi install git，放弃复制分发与零依赖约束

用户原话（2026-11-11，本次对话）：「去掉不能引入外部依赖的规则，或者说干掉小扩展这个概念。另一个是官方安装改成 pi install git，本身就没有你所谓可编辑那些需求，如果依赖安装 pi 会帮我解决那就全部走 pi 官方的安装更新方式」。适用范围：长期分发形态，以及一个扩展能带什么。

官方安装改为 `pi install git:github.com/ByteTrue/pi-extensions-collection`，更新用 `pi update --extensions`。Pi 在 clone 后跑 `npm install --omit=dev`，更新时重置 checkout 再装一遍，所以扩展可以声明运行时依赖；复制进 `~/.pi/agent/extensions/` 与安装器脚本都不再支持。checkout 归 Pi 管、不能就地改，这一点被明确接受。

这条取代 `2026-11-11-clone-and-pull-distribution.md`。
