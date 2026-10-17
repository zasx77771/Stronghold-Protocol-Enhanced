# Stronghold Protocol Enhanced 仓库规则

本文件是版本库内的持久化入口。完整规则见 `docs/PROJECT-RULES.md`，开发、同步、PR 和发布流程见 `docs/DEVELOPMENT-WORKFLOW.md`。开始任务前读取与本次修改相关的专项文档。

## 核心边界

- 修改前 fetch `origin` 和 `upstream`，核对当前分支、跟踪远端、基线、ahead/behind、工作树和已有 worktree；无法 fetch 时不得声称基于最新代码或创建 PR。
- 所有修改使用独立分支或独立 worktree，不直接提交到个人 `master`、`enhanced-mode` 或 `upstream/master`，不覆盖或混入现有未提交修改。
- 游戏代码从最新个人 `master` 建分支；先在上游创建 Issue，再向 `upstream/master` 提交带 `Closes #<Issue>` 的 PR。上游 PR 合并前不得进入个人长期分支。
- `stronghold-protocol` 主工作区只负责个人 `master` 与上游的 Sync Fork。上游 PR 合并后 Sync Fork 个人 `master`；关闭或拒绝后删除本地和个人远端功能分支，保留 Issue 与 PR 记录。
- `enhanced-mode` 从自身建立同步分支并合并最新 `upstream/master`；必要的增强适配在同步后使用另一个分支和 PR。增强专属功能只向个人 `enhanced-mode` 提交。
- 每个功能、同步或适配 PR 是否合并都要单独获得用户确认。合并或关闭后清理本地、个人远端分支和已确认干净的 worktree。
- 一轮经确认的 PR 全部合并后自动执行正式发布，不再逐步询问发布分支、发布 PR、标签或 GitHub Release；任何测试、构建或验证失败都必须中止发布。
- 上游 `0.M.N` 映射增强版 `M.N.R`。Android 对外使用相同 `M.N.R`，内部保留递增整数 `versionCode`。新标签使用 `enhanced-vM.N.R`，只在个人仓库发布增强标签、Release 和产物。
- 上游 ZIP 只复用素材，代码与规则只以 Git 为准。依赖、素材、缓存、产物、密钥、账户数据库和录像不得提交 Git。
- 长期规则只有提交并合并到个人 `enhanced-mode` 后才算完成持久化。

## 验证

- 行为修复增加回归测试；共享逻辑、协议、存档、战斗引擎或公共数据变化运行完整测试集。
- 测试报告区分通过、失败、跳过、未运行和静态检查。完整测试失败后，隔离复测通过也不能改写为完整测试通过。
- 提交和创建 PR 前复核仓库、head、base、提交范围、差异内容、版本元数据及文档。
## Upstream development guide

Entry point for AI coding assistants (Codex, Claude Code, Cursor, Copilot …) working on this repository. It only
indexes the existing documents and their hard rules; when this file and a linked document disagree, the document wins.
Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the same material in full.

## What this is

A non-commercial fan remake of Arknights「卫戍协议：盟约」 that runs in the browser: a Node.js server (economy, rounds,
rooms) and a deterministic battle sim shared by the server and the browser. It aims to be faithful to the official mode.

## Read first

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the code map: where things live, data flow, golden results,
   import boundaries, where common changes start.
2. [docs/DESIGN.md](docs/DESIGN.md) — the index of the rules: current rules in `docs/design/`, each release's
   revisions and their evidence in `docs/history/`.
3. The reference for the part you touch: [docs/SIM.md](docs/SIM.md) (battle engine API, hooks, test harness),
   [docs/META.md](docs/META.md) (match flow, shop, protocol), [docs/DATA.md](docs/DATA.md) (generated data),
   [docs/I18N.md](docs/I18N.md) (interface strings), `server/sim/content/kits/README.md` (operator kits).

## Hard rules

- **Official first.** Rules come from the official data tables (`.cache/gamedata/excel/` after setup) and
  [PRTS](https://prts.wiki/). A detail no source settles is implemented the simplest way and marked `[ASSUMED]` in the
  code and the PR. Deliberate deviations from the official mode are the maintainer's decision only.
- **Determinism.** `server/sim/` is plain ESM that runs in Node and in browsers: no Node APIs, no `Math.random`, no
  clocks, and no engine-approximated Math functions (use `server/sim/detmath.js`; ESLint and
  `test/sim/detmath.test.js` enforce it).
- **Golden results.** A refactor must not change `test/golden/*.json`. An intended gameplay change runs
  `npm run golden:update` in the same commit, and the commit / PR names every moved scenario and why
  ([test/golden/README.md](test/golden/README.md)).
- **Generated data.** Never hand-edit `data/*.json`: change `tools/build-data.mjs` and regenerate.
- **No game art in git.** `public/assets/` is ignored; never commit extracted or downloaded game files.
- **Interface strings** go through `t('…')`, with entries in every pack under `public/i18n/`
  (`node tools/i18n.mjs check --all --strict`).
- **Docs follow the code.** A rule change updates `docs/design/`, the current `docs/history/` file and the reference
  docs; run `node --test test/docs-consistency.test.js test/docs-paths.test.js`.
- **Commits and PRs**: one topic per PR; a one-line message of what changed (Chinese or English) with the issue number;
  no attribution trailers (`Co-Authored-By:`, `Generated with …`). The PR description states what, why, the sources,
  the `[ASSUMED]` points, the tests you ran (paste the summary lines) and the golden moves. No ads, payments or other
  monetisation — the project stays non-commercial.

## Verify

Run the tests of what you touched first, then everything before opening the PR:

```bash
node --test test/<area>/<file>.test.js      # targeted
npm run ci                                  # the CI checks locally (tools/ci.mjs): node --test, smoke, lint, imports, types
npm run golden                              # golden results
```

Browser suites are off by default and need Chrome: `SP_E2E=1` (UI), `SP_REAL_E2E=1` (real match, needs assets),
`RENDER_E2E=1`, `SIM_E2E=1` — see CONTRIBUTING.md §2. Battle tests are easiest with the helpers described in
docs/SIM.md (the test harness section) and the patterns in `test/content/op_siege.test.js`.
