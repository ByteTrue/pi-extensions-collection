---
kind: decision
title: "分发改为 clone 即加载，逐项开关交给 pi config"
created: 2026-11-11
superseded-by: "2026-11-11-git-package-install.md"
---

# 分发改为 clone 即加载，逐项开关交给 pi config

用户原话（2026-11-11，本次对话）：「我在想我们的分发方式能不能做到比如直接把我们仓库 clone 到一个目录，就可以用了，然后更新就只需要 pull，我是受了 oh my tmux 的分发方式的启发」。下一轮选定方案时用户说「1 和 2 都按推荐来」，即 clone 进 `~/.pi/agent/extensions/`、删掉 `install.mjs`。适用范围：长期分发形态。

仓库根 `package.json` 增加 `pi.extensions` 清单后，把仓库 clone 到 `~/.pi/agent/extensions/<名>/` 就完成安装，`git pull` 就是更新。逐项开关改用 `pi config` 写入的 `-路径` 条目，安装器脚本退役，避免两套安装模型并存。

依据是 Pi 原生把「带 `pi` 清单的目录」当作一个包来发现（2026-11-11 用临时 agent 目录实测：清单目录加载 7 个扩展，0 错误），以及 `-路径` 条目确实能让指定扩展不加载（同一环境实测：注册 `ctx_reduce` 的探针与 prune 同时存在时报冲突，加上禁用条目后冲突消失）。这条取代 `001-copy-in-distribution-no-npm.md`：不发 npm 的结论不变，变的是落到用户机器上的方式。
