# byissue 归档（旧 BI 工作流）

2026-11-17 起本仓工作流换成 ByWork（`bywork/`），旧 BI 工作流的全部产物封存于此，只读，不再更新。新工作从 `bywork/memory/` 的长期判断继续，不回写这里。

## 这里有什么

- `spec/index.md`：封存时的项目当前真相（6 个扩展、git 包分发、不可破约束）。
- `vision/index.md`：空模板，从未填写。
- `decisions/`：7 份拍板，含 superseded 链（复制分发 → clone+pull → git 包）。
- `epics/`：仓库分裂（2026-11-04）、对齐 opencode 设计（2026-11-12，台账 46 项全落定）、审计二十项修复（2026-11-12，20/20 做了，344/344 测试通过）。两个 epic 实现与验证已完成，按当时用户要求未正式关闭。
- `issues/`：8 份已关闭 issue。
- `notes/`：6 份实测笔记（Pi 加载探针、BOLDAPI inline-tools、后台注册表、context-prune A/B、Claude Code 逆向 ×2）。
- `talks/`、`tools/`：空目录。

## 已移植到 bywork/memory/

| 归档原文 | 新位置 |
| --- | --- |
| `spec/index.md` + `decisions/`（分发、依赖、subagent 收编、vendor 退役） | `bywork/memory/distribution-and-deps.md` |
| `spec/index.md` 对齐条目 + `epics/2026-11-12-x-对齐-opencode-设计/` 的拍板 | `bywork/memory/opencode-alignment.md` |
| `notes/2026-11-11-pi-extension-loading-probes.md` | `bywork/memory/pi-host-behavior.md` |
| `notes/2026-11-09-boldapi-inline-tools-tool-removal.md` | `bywork/memory/boldapi-inline-tools.md` |
| `notes/2026-11-12-background-work-registry.md` + 对应 decision | `bywork/memory/background-work-registry.md` |
| `decisions/2026-11-13-remove-context-prune.md` + `notes/2026-11-13-context-prune-ab.md` | `bywork/memory/context-prune-removal.md` |
| `notes/2026-11-12-claude-code-design-deltas.md` 的 memory 结论 | `bywork/memory/claude-code-memory.md` |

移植是提炼长期判断，不是全文复制；证据细节、逐项台账与用户原话仍以本归档为准。审计 epic 的信任/journal/容量约束已由代码与测试承载（`reap.test.ts`、`notification.test.ts` 等），不另立 memory。

归档内部文件之间的相对引用保持原样；文内出现的 `byissue/...` 路径一律读作 `archive/byissue/...`。