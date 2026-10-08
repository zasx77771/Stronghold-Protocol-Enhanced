# 项目规则索引

本文件记录长期规则、事实源和规则变更，不复制专项实现细节。当前任务中的用户明确指令优先；新确认规则覆盖旧规则；一次性例外不会自动成为长期规则。

## 分类与事实源

- 游戏代码类：本体、干员、技能、敌人、盟约、战斗规则及可提交上游的通用修复。
- 增强功能类：Windows、Android、TCP、账户、记录、回放、更新器及不提交上游的增强行为。
- 明确要求提交主仓库或 `upstream/master` 时按游戏代码类处理；明确要求只进入 `enhanced-mode` 时按增强功能类处理。仅说提交 `enhanced-mode` 时仍需确认分类。
- 未声明“有意差异”时，依次核对上游 Git、官方数据、可核验资料、研究记录、代码与测试。无法确认的行为标记为“推断”或 `ASSUMED`。
- 用户提供的 ZIP 只用于素材复用，代码和规则以 Git 为准。

## 文档路由

| 领域 | 事实源 |
|---|---|
| 开发、分支、PR、同步、发布 | `docs/DEVELOPMENT-WORKFLOW.md` |
| 当前易变状态 | `docs/PROJECT-STATE.md` |
| 上游历史与同步说明 | `docs/UPSTREAM-UPDATE.md` |
| 版本映射与发布元数据 | `docs/RELEASE-POLICY.md`、`release-policy.json` |
| 完整包和增量包 | `scripts/CLIENT-UPDATES.md` |
| 账户和身份 | `docs/ACCOUNT.md` |
| 对局记录和回放 | `docs/REPLAY.md` |
| 产品功能 | `docs/FEATURES.md`、`docs/DESIGN.md` |
| 游戏逻辑 | `docs/DESIGN.md`、`docs/SIM.md`、`docs/META.md`、`docs/DATA.md`、`docs/BALANCE.md` |
| 部署 | `docs/DEPLOY.md` |
| 素材与许可 | `docs/ASSETS.md`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md` |
| 成果目录 | `../enhanced-client-servers/README.md` |

## 规则维护

- 长期规则只有写入对应事实源、提交并合并到个人 `enhanced-mode` 后，才算完成持久化。
- 根工作区 `AGENTS.md` 是本机入口；聊天、未提交文件、临时分支和未合并 PR 不是持久化事实源。
- 当前版本、分支、开放 PR、工作树和构建状态只写入 `PROJECT-STATE.md`，执行任务时仍以 Git 和实际文件为准。
- 修改长期规则需要用户确认。新规则覆盖旧规则时修正原条目，不保留互相矛盾的有效流程。
- 未确认内容不得写成生效规则。
- 功能、上游同步和正式发布完成时，检查规则、专项文档、脚本、版本文件和 README 是否一致。

## 变更记录

- 2026-10-06：建立分层规则与专项文档结构；ZIP 改为只复用素材；确定 `0.M.N -> M.N.R` 映射。
- 2026-10-08：游戏代码改为先建上游 Issue、再从个人 `master` 分支直接提交上游 PR；上游未合并前不进入个人长期分支。
- 2026-10-08：个人 `master` 只做 Sync Fork；`enhanced-mode` 通过同步分支合并上游，再以独立分支完成必要增强适配。
- 2026-10-08：一轮经用户确认的 PR 全部合并后自动完成版本升级、打包、标签和个人仓库 GitHub Release。
- 2026-10-08：新增强标签不再包含 Android `versionCode`；公开 Android 版本统一使用 `M.N.R`。
