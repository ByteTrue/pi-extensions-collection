# 扩展间后台工作注册表

**结论：** 需要知道「这个会话还有没有后台任务在跑」时，读 `globalThis[Symbol.for("pi-extensions.background-work")]`；需要提供这类状态时，向同一个 Map 注册一个按扩展 id 命名的 provider，键相同会替换而不是追加。

**何时用：** 新增会跨轮次运行任务的扩展，或让某个循环/通知根据后台任务状态改变行为。

**细节：**

```ts
const key = Symbol.for("pi-extensions.background-work");
type Item = { kind: "shell" | "subagent"; id: string; label: string };
type Provider = { id: string; running(sessionId: string): Item[] };

const providers = ((globalThis as any)[key] ??= new Map<string, Provider>());
providers.set("my-extension", {
  id: "my-extension",
  running: (sessionId) => /* only running work for this session */ [],
});
```

消费方遍历 `providers.values()` 并 `try/catch` 每个 provider；没有 provider、provider 抛错都等同于「没有后台工作」。`running()` 必须是廉价、无副作用的纯查询，只返回仍处于 running 且属于该 session 的任务。

**坑：**

- Pi 的 `/reload` 会重新求值扩展模块。用固定 id 注册（不是每次 `add`），否则旧闭包会一直留在 Map 里。
- 不要把已经结束的任务留在返回值里：`goal` 会因此一直 hold，subagent 通知会列出假的工作。
- 这是进程内状态；子进程（`pi -p` 子会话）看不到父进程的注册表，父进程也看不到子进程的后台任务。

**依据：** 用户 2026-11-12 同意扩展间为体验做耦合；实现在 `background-terminal/background-terminal.ts`、`subagent/src/index.ts`、`goal/goal.ts`，测试见各 workspace 的 `npm test`。

**相关：** `byissue/decisions/2026-11-12-cross-extension-background-work-registry.md`、`byissue/epics/2026-11-12-x-对齐-opencode-设计/`。

## 完成通知与历史淘汰（2026-11-12）

`onExit` 只表示完成进入通知队列，不表示通知已经发给 Pi。background-terminal 在 `flushPendingExits` 的 `sendMessage` 返回后才调用 `notificationDelivered`；subagent 走同一顺序。两个 manager 都只淘汰已结束且已通知的记录，运行中和 `notificationPending` 的记录不进入淘汰集合。

reload 必须先 flush 再返回，否则旧扩展实例的队列会随模块求值丢失。pending 队列放在 process-global，onExit 在 session 过滤前按 parentSessionId+taskId upsert；flush 只取当前 session，逐片 send 成功后才删除并确认，失败保留未发送任务。真实 shutdown 只清当前 session。

首次从 HEAD 升级还有 init 前旧私有队列：background 旧 shutdown 甚至不 flush。新 runtime 安装 callback 后必须一次性扫描 legacy terminal records 做 at-least-once reconciliation；旧数据没有 delivered 标记，exactly-once 需要 HOST handoff API。之后运行中的旧任务由新 callback 接管。不能为 replay 替换 live manager。

完成历史限制不能复用 `notified=true` 作为已送达证据；它只是已排队。摘要超限时按 50,000 字分片，每片保留实际任务 ID/state/log path 和最小 clone-safe details，不能只写“N more”后整批确认。验证见 `background-terminal/index.test.ts` 与 `subagent/src/notification.test.ts`。
