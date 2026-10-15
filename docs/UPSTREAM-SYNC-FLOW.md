# 上游新版本同步到增强版流程

本文件细化 `upstream/master` 推送新版本后合并到 `enhanced-mode` 的操作，不改变用户确认、版本发布和分支保护规则。

## 1. 基线和分支

- 上游来源固定为 `upstream/master`；`stronghold-protocol/master` 只负责 Sync Fork。
- 同步基线为最新 `origin/enhanced-mode`，临时分支命名为 `sync/upstream-<short-sha>-enhanced`。
- 不得从旧本地分支、历史 ZIP 或 `stronghold-protocol/master` 创建同步分支。

开始前执行：

```powershell
git fetch upstream --tags
git fetch origin --prune
git status --short --branch
git branch -vv
git remote -v
git worktree list
$base = git merge-base origin/enhanced-mode upstream/master
git rev-list --left-right --count origin/enhanced-mode...upstream/master
```

fetch 失败、工作树不干净、无法确认远端或无法确认共同基线时，停止同步，不创建 PR。

## 2. 合并前摘要

只分析共同基线之后的上游提交，避免读取整个仓库：

```powershell
git log --oneline "$base..upstream/master"
git diff --name-status "$base..upstream/master"
git diff --stat "$base..upstream/master"
git merge-tree --write-tree origin/enhanced-mode upstream/master
```

摘要必须标记上游提交范围、变更模块、预计冲突、协议/依赖/版本/构建变化和需要验证的平台。 `merge-tree` 只用于预判，不能代替实际合并和测试。

## 3. 创建同步分支并合并

```powershell
git switch -c sync/upstream-<short-sha>-enhanced origin/enhanced-mode
git merge --no-ff --no-commit upstream/master
git diff --name-only --diff-filter=U
git diff --check
```

使用 `--no-commit`，完成冲突处理和测试后再创建合并提交。不得直接在 `enhanced-mode` 上合并，不得用 rebase 改写同步历史。

## 4. 冲突职责和增强功能保留

| 范围 | 默认处理 | 必须验证 |
|---|---|---|
| 干员、敌人、技能、战斗规则、官方数据 | 上游为准 | 官方规则和回归测试 |
| Windows、Android、TCP、账户、记录、回放、更新器 | 增强版为准 | 平台和旧数据兼容性 |
| `server/index.js`、`server/tcp.js`、`public/js/net.js`、共享协议 | 手工组合 | 协议、连接和错误处理 |
| `package-lock.json` 等生成文件 | 按输入文件重新生成 | 固定 Node/npm 后执行 `npm ci` |
| 构建、版本和发布脚本 | 保留增强版流程 | 目标平台构建 |

合并中的 `ours` 是增强版，`theirs` 是上游。禁止全局使用 `ours` 或 `theirs`；只在完成职责判断后处理单个文件或区块。上游已有相同实现时删除增强版重复代码，只保留必要差异并补回归测试。无法确认官方来源的行为标为推断或 `ASSUMED`。

只读取冲突三方差异：

```powershell
git diff --cc -- <file>
git show :1:<file>   # 共同基线
git show :2:<file>   # enhanced-mode
git show :3:<file>   # upstream/master
```

## 5. 重复冲突和 token 控制

```powershell
git config rerere.enabled true
git config rerere.autoupdate false
git config merge.conflictstyle zdiff3
```

`rerere` 只提供候选解决方案；自动应用后必须检查差异并测试。AI 或人工处理时先输出提交摘要、统计和冲突文件名，再读取 `git diff --cc` 区块，不批量读取整个仓库。固定 Node/npm 版本，避免格式化、依赖升级和无关 lockfile 变化混入同步 PR。

## 6. 分层验证

1. 先执行受影响模块的定向测试和 `git diff --check`。
2. 再执行 `npm test`，并分别记录通过、失败、未运行和环境抖动。
3. 修改共享逻辑、协议、存档、战斗引擎、公共数据、TCP、账户、记录或回放时，必须验证 Windows 与 Android 相关路径以及旧数据/旧录像读取。
4. 正式发布前才执行完整 Windows 客户端、Android APK、Windows 增量包；服务端变化时增加 Windows 服务端完整包。

同步 PR 不自动升级版本号、创建 tag 或发布 Release。

## 7. PR、合并和清理

```powershell
git add <已解决文件>
git merge --continue
git status --short --branch
git diff --check
git push -u origin sync/upstream-<short-sha>-enhanced
```

PR base 必须是 `enhanced-mode`，并说明上游提交范围、共同基线、冲突决策、测试结果和未验证风险。用户确认后才合并；合并后 fetch 目标分支，确认提交已包含同步合并，再删除同步分支和干净 worktree。需要增强适配时，从新的 `origin/enhanced-mode` 创建独立 PR。

## 8. 自动化边界和检查清单

脚本或 CI 可以自动执行 fetch、基线计算、摘要、`merge-tree` 预判、同步分支和 Draft PR；有冲突时只报告冲突文件和测试状态，不替用户决定行为取舍，也不自动合并。

- [ ] 已 fetch 两个远端和 tags，工作树干净。
- [ ] 已记录 merge-base、ahead/behind 和上游提交范围。
- [ ] 同步分支从 `origin/enhanced-mode` 创建。
- [ ] 未全局使用 `ours`/`theirs`，重复增强实现已清理。
- [ ] 定向测试、完整测试和平台测试已分别记录。
- [ ] PR base/head、提交范围和测试结果已复核。
- [ ] 用户确认后才合并和清理。
