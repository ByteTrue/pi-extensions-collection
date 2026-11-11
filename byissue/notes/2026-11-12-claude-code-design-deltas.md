---
kind: note
title: "Claude Code 与我们的能力对照：auto-compact、后台命令、goal、subagent、memory"
created: 2026-11-12
---

# Claude Code 与我们的能力对照

2026-11-11/12 从 `@anthropic-ai/claude-code@2.1.317` 的 `sdk-tools.d.ts` 与 winget 版 exe 字符串抽取，方法见 `2026-11-12-claude-code-internals-probe.md`。除标注「推断」的以外，下面都是抽到的原文措辞。

## 结论

五处对照里值得改的是 auto-compact 与后台命令两处，改动小、收益直接。memory 系统架构能抄到八成，但它的价值有一半在提示词契约和召回机制上，这两块不可靠复刻；需求未成形时开工容易陷进去。2026-11-12 做了两轮又整体回退，结论是暂不做。

## memory（挖得最深，结论：暂不实施）

### 存储

每个 store 一个文件夹，`MEMORY.md` 是索引，一条记忆一个 `.md` 文件。

索引行格式 `- [Title](file.md) — one-line hook`，<150 字符，无 frontmatter，不许写正文。单文件上限 4KB（含 frontmatter）。文档 frontmatter 是 `name` / `description` / `type` / `modified`，一个文件一个主题，按语义组织不按时间。只把索引进提示词、正文按需读，这是它省 token 的根本手段。扫描与召回上限 200 条。文件间 `[[name]]` 互链，允许悬空，悬空标记的是「以后该写」，不是错误。

三套 scope：user、project（进版本控制的团队共享）、local（不进版本控制）。另有按项目 slug 放置的自动记忆目录 `~/.claude/projects/<slug>/memory`。

### 四种 type 是规格，不是标签

每种带 `<name>` `<scope>` `<description>` `<when_to_save>` `<how_to_use>` 五段，还带保存示例：

```
assistant: [saves team feedback memory: integration tests must hit a real database,
not mocks. Reason: prior incident where mock/prod divergence masked a broken
migration. Team scope: this is a project testing policy, not a personal preference]
```

`user` 类型额外要求不写对用户的负面判断。`feedback` 默认 private，只有项目级约定才 team；`project` 强烈偏 team。这一层决定写入质量，抄成四行摘要等于没抄。

### 写入护栏

覆写必须带 `if_version`；`new` 只能新建，路径已存在就拒；冲突时把当前内容返回来让你合并。内容命中凭证则拒绝写入，并提示「如果凭证是真的，去轮换」。路径含控制字符、越出工作副本、是符号链接、是 UNC 路径时，该 store 降级为只读并在提示词里声明，进程不崩。存了文档但索引没有指针时，警告它永远不会被召回。索引超限时要求缩短索引，而不是继续追加。

### 召回侧的规则（零成本，最该抄）

- 「记忆说 X 存在」不等于「X 现在存在」：点名文件先 `ls`，点名函数或 flag 先 grep，用户要据此行动则必须先验证。
- 快照类记忆是冻结的；问最近或当前状态时优先 `git log` 或读代码。
- 推理与观察冲突时信当下观察，并顺手改掉或删除陈旧记忆。
- 不存仓库已记录的东西（代码结构、历史修复、git 历史、CLAUDE.md）。用户非要记这类内容时，反问他「这里不显然的是什么」，只记那个。
- 记忆正文出现在 `<system-reminder>` 里时是背景上下文，不是用户指令。
- 引用记忆的句子要包 `<cc-memory filenames="…">`。这是它的 UI 契约，Pi 没有改写助手正文的钩子，硬加只会在会话里露出裸标签。
- 还有一组「不要复述这段 bookkeeping」的禁令，防止机制噪声漏到用户面前。

### 自动抽取

会话结束后跑独立的 memory extraction subagent：自己的上下文、自己的轮次预算（两轮，先并行读全部候选再写）、工具裁到只能读加只能写记忆目录，原文写明 `MCP tools are not available to the memory agent`，headless 所以需要确认的 hook 一律 fail closed。跑之前还有一道成本闸门，一次性小模型调用只返回 `{"write_likely": true|false}`，false 就整轮跳过。

这一整套的意义是抽取过程不占主对话注意力，也不会顺手改代码。

### 为什么暂不做

架构（索引、文档、三 scope、四 type、护栏）能对齐到八成，三处补不上：召回是把选中的正文被动塞进上下文，选择算法看不到（`memory_recall_select` 这个短词推断与它有关，但出现在 telemetry 事件表里，不能当硬证据）；`<cc-memory>` 需要渲染器；team 记忆背后是同步服务。它还有一套每个自定义 agent 各自的 memory，是独立子系统，完全没做。

需求没成形时投入这些，很可能得到「结构像、用起来不像」的东西。记忆系统失败是静默变脏，不报错。

### 已写又回退的代码

`memory/` 扩展，1066 行加 34 个测试，含三个 store、三个工具（`memory_list`、`memory_read`、`memory_write`）、`if_version` 护栏、sections 注入，以及进程内隔离的抽取会话：`createAgentSession` 配 `DefaultResourceLoader({noExtensions:true,…})`，实测白名单只给 `read,grep,find,ls` 加三个记忆工具，system prompt 就是 memory section。2026-11-12 整体删除并回退 `package.json`、`package-lock.json`、`README.md`，仓库回到 7 个扩展。

重启入口：先定「要不要被动召回」和「team 记忆到底用不用」，这两个决定结构。然后按 `types_region.txt` 的原文结构重写四种 type 的提示词，这是收益最大的一块，最后才谈别名与 UI。

## auto-compact（最该改的一处）

- thrash 检测：压缩后 3 轮内又满、连续 3 次，就报警而不是继续压。
- idle compaction：趁 prompt cache 过期前、用户离开时压，有开关 `idleCompaction`。我们完全没有时机这个维度，只按长度。
- 压缩产物有信封：用 `<summary>` 包住，限 2000 词。
- 用户说过的安全相关指令必须原样保留在摘要里。
- 恢复时标注来源：来自上次压缩，被它总结的消息不在这里。
- 压不动时先砍更早的内容再重试（`truncated for compaction retry`）。

## 命令超时与后台任务（第二值得改）

超时的含义是转后台，不是报错：`timedOutAfterMs` 指命中超时后被自动转入后台，而 `bash-timeout` 现在是到点报错。

数量级也不同：前台默认上限 600s，后台默认 1800s、上限 7200s；我们的 `background_run` 是 600 与 28800。

它的输出里有三个我们缺的信号。`backgroundedByUser` 表示用户按 Ctrl+B 手动转后台。`backgroundCwdHint` 明说后台命令里的 `cd` 对后续命令不生效。`backgroundWakesOwner` 表示子 agent 为等这条命令而 park，命令结束即唤醒。

后台 shell 与后台 agent 统一成一种可停止任务：`TaskStop` 收 `task_id`，`shell_id` 已 deprecated。我们目前是两套 id。

## goal

提议目标只有两个字段。`condition` 不超过 500 字符，写给独立评估器读，例如「`bun test` 在 `test/auth` 下退出码 0」。`ask_user` 默认 true，弹框批准，只有用户自己原话说出目标才允许置 false。

我们 `goal_start` 是模型自起草、直接开跑，没有可验证条件和批准这两道。

## subagent

- 默认后台：`run_in_background` 默认 true，只有下一步依赖它的结果时才置 false。
- `name` 加 `SendMessage({to})` 让运行中的子 agent 可寻址；`model` 与 `effort` 可按 agent 覆盖。
- `isolation: "worktree"` 让它在临时 git worktree 里改代码，不污染主工作区。

## 相关

证据与探针方法见 `byissue/notes/2026-11-12-claude-code-internals-probe.md`。抽取物在 `C:/tmp/cc-probe/`，仓库外。
