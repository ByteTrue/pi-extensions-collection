---
kind: issue
title: "context-guard 的提醒与裁剪没有按 Magic Context 的量法"
type: refactor
created: 2026-11-09
---

# context-guard 的提醒与裁剪没有按 Magic Context 的量法

## 修好后的样子

`pi-context-guard` 的提醒和自动裁剪按 Magic Context 的 `{U, T}` 和距离规则工作，400k 压缩保持不变。模型在自己用掉大量工具输出后会定期收到 reduce 提醒，而不是像现在这样 9 小时只收到一次。

## 现场

会话 `2026-11-09T03-08-57-367Z_01a1be47-...jsonl`：9 小时、18 个 user turn、503 个工具结果、1 次提醒（03:09:53）、4 次 `ctx_reduce`（13 个结果、277,286 字符）、0 次 `ctx_expand`。上下文 248k（03:23）长到 403,854（12:14）触发 400k 压缩，之后再没收到提醒。按本扩展的规则回放同一份消息，提醒后一直是 `reclaimable-below-floor` 和 `cadence-growth`，可回收池被自动裁剪压在 26k 到 54k 估算 token。

对照 `cortexkit/magic-context`（本机 `~/workspace/reference/magic-context`，main）：

- `T` 排除 thinking 和 signature（`packages/plugin/src/hooks/magic-context/tail-hygiene-walk.ts` 的 part 分类），也排除提醒自己的文字；我们算进了 thinking。
- `U` 是所有 active、在保护窗口外的可丢内容，不分大小（同上）；我们只有 ≥4000 字符的工具结果才算。
- token 用 UTF-8 字节乘 0.25 或真实 tokenizer（`ctx-reduce-nudge.ts` 的 `TOKENS_PER_BYTE`、`tag-content-primitives.ts` 的 `byteSize`）；我们用字符乘 0.25，中文被低估约 3 倍。
- 保护窗口按 token：`clamp(5% × 可用窗口, min(16k, 8%), 64k)`（`protection-window.ts`、`deriveDefaultProtectedTokens`），这个模型约 43.6k tokens，外加最新 3 个 `ctx_reduce`；我们保护最新 40 个结果或 6 个 user turn，这个会话里只保护了约 7k tokens。
- 自动回收的“远”是 3 个 user turn 或更新内容达到可用窗口的 25%（约 218k tokens），单个输出至少 250 tokens（`shared/reclaim-distance.ts`、`docs/architecture/reclaim.md`）；我们是 6 个 turn 或 40 个结果、最少 4000 字符，而且在每个 user turn 和每次 settle 都可能落地。
- 排队 drop 只在本来要重写前缀的 pass 落地，压力门槛是排队量达到可用窗口的 2%，或连续第 3 个被压住的 pass；我们固定等下一个 agent turn。

结果：自动裁剪把提醒要用的那部分内容提前清掉，提醒的 band 永远到不了。

## 方案

对齐会影响这件事的四件：

1. `{U, T}` 的量法：`T` 只算普通文本、工具参数、工具输出、user/custom 文本，排除 thinking、占位符和提醒文字；`U` 算所有 active 且不在保护窗口内的工具结果，不分大小；token 用 UTF-8 字节乘 0.25。
2. 保护窗口：按 `clamp(5% × (contextWindow − maxTokens), min(16k, 8%), 64k)` 取 token 地板，从最新结果往回累计到地板，至少保护最新 3 个结果，再叠加最新 3 个 `ctx_reduce` 和最新 1 个 `todowrite`。
3. 自动裁剪：结果后面有 3 个 user turn 或更新内容达到可用窗口的 25% 才算“远”，单结果至少 250 tokens；重复调用规则保留。
4. 落地时机：自动裁剪和排队 drop 都要过“值得重写前缀”的门槛，回收量至少是可用窗口的 2%，否则最多压 3 个 pass。压缩仍然在 400k 触发，不参与提醒。

有界简化，不做：Channel 2（U/T ≥ 0.75 且 U ≥ 50k 时发 synthetic user message）、smart drops、tag 存储、按 provider 的 tokenizer 校准。升级触发：改完仍有会话 U/T 长期 ≥ 0.6 却收不到提醒，或 provider 报告的真实 token 与估算相差超过 2 倍。

## 验证

- 单元测试覆盖：`T` 不含 thinking、提醒文字被剥离、`U` 收小结果、保护窗口按 token、距离按 3 turn 或窗口 25%、250 token 下限、2% 压力门槛与第 3 个 pass 强制落地。
- 用同一份会话消息回放：修前 1 次提醒，修后提醒次数显著增加，且每次列出的都是当时最老的可回收结果。
- 全仓 `npm test`、`npm run typecheck`、`scripts/check-installer.mjs`。
- README 的裁剪与提醒两节同步。

## 关闭回写

行为变化进 `pi-context-guard/README.md`；`byissue/spec/` 不描述单个扩展的行为。

## 执行记录

2026-11-09 完成实现，改动集中在 `pi-context-guard/pi-context-guard.ts`：

- `estimateTokens` 改成 UTF-8 字节乘 0.25，`messageTokens` 按 MC 的口径累计 `T`（文本、工具参数、工具输出、user/custom 文本，不含 thinking）。
- `T` 剥掉本扩展追加的 `<system-reminder>`；`U` 收所有 active 且不在保护窗口内的工具结果，不再按 4000 字符过滤。
- 保护窗口改成 token 地板，`contextWindow - maxTokens` 推出可用窗口，公式与 MC 一致；至少保护最新 3 个结果，叠加最新 3 个 `ctx_reduce` 和最新 `todowrite`。
- 自动裁剪改成 3 个 user turn 或可用窗口 25% 的更新内容，单结果最少 250 tokens；重复调用规则保留。
- 落地时机加了 2% 可用窗口的压力门槛，压满 3 个 pass 强制落地；`ctx_reduce` 排队 drop 同门槛。
- 提醒的 hint 改成最老优先，跳过控制面工具和不足 250 tokens 的输出。
- README 的 Pruning 与 Reminders 两节同步。

验证：

- `pi-context-guard` 45 个测试通过，覆盖 T 不含 thinking、提醒文字剥离、小结果计入 U、token 保护窗口、3 turn 距离、250 token 下限、2% 压力与第 3 个 pass 强制落地。
- 全仓 6 个 workspace 334 个测试通过，typecheck 全过，`scripts/check-installer.mjs` 报 6/6。
- 同一份会话消息回放（模型窗口 1M、输出预留 128k、可用窗口 872k）：修前 1 次提醒、54 个结果被裁、约 180k 估算 tokens；修后 3 次提醒（03:56 gentle、04:07 firm、05:39 gentle）、106 个结果被裁、约 248k tokens。提醒的 `U` 从修前的 26k 到 54k 抬到 33k 到 58k，`T` 不再被 thinking 稀释。

残留偏差，未对齐：Channel 2、smart drops、tag 存储、按 provider 的 tokenizer 校准；自动裁剪在 Pi 里没有“本来就要重写前缀”的信号，用 2% 压力门槛和 3 pass 上限近似。

## 关闭结论

2026-11-09 关闭。提醒与裁剪的量法对齐 MC，400k 压缩未动。证据是 46 个 `pi-context-guard` 测试、全仓 335 个测试、6 个 workspace 的 typecheck 与 installer 6/6，以及同一份会话的回放（1 次提醒变 3 次，回收约 180k 变 248k tokens）。

毕业回写：无。行为细节在 `pi-context-guard/README.md`，`spec/` 不描述单个扩展行为。

残留偏差：Channel 2、smart drops、tag 存储、按 provider 的 tokenizer 校准未移植；图片在 `T` 里按 0 计；Pi 没有“本来就要重写前缀”的信号，2% 压力门槛与 3 pass 上限是近似。真实安装后的多会话观察还没做，回放是同一份消息上的规则复现。
