---
kind: issue
title: "context-guard 提醒诱导重复裁剪且请求可能长期排队"
type: bug
created: 2026-11-06
---

# context-guard 提醒诱导重复裁剪且请求可能长期排队

## 目标与范围

只修改 `pi-context-guard` 及其测试、README：让提醒提供足够且值得裁剪的候选，使模型一次调用即可处理主要可回收体积；修正上下文低估；让已排队的请求在下一次 agent 开始时落地，不要求新的用户发言。

不包含遥测、AGCopilot、其他扩展、npm 发布或新的上下文管理功能。保留 drop-in、零第三方运行时依赖、原文可恢复、最近结果/回执保护、与其他 rewriter 互斥的约束。

## 现场与根因

Pi 会话 `2026-11-06T03-06-31-890Z_01a1aed2-7a51-7287-af71-b92c2d0aaf7d.jsonl` 的第 181–191 行只有一条 urgent 提醒，却引出 5 次 `ctx_reduce`，最后一批候选仅 915–2029 chars。不是提醒状态机重复触发，而是候选定义和模型操作共同造成：

- `measureTail` 把任意大小的工具结果都计入 U，尽管自动裁剪已有 `PRUNE_MIN_CHARS=4000`；增量 `tool_result` 也采用同一错误口径。
- 提醒按时间给最早 5 个，查询按体积给最大 15 个，模型无法从提醒一次取得主要候选。
- `textLength` 只算 text，漏掉工具参数与 thinking，导致 T 被低估、提醒等级失真。
- `allowNew` 只认末尾 user；清理请求虽号称下一轮生效，连续 agent follow-up 或没有新用户输入时会一直排队。缓存保护需要的是「不在 tool loop 中改前缀」，不是「必须等用户说话」。

## 方案

- U 与手动候选统一采用 `PRUNE_MIN_CHARS`；小结果仍计入 T，但不诱导 reduce。显式 ID 请求维持不受大小、年龄限制的既有能力。
- 提醒和查询共用「按体积降序、最多 15 个」的候选口径；提醒文案要求一次提交已使用候选，不再暗示逐个小结果都要清理。
- T 统计 assistant 的 text、thinking 与序列化 toolCall arguments；粗略 token 估算继续保留，不引入真实 tokenizer。
- 在 `agent_settled` 标记安全边界，下一次 `context` 允许落地队列；用户新 turn 的原路径继续有效。tool loop 内仍只排队，已裁剪占位符逐轮原样重放。
- 工具回执只表达「已排队」，不预先宣称实际释放数量或体积。

## 质量承诺

- **性能效率 / 资源利用**：同一会话形态下，小结果不进入候选，提醒直接包含最大候选，避免无收益的多次 reduce；通过测量与工具接口测试验证。
- **可靠性 / 可恢复性**：tool loop 中不改消息，settled 后下一轮能落地仍存在的请求；最近回执、显式恢复与占位符稳定性不回归；通过生命周期测试验证。
- **可维护性 / 可测试性**：候选过滤和排序只有一处规则，测试通过 `measureTail`、`ctx_reduce` 与事件钩子观察行为，不新增平行实现。

## 验证

运行 `pi-context-guard` 的 Vitest、TypeScript 检查及全仓回归；至少覆盖：小结果不候选、大结果按体积取 15、toolCall/thinking 计量、无新用户输入时 settled 后落地、tool loop 中仍不改前缀。

关闭时将仍然成立的「清理请求在 agent 边界落地、候选与自动裁剪共用大小门槛」回写到 `byissue/spec/index.md`；会话操作失误与提醒设计的关系留在本 issue，不另写 note。

## 执行记录

已修改 `pi-context-guard.ts`、对应测试与 README。候选统一为至少 4000 chars、按体积降序最多 15 个；显式 ID 仍可处理小结果。T 纳入 thinking 和 toolCall arguments。`agent_settled` 标记下一个 agent 边界，context 在该边界应用请求后立即消费标记，不影响 tool loop 内的缓存保护。

## 验证结果

- 修改前基线：41 个 context-guard 测试通过，TypeScript 检查通过。
- 修改后：44 个 context-guard 测试通过，TypeScript 检查通过；新增测试覆盖小结果不推荐、显式小结果仍可裁剪、最大 15 个候选、thinking/arguments 计量、无新用户消息时下一轮落地。
- 全仓：363 个测试通过，六个 workspace 的 TypeScript 检查通过，`node scripts/check-installer.mjs` 报 6/6。
- 本机 Pi 1.5.0、默认便宜模型、隔离配置与会话目录，通过 `-e` 直接加载修改版，不覆盖全局扩展：
  - 真实长会话读取大文件，出现 1 条提醒，模型未查询列表，一次 `ctx_reduce` 提交 6 个大结果。
  - 真实 RPC 会话 `2026-11-06T04-30-37-856Z_01a1af1f-791f-7215-8737-2fd44ecb3a3b.jsonl`：1 条提醒、1 次 reduce、6 个 ID，事件顺序为 `agent_end → agent_settled`，期间没有新用户消息；工具循环与 agent 边界均按预期工作。
- 用户已授权关闭、提交、推送并替换本机扩展；安装覆盖是交付步骤，不作为继续阻塞关闭的外部验证。

## 关闭结论

目标与三项质量承诺均有自动化和真实 Pi 证据，范围未扩展到其他扩展或其他项目。长期边界已毕业到 `byissue/spec/index.md` 的「不可破的约束」；无新增 note、decision 或 tool。关闭前固定串搜索旧文件全名，引用为 0 处。剩余动作是按用户授权提交、推送、安装，并在安装后做一次加载检查。
