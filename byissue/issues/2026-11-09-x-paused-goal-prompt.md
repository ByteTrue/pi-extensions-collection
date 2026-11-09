---
kind: issue
title: "paused 的 goal 在系统提示里消失"
type: bug
created: 2026-11-09
---

# paused 的 goal 在系统提示里消失

## 修好后的样子

goal 被暂停后，模型仍然在系统提示里看到这个目标，知道它是 paused、自动续跑已经停，以及目标已经达成时该调 `goal_done`。长会话压缩或 `/tree` 之后，目标不会只剩转录里几句旧对话。

## 现场与根因

`pi-goal` 的 `before_agent_start` 只在 `goal.status === "active"` 时注入 `<goal>` 段（`pi-goal/pi-goal.ts` 末尾）。paused 的含义是停掉自动续跑，不是清掉目标：状态还写在会话里，`/goal resume` 接着跑，`goal_done` 也能收尾。所以 paused 之后模型对目标的认识只靠转录，压缩一次就可能认不出要完成的是哪件事。

上一轮把 `goal_done` 留在 paused 里时暴露出来：工具在，目标却不一定在上下文里。不只出错暂停会踩到，用户 `/goal pause` 之后继续聊天也一样。

## 方案

给 `goalSection()` 加 paused 版本，`before_agent_start` 在 goal 未完成时（active 或 paused）都注入：

- paused 文案说清自动续跑已停、不要自行续跑，`/goal resume` 与 `/goal clear` 由用户决定，目标已经验证为真时调 `goal_done` 收尾。
- done 和没有 goal 时照旧不注入。
- 段落只随状态变化，仍然留在缓存前缀里。

包含 `goalSection`、hook 条件、测试与 README。不包含 paused 状态下自动续跑，也不加新的 `/goal` 子命令。

## 验证

- `pi-goal` 测试：paused 段落包含目标、paused 字样和 `goal_done`，并明确不自动续跑；active 文案不变；done 与没有 goal 不注入；既有测试不回归。
- `npm run typecheck --workspace=pi-goal`。
- 用原来坏的方式再看一眼：把 goal 置为 paused 后跑 `before_agent_start`，段落从 undefined 变成包含目标。

## 执行记录

2026-11-09 完成实现。`goalSection()` 增加 paused 版本，`before_agent_start` 在 goal 未完成（active 或 paused）时都注入；active 文案逐字未变，done 与无 goal 仍不注入。

验证：`npm run test --workspace=pi-goal` 37 个测试通过（新增 paused 段落与 done 无段落两例），`npm run typecheck --workspace=pi-goal` 通过，全仓 333 个测试与 6 个 workspace 的 typecheck 通过。原来的断言 `paused.sections.goal` 为 undefined 已改成检查 paused 段落内容，正好是修好前后的同一条路径。`pi-goal/README.md` 的行为表同步。

沉淀：无新增，`byissue/spec/` 仍不描述单个扩展的行为。

## 关闭回写

行为变化进 `pi-goal/README.md`。`byissue/spec/` 不描述扩展行为，无需回写。

## 关闭结论

2026-11-09 关闭。目标达成，范围未扩大：只改了 `goalSection()`、`before_agent_start` 条件、测试与 README 行为表，没有新增命令或自动续跑。证据是 37 个 `pi-goal` 测试、全仓 333 个测试与 6 个 workspace 的 typecheck，以及那条从 undefined 改成检查段落内容的断言。

毕业回写：无。结论是单个扩展的行为，`pi-goal/README.md` 已经是它的真源，`spec/` 的阅读路径也把扩展行为指向各目录 README，没有能从代码重建不出来的项目级约束需要搬。

残留风险：没有在真实 Pi 会话里观察模型看到 paused 段落后的表现，模型会不会因为看到目标而主动续跑，目前只靠文案里那句「不要自行续跑」约束，属于推断。
