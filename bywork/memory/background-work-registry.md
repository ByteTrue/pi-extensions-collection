# 扩展间后台工作注册表

## 结论

需要知道「这个会话还有没有后台任务在跑」时，读 `globalThis[Symbol.for("pi-extensions.background-work")]`；提供这类状态时，向同一个 Map 注册按扩展 id 命名的 provider，键相同替换而不是追加。

```ts
const key = Symbol.for("pi-extensions.background-work");
type Item = { kind: "shell" | "subagent"; id: string; label: string };
type Provider = { id: string; running(sessionId: string): Item[] };

const providers = ((globalThis as any)[key] ??= new Map<string, Provider>());
providers.set("my-extension", { id: "my-extension", running: (sessionId) => [] });
```

- 消费方遍历 `providers.values()` 并逐个 try/catch；没有 provider、provider 抛错都等同于「没有后台工作」。注册表可选，单独安装任何一个扩展都不报错。
- `running()` 必须是廉价、无副作用的纯查询，只返回仍在 running 且属于该 session 的任务。把已结束任务留在返回值里，`goal` 会一直 hold，subagent 通知会列出假工作。
- `/reload` 重新求值扩展模块，必须用固定 id 注册（不是每次 add），否则旧闭包留在 Map 里。
- 进程内状态：`pi -p` 子进程看不到父进程注册表，父进程也看不到子进程的后台任务。
- 选进程内 symbol 而不是共享模块或文件：扩展由 jiti 各自加载，互相 import 造出安装顺序与路径耦合；symbol 无依赖、加载顺序无关。

完成通知与历史淘汰的配套约束（2026-11-12 审计落定）：

- `onExit` 只表示完成进入通知队列，不表示已发给 Pi。`sendMessage` 返回后才调 `notificationDelivered`；background-terminal 与 subagent 同一顺序。
- 只淘汰已结束且已通知的记录；运行中和 `notificationPending` 的不进淘汰集合。`notified=true` 只是已排队，不能当已送达证据。
- reload 必须先 flush 再返回，否则旧实例队列随模块求值丢失。pending 队列放 process-global，onExit 在 session 过滤前按 parentSessionId+taskId upsert；flush 只取当前 session，逐片 send 成功后才删除并确认，失败保留。
- 首次从旧版本升级要做一次性 legacy 扫描，at-least-once reconciliation（旧数据没有 delivered 标记，exactly-once 需要 HOST handoff API）；不能为 replay 替换 live manager。
- 摘要超限按 50,000 字分片，每片保留实际任务 ID/state/log path 与最小 clone-safe details，不能只写「N more」后整批确认。

## 依据

- 类型：用户决定（2026-11-12 原话：「反正都是我们自己的扩展集合，这个耦合对体验的提升我觉得可以做」）+ 已实现的契约。
- 实现在 `background-terminal/background-terminal.ts`、`subagent/src/index.ts`、`goal/goal.ts`；验证见 `background-terminal/index.test.ts`、`subagent/src/notification.test.ts` 与各 workspace `npm test`。
- 原文：`archive/byissue/notes/2026-11-12-background-work-registry.md`、`archive/byissue/decisions/2026-11-12-cross-extension-background-work-registry.md`。

## 重访条件

新增跨轮次任务的扩展沿用同一契约；Pi 提供跨进程 job 设施时重谈进程内 symbol 的形态。