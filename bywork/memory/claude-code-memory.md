# Claude Code memory 系统：暂不实施

## 结论

对照 Claude Code 后值得改的是 auto-compact 与后台命令两处（改动小、收益直接）。memory 系统架构能抄到八成，但价值有一半在提示词契约和召回机制上，这两块不可靠复刻；需求未成形时开工容易陷进去。2026-11-12 做了两轮又整体回退，结论是暂不做。不要在没有成形需求时重启这个方向。

已抽取的关键设计（供将来重访时省一次逆向）：

- 存储：每 store 一个文件夹，`MEMORY.md` 是索引，一条记忆一个 `.md`。索引行 `- [Title](file.md) — one-line hook`，<150 字符；单文件上限 4KB；只把索引进提示词、正文按需读，这是省 token 的根本手段。扫描与召回上限 200 条。`[[name]]` 互链允许悬空，悬空表示「以后该写」。
- 三套 scope：user、project（进版本控制）、local（不进）；另有 `~/.claude/projects/<slug>/memory` 自动目录。
- 四种 type 是规格不是标签：每种带 `<name>` `<scope>` `<description>` `<when_to_save>` `<how_to_use>` 五段和保存示例；抄成四行摘要等于没抄。
- 写入护栏：覆写带 `if_version`；`new` 遇已存在路径拒绝；命中凭证拒写并提示轮换；路径含控制字符/越出工作副本/符号链接/UNC 时该 store 降级只读，进程不崩。

## 依据

- 类型：外部观察 + 用户决定（暂不做，两轮实施后整体回退）。
- 抽取自 `@anthropic-ai/claude-code@2.1.317` 的 `sdk-tools.d.ts` 与 winget 版 exe 字符串（2026-11-11/12）。完整对照与探针方法：`archive/byissue/notes/2026-11-12-claude-code-design-deltas.md`、`2026-11-12-claude-code-internals-probe.md`。抽取物原在 `C:/tmp/cc-probe/`（Windows 机器，仓库外），需要时按探针 note 重新抽取。

## 重访条件

用户提出成形的跨会话记忆需求，或 Claude Code 公开 memory 的提示词契约与召回实现时，再评估。