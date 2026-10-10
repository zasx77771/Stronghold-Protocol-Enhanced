# 开发、PR 与发布流程

## 1. 开始任务

1. 判断任务是游戏代码类还是增强功能类。
2. Fetch `origin` 和 `upstream`；无法 fetch 时不得声称基于最新代码，也不得创建 PR。
3. 检查当前分支、跟踪远端、merge-base、ahead/behind、已暂存、未暂存、未跟踪文件，以及 `git worktree list`。
4. 复用符合条件的现有 worktree；否则建立一个只服务当前任务的独立分支或 worktree。
5. 写入、提交、合并、推送和创建 PR 前重新检查状态，避免使用过期快照。

## 2. 游戏代码类

1. `stronghold-protocol` 主工作区保持在最新个人 `master`，只执行与上游主仓库的 Sync Fork。
2. 在 `sganggs/Stronghold-Protocol` 创建 Issue；无需等待回复即可开发。
3. 从最新个人 `master` 建功能分支，并在独立 worktree 中修改和测试。
4. 将功能分支推送到个人仓库，向 `sganggs/Stronghold-Protocol:master` 创建 PR；正文使用 `Closes #<Issue>`。
5. PR 未合并前，不把功能合并到个人 `master` 或 `enhanced-mode`，不升级增强版本，也不生成正式产物。
6. 是否合并由用户逐个确认。上游合并后，个人 `master` 通过 Sync Fork 获得正式上游提交。
7. 上游关闭或拒绝 PR 时，删除本地和个人远端功能分支，不创建备份分支；Issue 与关闭的 PR 保留记录。重新实现时从最新个人 `master` 建新分支并继续引用原 Issue。

## 3. 同步增强分支

1. 从当前 `origin/enhanced-mode` 建立 `sync/upstream-<提交>-enhanced`。
2. 将最新 `upstream/master` 合并到同步分支，不重写 `enhanced-mode` 的公共历史。
3. 冲突时优先保留上游游戏逻辑；上游已有相同或相似功能时删除重复增强实现，仅保留必要且经过测试的最小差异。
4. 验证既有增强功能和两个客户端平台，通过 PR 更新 `enhanced-mode`；是否合并仍需用户确认。
5. 合并或关闭后删除同步分支和干净 worktree。

## 4. 增强适配与增强功能

1. 同步后需要修复或补充增强行为时，从最新 `origin/enhanced-mode` 建独立适配分支，另提 PR。
2. 无需适配时不创建空 PR。
3. 普通增强专属功能同样从最新 `origin/enhanced-mode` 建分支，只向个人 `enhanced-mode` 提 PR。
4. 每个 PR 是否合并都由用户独立确认；合并或关闭后清理本地、个人远端分支和干净 worktree。

## 5. 发布批次

1. 用户逐个确认需要合并的同步、适配和增强 PR；这些 PR 构成本轮发布范围。
2. 未确认、明确不合并或仍在修改的 PR 不纳入本轮，也不阻止发布。
3. 本轮全部确认 PR 合并后自动启动发布，不再询问发布分支、发布 PR、发布 PR 合并、标签或 GitHub Release。
4. 从最新 `origin/enhanced-mode` 建 `release/vM.N.R`，按 `release-policy.json` 更新版本、Android `versionName`、内部 `versionCode`、CHANGELOG 和全部版本元数据。
5. 运行版本校验和完整测试，创建并自动合并发布 PR。
6. 从最终合并提交构建并验证完整 Windows 客户端、完整 Android APK、Windows 增量包；服务端代码、运行时或协议变化时同时构建完整 Windows 服务端。
7. 任一测试、构建、清单、校验或升级验证失败都立即停止，不创建标签或 Release；修复必须通过新分支和 PR。
8. 全部通过后创建 `enhanced-vM.N.R`，在个人仓库创建标题为 `Stronghold Protocol Enhanced M.N.R` 的 GitHub Release 并上传正式产物。
9. Android APK 的公开版本使用 `M.N.R`；整数 `versionCode` 仅用于系统升级顺序，不出现在标签、产物名或 Release 标题中。
10. 发布成功后删除发布分支和干净 worktree。增强标签、Release 和产物不得发布到上游仓库。

## 6. 状态与报告

- 明确区分工作树、已提交、已合并、已打包、已打标签和已发布状态。
- 完整测试失败后，即使隔离复测通过，也必须同时报告完整结果、隔离结果和环境判断，不能称为完整测试通过。
- PR 创建前核对目标仓库、head、base、提交列表、差异和测试结果；发布前再次核对最终提交与产物源码一致。
