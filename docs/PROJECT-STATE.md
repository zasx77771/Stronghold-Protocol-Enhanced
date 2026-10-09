# 当前项目状态

> 本文件是易变状态快照，不是长期规则。执行任务前以实际 Git、远端、版本文件和发布页面为准。

更新时间：2026-10-09

## 版本基线

- 上游代码基线：`0.2.2`
- 当前增强代码版本：`2.2.1`
- Android `versionName`：`2.2.1`
- Android 内部 `versionCode`：`21`
- `release-policy.json` 已使用通用 `0.M.N -> M.N.R` 映射。

以上只描述代码与元数据，不等同于已经打包、打标签或发布。必须分别核验 Git 标签、产物和 GitHub Release。

## 工作区状态约束

- `stronghold-protocol` 主工作区应保持在个人 `master`，只用于 Sync Fork。
- 游戏代码开发使用从最新个人 `master` 建立的独立分支或 worktree。
- `stronghold-protocol-enhanced` 的长期增强分支是 `enhanced-mode`；上游同步和增强适配分别使用独立分支与 PR。
- 新产物写入 `enhanced-client-servers`；旧 `成果文件` 仅作历史归档。
- 旧 Android 增量脚本和增量包只作历史保留，不属于当前发布流程。

## 已知迁移事项

- 旧文档中的 `BaseCode`、`upstream/main`、`git switch main` 和 ZIP 源码导入流程均已废止。
- 旧增强标签保留原名；从下一次增强发布起使用 `enhanced-vM.N.R`。
- 文档中出现的分支、标签或发布状态只有经 Git 和发布页面核验后才能作为恢复锚点。
