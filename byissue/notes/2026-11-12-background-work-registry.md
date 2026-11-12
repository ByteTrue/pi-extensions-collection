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
