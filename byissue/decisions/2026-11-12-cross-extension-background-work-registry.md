---
kind: decision
title: "扩展之间用可选的进程内注册表共享后台工作状态"
created: 2026-11-12
superseded-by: ""
---

# 扩展之间用可选的进程内注册表共享后台工作状态

用户原话（2026-11-12）：「反正都是我们自己的扩展集合，这个耦合对体验的提升我觉得可以做。」据此让 `background-terminal` 与 `subagent` 在 `globalThis[Symbol.for("pi-extensions.background-work")]` 注册一个按 session 查询运行中任务的 provider，`goal` 与 subagent 完成通知读取它。

选进程内 symbol 而不是共享模块或文件：扩展由 Pi 各自通过 jiti 加载，互相 import 会造出安装顺序与路径耦合；symbol 注册表没有依赖、加载顺序无关，`/reload` 重新求值后按扩展 id 替换 provider，不会堆叠。

它是可选的：没有 provider 时消费者退回原行为，单独安装任何一个扩展都不报错。适用范围是这个仓库的扩展集合，长期有效；以后新增后台任务类型时沿用同一契约。
