---
kind: issue
title: "paused 的 goal 拿不到 goal_done"
type: ff
created: 2026-11-09
---

# paused 的 goal 拿不到 goal_done

自动续跑那一轮出错后 goal 被暂停，剩下的工作由用户接着推进，做完时 agent 手里却只剩 `goal_start`，只能让用户 `/goal clear`。现在 paused 也留着 `goal_done`，收尾照常记进 goal。

- 改动：`pi-goal/pi-goal.ts` 的 `syncTool` 在 active 或 paused 都挂 `goal_done`，暂停仍然停掉自动续跑；`goal_done` 的描述改成 active or paused，没有 goal 时的提示文案改准。`pi-goal/README.md` 与已装副本 `~/.pi/agent/extensions/pi-goal.ts` 同步。
- 验证：`npm run test --workspace=pi-goal` 36 个测试通过（新增 paused 收尾、恢复 paused goal 两例），`npm run typecheck --workspace=pi-goal` 通过。
- byissue：无影响。`spec/` 没有写过 pi-goal 的工具可用性，其阅读路径本来就把扩展行为指向各目录 README。这次撞到的外部事实另记 `notes/2026-11-09-boldapi-inline-tools-tool-removal.md`。

顺手发现：paused 时仍然不往系统提示注入 `<goal>` 段，压缩后目标可能从上下文里淡出，不在本次范围。
