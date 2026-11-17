# 修复前的失败清单（2026-11-18，Windows）

修复前在本机 `npm test` 得到 13 个失败用例，对话里最初汇总成「8 个」是漏算了 background-terminal 的部分用例。按测试用例逐条枚举如下。

## background-terminal

1. `reap.test.ts > refuses a symlinked journal state file`
   `EPERM: operation not permitted, symlink ...`
2. `reap.test.ts > refuses a symlinked pid state file`
   同上，Windows 无符号链接权限。
3. `reap.test.ts > refuses a symlinked start state file`
   同上。
4. `security.test.ts > tightens an owned loose directory before using it`
   `expected 438 to be 448`，Windows 的 POSIX mode 恒为 0o666。
5. `index.test.ts > chunks an oversized summary without dropping task ids or paths`
   `expected 0 to be greater than 1`，600 个任务状态已结束，但通知队列还没入队就触发了 agent_settled。

## subagent

6. `reap.test.ts > kills a child whose owner is gone and removes its journal`
   `/bin/sh` 在 Windows 不存在，子进程没有启动。
7. `reap.test.ts > does not kill a reused PID when the recorded start differs but the command session matches`
   `spawn /bin/sh ENOENT`。
8. `reap.test.ts > refuses a symlinked journal state file`
   `EPERM: operation not permitted, symlink ...`
9. `reap.test.ts > refuses a symlinked start state file`
   同上。
10. `reap.test.ts > leaves a child alone while its owner is alive`
    `/bin/sh` 不存在，alive 断言失败。
11. `reap.test.ts > does not kill a process when the journal has no session id`
    `/bin/sh` 不存在。
12. `reap.test.ts > ignores a hostile startPath even in an otherwise valid journal`
    `/bin/sh` 不存在，等待子进程退出超时。
13. `run-lifecycle.test.ts > lets the current turn's tools finish before enforcing maxTurns`
    `EPERM, Permission denied: C:\Users\byte\AppData\Local\Temp\subagent-limit-tools-...`

## 根因归类

- Windows 没有 `/bin/sh` 和 `ps`，subagent 的测试 fixture 与产品查询都假设 POSIX。
- Windows 普通用户不能建符号链接，POSIX mode 不可断言。
- 600 路输出流关闭晚于任务状态变更，测试用固定 100ms 等待，存在竞态。
- 子进程退出后 Windows 仍会短暂锁住临时目录，`rmSync` 需要重试。
