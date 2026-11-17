---
kind: note
title: "读 Claude Code 内部设计的三层证据与探针配方"
created: 2026-11-12
---

# 读 Claude Code 内部设计的三层证据与探针配方

2026-11-11/12 实测于 Windows，对象是本机 winget 安装的 `claude.exe`（PE32+，338,187,936 字节，bun 编译，无 sourcemap）与 npm 包 `@anthropic-ai/claude-code@2.1.317`。目的：把「学大厂同类能力」从读后感变成有出处的对照。

## 结论

源码读不到，但它的工具契约、提示词和内部取舍基本都能读。性价比最高的是 npm 包里的 `sdk-tools.d.ts`：所有内置工具的输入/输出 JSON Schema，每个字段都带官方文档注释，一份文件就是一套 API 设计说明书。提示词与设置文案在 exe 的字符串池里，能抽，但要在正确的字节区找。

## 三层证据

### npm 包（首选，纯文本）

`npm pack @anthropic-ai/claude-code@2.1.317` 只有 7 个文件、29KB，没有 JS 源码，没有 sourcemap。有价值的是 `sdk-tools.d.ts`（4234 行）。它列出全部工具，含我们没有的 `Monitor`、`CronCreate`、`ScheduleWakeup`、`Workflow`、`ReadNotifications`、`ReportFindings`，以及 `AskUserQuestion` 的 `header` 与 `multiSelect` 约束。

### exe 字符串池（提示词与文案）

本机这份的 JS 字符串集中在 157–162MB 区间，占全文不到 2%。系统提示词片段、工具 description、压缩提示词原文、设置项文案都在这里。偏移随版本变化，升级后必须重找，不要复用旧偏移。

### 公开 docs 与 changelog

行为描述，用来交叉验证前两层。

## 探针配方

```python
import mmap, re
f = open(EXE, 'rb')                      # 必须留住文件对象
m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
i = m.find(b'when_to_save')              # 先用一个特征词定位
for s in re.findall(rb'[\x20-\x7e]{25,}', m[i-3000:i+3000]): print(s.decode())
```

先用特征词 `find` 拿偏移，再在窗口内按「可见字符连续段 ≥25」抽句子。整文件抽字符串会混进几万行噪声。同一区域再抽一遍 `(?:[\x20-\x7e]\x00){25,}`（UTF-16LE），能捞到另一种编码。有些区域抽出来是「每字符间夹空格」的样子，那是二进制里的分片，不影响阅读。

Windows 上 `mmap(open(p,'rb').fileno(), ...)` 会在临时文件对象被回收后报 `Bad file descriptor`，必须把 `open()` 的返回值绑到变量上。也别用 Node 逐块扫 323MB：本机跑 300s 超时没出结果，python mmap 是秒级。

本次有效的锚点只对这份 exe 成立：`You are Claude Code` 158358400、`AskUserQuestion` 158020180、`# Memory` 158325732、`when_to_save` 158234697、`Keep each memory file under` 158255744。

## 边界

逆向用于学习设计没问题，但不要把抽出来的提示词原文贴进任何发布物。抄结构、抄字段、抄取舍，句子自己写。

看不到的是 TS 实现、会话循环细节、召回选择算法和远端同步协议。

判断「存在某个机制」要区分证据类型：字符串里出现 `memory_recall_select` 这类短词，可能只是 telemetry 事件名，它和 `mcp_*`、`migration_*` 并列在一张事件表里，不足以证明存在独立子系统。有整段指令文本才算硬证据。

## 相关

挖到的具体设计差异见 `byissue/notes/2026-11-12-claude-code-design-deltas.md`。证据留在 `C:/tmp/cc-probe/`（`package/sdk-tools.d.ts`、`memory_hits.txt`、`types_region.txt`、`strings_region.txt`），该目录在仓库外，临时目录被清理后需要重新抽取。
