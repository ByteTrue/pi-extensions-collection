# byissue 归档（旧 BI 工作流）

旧 BI 工作流的产物封存于此，作为历史记录保留。当前仓库约定见 [`AGENTS.md`](../../AGENTS.md)，规格和任务使用 GitHub Issues；本归档不代表当前实现或工作流程。

## 这里有什么

- `spec/index.md`：封存时的项目当前真相（6 个扩展、git 包分发、不可破约束）。
- `vision/index.md`：空模板，从未填写。
- `decisions/`：7 份拍板，含 superseded 链（复制分发 → clone+pull → git 包）。
- `epics/`：仓库分裂（2026-11-04）、对齐 opencode 设计（2026-11-12，台账 46 项全落定）、审计二十项修复（2026-11-12，20/20 做了，344/344 测试通过）。两个 epic 实现与验证已完成，按当时用户要求未正式关闭。
- `issues/`：8 份已关闭 issue。
- `notes/`：6 份实测笔记（Pi 加载探针、BOLDAPI inline-tools、后台注册表、context-prune A/B、Claude Code 逆向 ×2）。
- `talks/`、`tools/`：空目录。

归档内部文件之间的相对引用保持原样；文内出现的 `byissue/...` 路径一律读作 `archive/byissue/...`。