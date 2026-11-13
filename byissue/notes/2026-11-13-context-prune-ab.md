---
kind: note
title: "context-prune 的 A/B harness 与实测数据（删除前的存档）"
created: 2026-11-13
---

# context-prune 的 A/B harness 与实测数据

测于 2026-11-13，Pi 1.5.2，`bytetrueapi/deepseek/deepseek-flash`（1M 窗口，max-out 384k），thinking off。扩展已在同日的拍板中删除（`decisions/2026-11-13-remove-context-prune.md`）；这份笔记保存方法与数字，供小窗口或弱缓存折扣的供应商上重测。

## harness

一次 run = 一个 `pi --mode rpc` 进程 + 5 个连续 user turn，全部用干净 workspace（`-a -nc -ns -np -ne --no-mcp`，两臂只差 `-e context-prune/context-prune.ts`），session 单独落盘，逐轮在 `agent_settled` 事件后发下一个 prompt。

- 数据：`payload/b{1..4}.txt`，每个 267KB / 3000 行，行格式 `seq=<n> key=K<8hex> value=<n> tag=ok|bad`，右侧补空格到 88 字符；`slice.sh bN s` 用 `sed -n` 切 500 行（44.5KB，刚好在 bash 工具 50KB 截断线以下）。
- 4 个 bulk turn 各自：跑 6 个 slice 并数 `tag=bad` 行数写进 `notes.md`（要求不做管道，让 44.5KB 原始文本真的进 context）。
- 第 5 个 turn 是探针：问 3 个只存在于原始输出里的精确事实（`seq=11751` / `seq=30751` / `seq=42751` 行的 key+value）。**不要**给 "不在了就写 LOST" 这种措辞：第一版这么写，模型 grep 出三个正确值后仍照字面把最早那条写成 LOST，把 harness 的措辞当成扩展缺陷。
- 指标全部从 session JSONL 的 `usage` 取：`input + cacheRead + cacheWrite` = 该请求的 prompt 总量，`input` 即未命中缓存的量。三臂各 3 轮，成本从 `cost.total` 求和，再用三臂的 (input, cacheRead, output) 线性反解单价，回代误差 <1%。

三臂：`none`（不加载扩展）、`prune`（全量）、`auto`（同代码但 `tool_result` 里加一行环境变量提前返回，silence 提醒通道）。

## 数字

| 臂 | 请求 | prompt 总量 | peak 上下文 | 未缓存 input | cacheRead | 成本/任务 | notes | 探针 |
|---|---|---|---|---|---|---|---|---|
| none | 41 | 6.14M | 279k | 349k | 5.79M | $0.149 | 72/72 | 9/9 |
| prune | 55 | 5.86M | 182k | 597k | 5.26M | $0.220 | 72/72 | 9/9 |
| auto | 58 | 7.26M | 215k | 617k | 6.64M | $0.237 | 71/72 | 9/9 |

反解单价：input $0.30/M、cacheRead $0.006/M、output $1.17/M。

- peak 降 35%，正确性不变，成本 +47%。差价几乎全部来自未缓存 input（+65%）：每轮 pass 把 50–70k token 从 $0.006/M 变成 $0.30/M。
- 请求数在 38–69 之间波动，主要来自模型自己的探索（`ls` / `wc` / 规则写错的 `awk`），与扩展无关；不能据此说提醒通道制造了往返。
- 两臂都没接近 1M 窗口（peak 279k / 984k 阈值），compaction 一次都没触发。
- 副作用：`<session_file>` 系统提示让 6 条扩展臂中的 2 条真的用 bash 去扒自己的 session JSONL（各 8 次调用），其中一次把已被剪掉的 44.5KB 整片重新灌回上下文。
- 扩展的两处真实缺陷在这轮里被发现并修复（删除前）：nudge 提示的 `bash <id>` 格式被整段抄进 `ctx_reduce`（3 次 `Not found in this session`）；`ctx_search` 摘录锚定第一个命中的检索词，把 44.5KB 结果的摘要窗口停在 22KB 外的邻居行，模型因此放弃搜索改用 python 读 JSONL。

## 293 个真实会话的另一半证据

`~/.pi/agent/sessions` 里按 system prompt 的 `<session_file>` 段落筛出 294 个加载过该扩展的会话：43% 的 provider 可见内容可剪（6.93M token），但 peak prompt p90 252k、最高 697k，只有 8 个文件有 compaction 记录；真实 nudge 52 条（35 个会话，1 轮内转化 20 条），`ctx_expand` 0 次、`ctx_search` 4 次。回放 `pruneMessages` 的脚本思路写在拍板里；严格识别 nudge 必须要求 tool result **以** `</system-reminder>` 结尾，否则会把"工具输出里引用了提醒文本"（例如 grep 源码）算成提醒，第一版粗扫多出 26 条假阳性。
