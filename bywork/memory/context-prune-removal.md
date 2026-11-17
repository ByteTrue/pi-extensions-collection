# context-prune 已删除：实测净亏 47%

## 结论

`context-prune`（确定性剪枝 + 提醒 + `ctx_*` 工具 + `/context-prune`）于 2026-11-13 整体删除。不要重建同类「剪掉旧工具输出省上下文」的扩展，除非下面的重访条件成立。

- 在「1M 窗口 + cacheRead ≈ input/50」的组合上（用户 80% 的工作在此），剪枝 peak 降 35%、正确性不变，但每轮 pass 重写被剪前缀，同样工作量贵 47%。一批剪枝要 `n ≥ (后续内容/剪掉量) × (input 价/cacheRead 价)` 次后续请求才回本，实测需要 150–250 次，实际每轮约 10 次。
- 窗口从来不是瓶颈：294 个真实会话 peak prompt p90 252k、最高 697k，只有 8 个文件出现过 compaction。43% 内容可剪（6.93M token）买不到稳定性。
- 提醒通道无可测收益（$0.220 vs $0.219），真实语料只驱动 4% 剪枝量（52 条 nudge、35 个会话、1 轮内转化 20 条；`ctx_expand` 0 次、`ctx_search` 4 次）。
- 删除不是因为实现有错：两处真实缺陷（nudge 的 `bash <id>` 格式诱发错误 id 往返；`ctx_search` 摘录锚在第一个命中词而非整句）删除前已修，但没有服务对象。

## 依据

- 类型：用户决定（2026-11-13 原话：「现在看来这对于超长会话其实没什么帮助」「可以把这个扩展直接砍掉了」）+ 可重跑证明。
- 9 轮 A/B（3 臂 × 3 轮，deepseek-flash 1M 窗口，每轮 4 × 268KB 原始工具输出，探针问只存在于原始输出里的精确事实）：无扩展 $0.149 / peak 279k，只剪枝 $0.219 / 182k，剪枝+提醒 $0.220 / 182k，正确性都是 71–72/72。反解单价 input $0.30/M、cacheRead $0.006/M（50 倍）、output $1.17/M，回代误差 <1%。
- harness 配方、数据格式与措辞坑（探针不能写「不在了就写 LOST」；识别 nudge 必须要求 tool result 以 `</system-reminder>` 结尾）：`archive/byissue/notes/2026-11-13-context-prune-ab.md`；拍板原文：`archive/byissue/decisions/2026-11-13-remove-context-prune.md`。

## 重访条件

只覆盖已测组合。小窗口（272k 级，compaction 真的介入）或弱缓存折扣（cacheRead ≈ input/4）的供应商没有验证；必须在那类环境跑长会话时，按存档 harness 重测再决定。