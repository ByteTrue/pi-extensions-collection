---
kind: decision
title: "分发形态收敛为「复制即用」，全面停发 npm"
created: 2026-11-04
superseded-by: "2026-11-11-clone-and-pull-distribution.md"
---

# 分发形态收敛为「复制即用」，全面停发 npm

扩展一律以「文件复制进 `~/.pi/agent/extensions/` 即生效」为唯一分发形态：不发 npm、不建 release 流水线、不打 tag，重跑 `install.mjs` 覆盖就是更新。原 `pi-package-mono` 的两个 npm 包因此分道：background terminal 拍平成单文件并入本仓，subagent 独立成 `ByteTrue/pi-subagent` 按 git tag 分发——它需要版本与回滚，而 git 源同样不用 registry。

理由是维护成本与收益不对称：这些扩展的 `dependencies` 全为空，运行时只要 `node:*` 和 Pi 宿主模块，npm 能额外提供的只有版本号与 changelog 提示；对外分发用 git 源就够了。

## 背景（按需）

停发 npm 之后仍要保留的隔离带是**工具名唯一**。Pi 在加载期检查重名并直接拒绝启动，所以冲突必须由安装器预防（当前只有 `pi-context-guard` 与 `@cortexkit/pi-magic-context` 这一对），扩展自身没有可见性。这条约束写进了 `spec/index.md`，改分发形态时不要顺手删掉。
