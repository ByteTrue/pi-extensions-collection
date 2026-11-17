# 分发与依赖边界

## 结论

- 整个仓库是 Pi 的一个 git 包。官方安装 `pi install git:github.com/ByteTrue/pi-extensions-collection`，更新 `pi update --extensions`。Pi clone 后跑 `npm install --omit=dev`，更新时 reset checkout 并清掉未跟踪文件。checkout 归 Pi 管，不能就地改；维护者在自己的 checkout 里改，用 `pi -e ./<ext>/<ext>.ts` 加载单文件验证。
- 不发 npm。每个扩展目录的 `package.json` 永远 private，不加 `publishConfig` 或任何发布字段。
- 运行时依赖写进扩展自己的 `dependencies`，由 Pi 安装；`devDependencies` 只服务 CI。宿主模块（`@earendil-works/*`、`typebox`）不进 `dependencies`：Pi 把它们映射到自己的副本，物理拷贝会造出重复的类与注册表。
- 无构建：Pi 用 jiti 直接加载 TS 入口。不提交 `node_modules`，不手工 vendor 依赖。
- 工具名必须全局唯一。Pi 在加载期判定冲突并拒绝启动，后加载的扩展整个不加载（连它别的工具一起失去）。扩展自身看不到别人注册了什么，加载期调用 `pi.getAllTools()` 抛「runtime not initialized」。冲突只能靠不加载来预防（`pi config` 的 `-路径` 条目逐项过滤）。
- 整包一条版本轴，发布与钉版本用 git tag（首个 `v1.0.0`，当前 `v2.0.0`）。subagent 于 2026-11-11 从 `ByteTrue/pi-subagent` 收回本仓，旧仓已归档，其 `@v0.18.0` 安装命令失效；代价是 subagent 不再单独升级。
- `vendor` 扩展已退役（2026-11-11 用户拍板换成脚本）。读写 `models.json` 的能力在 CFG 仓库的 `provider-model-config` 技能脚本 `vendor.mjs`，本仓不重建这个扩展。

## 依据

- 类型：用户决定（2026-11-11 原话：「去掉不能引入外部依赖的规则……官方安装改成 pi install git……全部走 pi 官方的安装更新方式」；「既然如此，隔壁我们的 subagent 扩展能收进来吗？」；vendor 换脚本）。
- 被否决的方案及理由：
  - 复制进 `~/.pi/agent/extensions/` / clone+pull（2026-11-04 与 2026-11-11 短暂采用，后者当天被 git 包取代）。最强理由是零安装摩擦、pull 即更新；否决因为该路径没有人跑 `npm install`，依赖缺失要用户手工补，副本还会和包里的那份撞工具名。
  - 安装器脚本 `install.mjs`（curl 拉文件 + 箭头菜单，兼做 magic-context 预检）。逐项选择已由 `pi config` 包级过滤提供，脚本删除。
  - 运行时自我禁用（context-guard 曾在 `session_start` 比对 `getAllTools()`，被顶掉就停 hook）。冲突在加载期就失败，该分支永远不可达，已回滚。
  - npm 分发。曾以「依赖全空、npm 只多版本号」为由停发；git 包引入依赖后，停发 npm 的结论不变。
- 证据：原文见 `archive/byissue/decisions/2026-11-11-git-package-install.md`、`2026-11-11-merge-subagent.md`、`2026-11-11-vendor-to-script.md`、`001-copy-in-distribution-no-npm.md`、`2026-11-11-clone-and-pull-distribution.md`（superseded 链完整）。加载与依赖解析的实测见 `bywork/memory/pi-host-behavior.md`。
- 环境：Pi 1.5.x；`scripts/check-manifest.mjs` 守住根 `pi.extensions` 清单与扩展目录一一对应。

## 重访条件

Pi 改变包安装/更新语义（不再 `npm install`、不再 reset checkout）时重判依赖与就地修改的边界；出现第二个需要独立版本轴的扩展时重谈单版本轴。