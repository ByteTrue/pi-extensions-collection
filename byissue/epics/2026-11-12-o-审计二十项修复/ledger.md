# 二十项修复台账

接着做或改这张表之前，先读同目录 `spec.md` 的「已定方案与必须守住」。

## 拆分来源

用户 2026-11-12 原话「那 20 个」指同一对话上一轮审计报告的编号 1–20。本表逐项转录，每个编号一行，不合并、不重排。说整个 Epic 完成前，重读该报告并逐行对照本表；新增问题另列，不占原编号。

## 结论取值

- `没做`：初始值。
- `在做`：单元开工时。
- `做了`：证据写本轮实际跑过的测试、命令与结果。
- `不做`：只能由用户明确决定，写原话或 decision 路径。
- `不适用`：只用于没有运行时行为的项。

| 项 | 单元 | 结论 | 证据 |
|---|---|---|---|
| 01 不受信任项目不能在执行时替换内置 reviewer | U1 | 做了 | 公共 execute + fake CLI 在旧实现收到项目 prompt；修复后使用内置 reviewer/read,bash，不含项目模型或 write |
| 02 项目角色名不能向父工具提示注入换行或控制字符 | U1 | 做了 | 换行/129 字名称在旧 roster 出现；修复后过滤，点号/空格/中文名仍可解析，security 3/3 + typecheck |
| 03 background 临时目录防泄露、预创建与任意路径删除 | U1 | 做了 | journal/pid/start 三种 symlink 旧实现均误删/误杀；现逐文件 lstat+regular+owner 校验，不安全项跳过整份 journal，reap 8/8 + typecheck |
| 04 subagent journal 校验 session/PID，不能杀错进程或删任一路径 | U1 | 做了 | journal/start symlink 与 stale start+session marker 旧实现均失败；现文件级校验、start 相等优先、完整 --session 参数回退，reap/run 14/14 + typecheck |
| 05 显式 `tools: []` 启动无工具 child | U1 | 做了 | 旧 argv 含 `--tools read,bash`；修复后含 `--no-tools`，空 settings override 同样生效，security 3/3 + typecheck |
| 06 RPC abort 能结束等待中的 ask_user 对话框 | U2 | 做了 | 注册工具 abort 测试旧实现未传 signal；修复后 RPC select 收到同一 AbortSignal 并返回 dismissed，ask-user 31/31 + typecheck |
| 07 `maxTurns` 在当前 turn 的工具结束后、下一 turn 开始前生效 | U3 | 做了 | 旧实现工具 0 个且自然完成误暂停；修复后工具 succeeded、自然完成 succeeded，原 maxTurns 进程树测试也通过 |
| 08 reload 与元数据清理失败都不能丢后台完成通知 | U4 | 做了 | process-global pending+一次性 legacy reconciliation；真实 HEAD init 前/后、A/B session 均送达且无串流，manager 复用；send 失败保留，普通边界重试通过 |
| 09 background 启动竞态、macOS 进程组与外部 live journal 的回收安全 | U4 | 做了 | stale start+pi-bg marker 的 Node 探针旧实现实测 kill；现双方 start 存在时必须相等，仅缺失时 marker 回退，reap 8/8 |
| 10 reload 只恢复成功执行的 `ctx_reduce` | U2 | 做了 | aborted fixture 在旧实现把 2500 字结果变成占位符；修复后保留原文，成功 reduce 的恢复测试也通过 |
| 11 Escape 通过真实 settled 事件暂停 active goal | U2 | 做了 | 真实 `agent_settled {aborted:true}` 在旧实现保留 active；修复后持久化 paused + interrupted，goal typecheck 通过 |
| 12 abort 不触发 compact，并写明 goal loop 的 idle-only 限制 | U2 | 做了 | aborted 高用量旧实现 compact 1 次、修复后 0 次；auto-compact 8/8 + typecheck，README 已写明 goal loop idle-only |
| 13 输出写入失败不能显示为无错误的成功完成 | U4 | 做了 | 新增 exit 0 + ENOSPC 通知在旧实现显示 completed；修复后显示 failed 与 Error，相关 29/29 通过 |
| 14 bash-timeout 与 context-prune 保留 `structuredContent` | U2 | 做了 | SDK 同时加载两扩展，真实 ExtensionRunner 的 timeout 与 nudge patch 均保留 `{answer:42}`；旧实现 timeout patch 丢失该字段 |
| 15 并行 ask_user 不提前恢复 spinner | U2 | 做了 | 注册定义旧值 undefined，现为 `executionMode: sequential`；ask-user 31/31 + typecheck，spinner 现有用例无回归 |
| 16 child 失败时保留已有回答并附真实错误 | U3 | 做了 | 旧输出仅 FATAL_AFTER_STREAM；现 finalText 为空时回退 textTail，输出同时含 STREAMED_PARTIAL_ANSWER 与真实错误，run-lifecycle 4/4 |
| 17 BySpace 保留最终进度与指针，shutdown 发终态，失败上报可恢复 | U3 | 做了 | 摘要 details 复用 canonical builder；单对象/多数组经 Go overlay 交 BySpace 原函数均 completed，raw status/sessionFile/cwd 保留；fast 正文也回退 child session+cwd |
| 18 scope picker 只读写所选 scope 的值 | U3 | 做了 | global/a+low vs project/b+high 在旧实现把 project/b 写入 global；修复后 global 两字段不变，command 4/4 + typecheck |
| 19 完成历史与单批后台通知有界，运行中和未通知记录不淘汰 | U4 | 做了 | retired sweep 保护+shutdown 清理；600/2000 摘要分片与第二片失败无遗漏重复；101×1MiB 附加堆约2.1MiB；settledAt 保留最后完成长任务；details.error=215/原100000 |
| 20 自定义 cwd 出现在暂停和菜单生成的 resume 调用中 | U3 | 做了 | 暂停输出与 `/subagent` How to Resume 在旧实现均无 cwd；修复后两处包含同一 resolved child cwd，相关 4/4 + typecheck |

## 全量验证

- `npm run typecheck --workspaces --if-present`：7 个 workspace 全部通过。
- `npm test`：24 个测试文件、344/344 通过；其中 background 74、subagent 127。
- `node scripts/check-manifest.mjs`：7 个扩展全部匹配。
- Pi SDK 联合加载：7 个扩展，0 errors、0 warnings。
- HEAD 旧源码快照：`structured-content.test.ts` 与原 `history.test.ts`（现并入 notification）均失败；其余新增反例已在各自修复前复现。

## 接续点

三向审查追加的全部阻塞项、settledAt、fast-child 附加项与两项精简均已实现。最终全量 344/344、全部 workspace typecheck、manifest、SDK 七扩展联合加载通过。正确性 OK、过度设计 Ship、对抗性 OK（fast-child 终审亦 OK，No issues found）。首次 legacy 升级 at-least-once 限制已写 README/Notes。按用户要求不自动关闭 Issue/Epic、不提交或推送。
