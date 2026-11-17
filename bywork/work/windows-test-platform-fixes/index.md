---
kind: work
status: complete
current_unit: "Windows 上 13 个失败用例已全部处理，全仓库测试与类型检查通过"
next_action: "无"
must_hold: "保留 POSIX 原有断言与产品行为；不把平台差异改成产品假装 POSIX；commit/push 必须单独授权"
proof_gap: ""
---

# Windows 测试平台适配

## 目标与边界

用户最初的要求是修掉 pi-extensions-collection 在 Windows 上跑 `npm test` 的失败。原话（2026-11-18）：

> 帮我全部修复吧,就用最好的方式,最优雅地给它修掉,好吧

随后用户要求补记流程：

> 忘记让你用bw流程做了,能补一下吗

范围是 `background-terminal` 与 `subagent` 两个 workspace 的失败用例，以及导致失败的 Windows 产品缺口。不改扩展的模型可见契约，不改 POSIX 下的预期行为，不提交、不推送。

对话里最初把失败数汇总成 8 个，按测试用例逐条枚举实际是 13 个，`evidence/before-failures.md` 保存了完整清单。这个差异本身也是本次 work 要纠正的记录。

这次是事后补记。实现和测试先发生，work 在用户要求补流程之后才建立，无法还原「每轮只完成一行」的实时检查点；下面的证据来自当时的失败清单和事后复跑。

## 已定方案与约束

Windows 与 POSIX 的差异分成两类，处理方式不同。

测试 fixture 依赖 POSIX 能力的，在 Windows 跳过，原文件和原断言保留。符号链接需要管理员权限或开发者模式，chmod 在 Windows 不生效，`/bin/sh` 与 `ps` 不存在。跳过只发生在 win32，POSIX CI 仍执行原用例。用户明确要求修复这些失败，因此允许改动测试文件；改动只加平台条件、替换 fixture 和等待方式，没有放宽断言。bw 默认把既有测试当只读证据，这次按「用户明确要求修改」的例外处理，理由和单独验证都记在这里。

产品代码里的真实缺口单独修。`subagent` 的崩溃回收原来无条件用 `ps` 取进程创建时间和命令行，Windows 上创建时间拿不到，命令行也查不到，孤儿进程收不掉。现在 Windows 记录空的创建时间，回收时改用 PowerShell 的 CIM 查询命令行里的 `--session` 标记。PowerShell 单次约 0.7 秒，所以只放在崩溃回收路径，不放进每次启动子代理的热路径。代价是 Windows 失去「PID 被复用且 session 完全相同」的第二道防线，已写进风险。

600 个任务的汇总测试不再等固定 100ms，改成等 `manager.pendingNotifications(sessionId)` 满 600 再触发 settle。原断言没有改，改的是同步点。

考虑过但没采用的办法：

- 在产品里伪造 `/bin/sh` 或 `ps`，让旧测试原样通过。这样测试绿了，但产品在 Windows 上仍然不会查进程，等于把缺口藏起来。
- 所有进程查询都走 PowerShell。每次启动子代理多约 0.7 秒，代价不可接受。
- 用 WSL 或 Docker 跑测试。能证明 Linux 行为，但解决不了本机 Windows 的失败，也不是用户要求的入口。

## 行为证明

真实入口是本机仓库的 `npm test`、单个 workspace 的 `npx vitest`，以及 `npm run typecheck`。详细输出在 `evidence/`。

| 行为路径 | 真实入口 | 操作 | 应观察到 | 证据 | 结果 |
|---|---|---|---|---|---|
| P1 Windows 上跑全仓库测试不再失败 | 仓库根目录 `npm test` | 直接运行 | 退出码 0，7 个 workspace 全部通过，没有 failed | `evidence/npm-test.txt`，退出码 0；background-terminal 68 passed / 7 skipped，subagent 122 passed / 5 skipped | 通过 |
| P2 background-terminal 的 600 任务汇总不丢通知 | `background-terminal` 下 `npx vitest run index.test.ts` | 运行 chunks an oversized summary 用例 | 600 条通知全部进入队列，断言收到 600 个任务 ID | `evidence/background-verbose.txt`，该用例通过 | 通过 |
| P3 Windows 上 subagent 崩溃回收能杀掉带 session 标记的孤儿进程 | `subagent` 下 `npx vitest run src/reap.test.ts` | 运行 kills a child whose owner is gone 用例 | 子进程从 alive 变为 dead，journal 与 start 文件被删除 | `evidence/subagent-reap-verbose.txt`，该用例 1257ms 通过 | 通过 |
| P4 Windows 上带引号的命令行仍能匹配 session | 同上 | 回收路径解析 PowerShell 返回的 CommandLine | 命令尾部的 `--session <id>"` 能匹配，子进程被杀 | 同一用例通过；正则改为 token 边界 `(?![A-Za-z0-9_-])` | 通过 |
| P5 Windows 上子代理轮次上限测试不再因目录占用失败 | `subagent` 下 `npx vitest run src/run-lifecycle.test.ts` | 运行 lets the current turn's tools finish 用例 | 临时目录清理成功，没有 EPERM | `evidence/subagent-run-lifecycle-verbose.txt`，该用例通过 | 通过 |
| P6 全仓库 TypeScript 类型检查通过 | 仓库根目录 `npm run typecheck` | 直接运行 | 所有 workspace 退出码 0 | `evidence/typecheck.txt`，退出码 0 | 通过 |

## 证据与决定

修复前的 13 个失败用例和错误文本在 `evidence/before-failures.md`。修复后的原始输出在 `evidence/npm-test.txt`、`evidence/typecheck.txt`、`evidence/background-verbose.txt`、`evidence/subagent-reap-verbose.txt`。改动范围在 `evidence/git-diff-stat.txt`。

关键决定：

- `subagentProcessStart()` 在 win32 返回空字符串，POSIX 保持 `ps -p <pid> -o lstart=`。
- 新增 `subagentProcessCommandLine()`，win32 用 `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = <pid>').CommandLine"`，POSIX 用 `ps -p <pid> -o command=`。
- `subagentCommandMatches()` 的正则从「后面必须是空白或结尾」改成「后面不能是标识符字符」，因为 Windows 会把 `-e` 脚本整体加引号。新正则对 POSIX 是放宽，不会拒绝以前能匹配的命令行。
- 测试侧统一用 `process.execPath -e "setInterval(...)"` 启动长寿子进程，用 `taskkill /T /F` 或进程组 SIGKILL 清理，避免依赖 `/bin/sh`。

完整的失败项与覆盖状态见 `scope.md`。

## 完成核对

- 行为门：6 行证明都从本机真实入口跑过，输出保存在 `evidence/`，没有剩余缺口。
- 范围门：`scope.md` 列出 13 个失败用例，全部映射到通过用例或平台跳过；跳过项保留 POSIX 原断言。
- 契约门：测试改动保留原断言；跳过只加在 win32；产品改动只在 Windows 分支，POSIX 代码路径未改；正则放宽对 POSIX 是兼容方向。POSIX CI 本次没有复跑，属于推断而非实测。
- 完成门：`npm test` 与 `npm run typecheck` 都退出 0，`proof_gap` 为空，`check_work.py` 已通过。

## 需要你看的

- POSIX CI 没有在本次会话里复跑。跳过条件只认 win32，正则只放宽，推断 Linux 不会回归，但没有原始输出。
- Windows 上没有进程创建时间，孤儿回收改用命令行 session 标记。PID 被复用且 session 完全相同的极端情况不再有第二道防线。
- 本机跳过的 12 个用例都是 Windows 无法构造的 POSIX fixture：background-terminal 7 个（3 个符号链接、1 个 chmod、3 个原有平台用例），subagent 5 个（1 个创建时间比较、2 个符号链接、2 个原有平台用例）。
