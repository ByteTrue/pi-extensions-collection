# 失败用例覆盖快照

来源是修复前本机 `npm test` 的失败清单，逐条保存在 `evidence/before-failures.md`。共 13 个用例，按测试文件枚举。

| 来源项 | 所属行为单元 | 覆盖状态 | 覆盖依据 |
|---|---|---|---|
| background-terminal/reap.test.ts：symlink journal 用例 | P1 全量测试 | 已覆盖 | Windows 跳过，POSIX 原断言保留；`background-terminal/reap.test.ts` |
| background-terminal/reap.test.ts：symlink pid 用例 | P1 全量测试 | 已覆盖 | 同上 |
| background-terminal/reap.test.ts：symlink start 用例 | P1 全量测试 | 已覆盖 | 同上 |
| background-terminal/security.test.ts：chmod 目录用例 | P1 全量测试 | 已覆盖 | Windows 跳过，POSIX 原断言保留；`background-terminal/security.test.ts` |
| background-terminal/index.test.ts：600 任务汇总用例 | P2 通知不丢 | 已覆盖 | 改为等待 `pendingNotifications`，用例通过；`evidence/background-verbose.txt` |
| subagent/src/reap.test.ts：kills a child 用例 | P3 孤儿回收 / P4 命令行匹配 | 已覆盖 | 跨平台 fixture，Windows 用例通过；`evidence/subagent-reap-verbose.txt` |
| subagent/src/reap.test.ts：stale start 用例 | P3 孤儿回收 | 已覆盖 | Windows 跳过（无创建时间），POSIX 原断言保留 |
| subagent/src/reap.test.ts：symlink journal 用例 | P3 孤儿回收 | 已覆盖 | Windows 跳过，POSIX 原断言保留 |
| subagent/src/reap.test.ts：symlink start 用例 | P3 孤儿回收 | 已覆盖 | 同上 |
| subagent/src/reap.test.ts：leaves a live child 用例 | P3 孤儿回收 | 已覆盖 | 跨平台 fixture，Windows 用例通过 |
| subagent/src/reap.test.ts：missing session id 用例 | P3 孤儿回收 / P4 命令行匹配 | 已覆盖 | 跨平台 fixture，Windows 用例通过 |
| subagent/src/reap.test.ts：hostile startPath 用例 | P3 孤儿回收 | 已覆盖 | 跨平台 fixture，Windows 用例通过 |
| subagent/src/run-lifecycle.test.ts：maxTurns 工具收尾用例 | P5 目录清理 | 已覆盖 | 清理加重试，用例通过；`evidence/npm-test.txt` |

覆盖状态说明：

- 「已覆盖」表示该失败用例在本次改动后要么在 Windows 通过，要么在 Windows 因平台能力跳过、其原断言仍在 POSIX 执行。
- 没有「明确不做」项。跳过是平台能力边界，不是放弃行为；对应断言没有删除或放宽。
