# 后台通知合批

2026-11-20，用户反馈 background/subagent 通知在回答结束后逐条出现，每条都会再唤起模型。

原因：两个扩展各自于 turn_end 生成 followUp 消息；Pi 默认逐条消费 followUp，而且要等当前工具循环和 steering 结束。扩展内部的小批次会在宿主队列中积累，最后形成多次接续。

修改：shared/completion-delivery.ts 统一收集同一会话两种来源的待发消息，保留原有 customType/content/details。前面的卡片用 triggerTurn:false 加入上下文，最后一张用 steer + triggerTurn:true 请求一次接续。忙时在轮次边界发送；空闲时合并 50 ms 内的完成结果。保留发送失败重试和重载交接，开始运行/关闭时取消空闲定时器。

Pi 1.6.0 离线宿主实测（Windows）：运行 node --experimental-strip-types bywork/work/notification-batching/probe.mjs。使用内置 faux provider 和临时配置，不调用真实模型。

- 旧 followUp：初始请求 + 三张通知，共 4 次模型请求。
- 新共享发送，忙时：初始请求 + 一次接续，共 2 次请求。
- 新共享发送，空闲时：初始请求 + 一次接续，共 2 次请求。
- 新共享发送，agent_settled 回调中：初始请求 + 一次接续，共 2 次请求。
- 新方案的接续请求同时包含三张通知的正文；三张卡片和 details 均保留在会话记录中。

全项目回归：349 项通过，12 项因平台跳过；五个 workspace 的 TypeScript 检查（含 noUnusedLocals）通过，git diff --check 通过。单元回归覆盖跨来源合批、会话隔离、空闲窗口、失败重试、重载替换、关闭取消，以及现有的通知长度限制与 Paseo 回放格式。

修改源码不会清空正在运行的旧宿主 followUp 队列；需加载更新后的扩展，历史队列仍可能继续投递。旧版本 Pi 的具体发送顺序未实测。
