# 增强改动清单

这份文档解决一个问题：上游（`sganggs/Stronghold-Protocol`）更新后，怎么知道增强版改过什么、为什么改、合并时哪里会冲突。

每次同步上游之前先读它，同步之后按实际结果更新它。它记录的是**与上游的差异**，不是功能说明书；功能说明见 `docs/PROJECT-STATE.md` 与 `CHANGELOG.md`。

## 0. 数字怎么取

```bash
git fetch upstream --prune --tags
git rev-list --left-right --count upstream/master...ds-enhanced-mode   # 落后 / 领先
git diff --shortstat upstream/master...ds-enhanced-mode               # 改动规模
git diff --name-status upstream/master...ds-enhanced-mode             # A=上游没有 / M=改过上游文件
git diff --numstat upstream/master...ds-enhanced-mode | sort -rn      # 谁改得多
```

判定一行是「新增」还是「修改」的标准：`git cat-file -e upstream/master:<path>` 是否存在。**新增文件合并时不会冲突**，所以要盯的只有「修改」那一栏。

## 1. 新增文件（上游没有对应物）

这类文件是增强版的净增量，同步时零冲突，也不需要重新附加。按领域分：

| 领域 | 代表路径 | 说明 |
| --- | --- | --- |
| Windows 原生容器 | `src-tauri/`（`src/`、`tauri.conf.json`、`capabilities/`、`icons/`、`release-frontend/`） | Tauri 外壳、内嵌静态服务、TCP 适配、素材内嵌校验 |
| Android 原生容器 | `android/app/src/main/java/org/strongholdprotocol/nativeclient/**`、`android/gradle*` | 原生客户端、素材包导入（`AssetStore`/`AssetPackage`/`AssetJson`）、WebView 桥 |
| 原生桥协议 | `native/bridge/*`、`native/web/*` | 页面与宿主之间的契约、隐私契约 |
| 增强工具 | `tools/affected.mjs`、`tools/release-policy.mjs`、`tools/server-update.mjs`、`tools/check-native-compat.mjs`、`tools/check-embedded-assets.mjs` | 按改动挑测试、一处写版本号、服务端增量升级、原生契约检查 |
| 打包脚本 | `scripts/make-windows-bundle.mjs`、`make-windows-client.mjs`、`make-server-lite.mjs`、`win-copy.mjs`、`rust-check.mjs`、`shots.mjs`、`package*.mjs` 相关新增 | 客户端/服务端产物、增量包、截图回归 |
| 前端增强模块 | `public/js/lineups*.js`（本机配队）、`public/js/ui/*` 增强模块 | 配队保存/读取、入口页组件 |
| 测试 | `test/native/**`、`test/ui/lineups.test.js`、`test/ui/title-layout.test.js`、`test/server-update.test.js`、`test/affected.test.js`、`test/shots.test.js` 等 | 原生契约、配队、增量包、工具自身 |
| 文档 | `docs/NATIVE-RECONSTRUCTION.md`、`docs/WINDOWS.md`（新增段落）等 | 原生客户端与打包说明 |

## 2. 被修改的上游文件（37 个，冲突只可能出现在这里）

标记说明：**改动量**为 `+行/−行`；**上游频次**是该文件在 `upstream/master` 自 2026-05-01 起被改动的提交数（越大越容易撞车）。
两列数字在 2026-10-24 同步上游 0.3.3 后重新统计（上游基线 `f07b8965`）：改动量取
`git diff --numstat upstream/master...ds-enhanced-mode`，上游频次取 `git rev-list --count --since=2026-05-01 upstream/master -- <文件>`。

### 入口页与连接

| 文件 | 改动量 | 增强目的 | 上游频次 | 同步注意 |
| --- | --- | --- | --- | --- |
| `public/js/screens/title.js` | 117 / 31 | 服务器地址并入登录区、代号框与地址框等高、连接方式切换（TCP 也收 `http://` 地址） | 22 | **最大单点**：上游改标题页时逐段核对 |
| `public/css/screens/title.css` | 59 / 4 | 同上，窄屏滚动与分栏 | 15 | 与 title.js 一起看 |
| `public/js/ui/components.js` | 3 / 1 | 登录区组件复用 | 22 | 小改 |
| `public/js/ui/playerName.js` | 10 / 10 | 代号上限放宽到 16 字符（8 汉字） | 2 | 与 `shared/constants.js` 联动 |
| `public/js/main.js` | 5 / 0 | 连接方式（WebSocket/TCP）初始化 | 49 | 上游常改，按块保留 |
| `public/js/net.js` | 5 / 0 | 可编辑服务器地址、粘贴邀请 | 7 | 小改 |
| `public/js/screens/room.js` | 16 / 5 | 原生客户端复制邀请链接用 TCP 端点 | 40 | 与上游邀请流程对照 |

### 配队与对局前

| 文件 | 改动量 | 增强目的 | 上游频次 | 同步注意 |
| --- | --- | --- | --- | --- |
| `public/js/screens/loadout.js` | 84 / 0 | 本机配队保存/读取/删除 | 41 | **次大热点**：上游改调配界面时逐段核对 |
| `public/css/screens/loadout.css` | 23 / 0 | 配队区样式 | 31 | 与 loadout.js 一起看 |
| `public/js/screens/briefing.js` | 8 / 1 | 进对局前预取干员立绘 | 13 | 小改 |

### 服务端与共享层

| 文件 | 改动量 | 增强目的 | 上游频次 | 同步注意 |
| --- | --- | --- | --- | --- |
| `server/index.js` | 21 / 3 | 原生容器入口、TCP 监听接线 | 54 | 上游常改，接线块必须整体保留 |
| `server/net.js` | 6 / 3 | 代号长度放宽 | 29 | 与常量联动 |
| `shared/constants.js` | 12 / 2 | 代号上限、版本映射 | 50 | 上游常改，注意别覆盖上游新常量 |
| `shared/packs.js` | 2 / 2 | 插件兼容链改用上游应用版本 | 5 | 与 plugins 三件套一起看 |
| `shared/plugins/manifest.js` | 7 / 7 | 同上 | 28 | 上游改插件清单时对照 |
| `shared/plugins/catalog.js` | 3 / 3 | 同上 | 3 | 小改 |
| `server/plugins/registry.js` | 7 / 7 | 同上 | 40 | 上游常改 |
| `server/studio/templates/index.js` | 2 / 2 | 同上 | 10 | 小改 |

### 版本映射、打包与工具

| 文件 | 改动量 | 增强目的 | 上游频次 | 同步注意 |
| --- | --- | --- | --- | --- |
| `package.json` | 15 / 2 | 增强版脚本（原生构建、打包、走查、挑测试） | 38 | 上游常加脚本，合并时保留两侧 |
| `package-lock.json` | 2 / 2 | 版本号同步 | 30 | 冲突后重新 `npm install` 生成 |
| `tools/package-update.mjs` | 13 / 2 | 增量升级包（`--update --from`） | 3 | 上游改打包工具时对照 |
| `scripts/make-windows-bundle.mjs` | 8 / 8 | 便携客户端打包、WebView2 目录 | 3 | 与 `docs/WINDOWS.md` 一起看 |
| `test/version.test.js` | 28 / 0 | 版本映射断言 | 6 | 跟 `release-policy.json` 对齐 |
| `test/client-static.test.js` | 21 / 6 | 入口页静态断言 | 13 | 上游改 title 时同步改 |
| `test/lobby.test.js` | 8 / 2 | 代号长度断言 | 19 | 小改 |

### 文档与杂项

| 文件 | 改动量 | 增强目的 | 同步注意 |
| --- | --- | --- | --- |
| `docs/WINDOWS.md` | 189 / 0 | 增强版打包与原生说明 | 纯文档，手动合并 |
| `docs/PLAYING.md` | 9 / 0 | 入口页分栏、连接设置、邀请流程 | 上游改得最勤，冲突直接保留两侧 |
| `docs/DEPLOY.md` | 5 / 2 | 服务端增量升级 | 同上 |
| `CHANGELOG.md` | 92 / 0 | 增强版条目 | 冲突时保留双方条目 |
| `README.md` | 1 / 1 | 指向增强版说明 | 小改 |
| `AGENTS.md` | 5 / 0 | 挑测试工具的说明 | 小改 |
| `.gitignore` | 8 / 0 | 原生构建产物、素材、本地数据 | 小改 |

### 语言包（单独说明）

| 文件 | 改动量 | 上游频次 |
| --- | --- | --- |
| `public/i18n/en.json` | 42 / 1 | 203 |
| `public/i18n/ja.json` | 42 / 1 | 178 |
| `public/i18n/ko.json` | 42 / 1 | 179 |
| `public/i18n/zh-TW.json` | 42 / 1 | 177 |

四个语言包各新增 42 条增强字符串（配队、入口页、连接设置）。**这是全仓最容易冲突的地方**：上游几乎每个版本都会动语言包。

减负方案（**尚未实施，需单独分支**）：`public/js/ui/lang.js` 已支持 `uiOverlay`（主语言包之后再取一个覆盖文件），把增强字符串移进 `public/i18n/enhanced.<lang>.json`，并让 `tools/i18n.mjs` 的 `check --all --strict` 也认这个覆盖层，就能把这四个文件从差异集里永久摘掉。注意 i18n 的更新口径仍以上游为准。

## 3. 上游同步流程

```bash
# 1. 取最新
git fetch origin --prune --tags
git fetch upstream --prune --tags

# 2. 从集成分支建同步分支（不直接改 ds-enhanced-mode）
git switch -c sync/upstream-<上游版本> origin/ds-enhanced-mode

# 3. 合并上游
git merge --no-ff upstream/master

# 4. 只看被改过的 37 个文件有没有冲突
git diff --name-only --diff-filter=U

# 5. 验证
node tools/affected.mjs --run     # 按改动挑测试
npm test                          # 上游 runner（tools/test-run.mjs，按 ci-shards.json 分片）
npm run test:guards               # 分片表与 runner 自身的守卫用例
npm run ci                        # npm test + smoke + lint + imports + types
npm run golden                    # 行为基准，未有意改动玩法时不得变化
node tools/i18n.mjs check --all --strict
```

冲突处理原则：

- 上游已有相同或相似实现时**保留上游实现**，只保留必要且经过测试的最小增强差异。
- 新增的 97 个文件永远不冲突；冲突只可能出现在上面 37 个文件里，按表逐项对照即可。
- 文档类冲突（`docs/*`、`CHANGELOG.md`）保留两侧内容，不删任何一方。
- 合并后如果某条增强的前提被上游改掉了（比如上游自己做了同功能），在本文档对应行标注「已被上游取代」并说明删除理由，不要留死代码。

同步后的收尾：

- 版本号 `R` 归零：新上游基线从 `M.N.0` 开始（见根 `AGENTS.md` 第 4 节）。
- 走查中断点：桌面 + TCP + 可用 Android 客户端，跑完停住等用户确认。
- 通过 PR 合并回 `ds-enhanced-mode`，不直接提交。

## 4. 冲突热点与减负路线

按上游改动频次排序，同步时优先看这几处：

1. 四个语言包（177–203 次）→ 见上表的 `uiOverlay` 方案，待独立分支。
2. `shared/constants.js`（50）、`server/plugins/registry.js`（40）、`server/index.js`（54）→ 都是小改但上游常动，注意保留上游新增内容。
3. `public/js/main.js`（49）、`package.json`（38）。
4. `public/js/screens/loadout.js`（41）、`room.js`（40）、`public/js/screens/title.js`（22）。

进一步减负（都还没做，等需要时再提）：

- `title.js` 的 102/−31 收敛成「新模块 + 上游文件里 1~2 行调用」，把最大单点降成小改。
- `loadout.js` 的 +83 同样拆成独立模块。
- 每次同步后回填本文档的改动量与频次。

## 5. 维护规则

- 改动任何一个 `upstream/master` 已存在的文件，必须在第 2 节登记：文件、改动量、目的、同步注意。
- 新增文件按领域补进第 1 节，一句话说明用途。
- 删除某条增强时，把对应行改成「已被上游取代（版本）」或「已移除（原因）」，不直接删行，保留历史判断。
- 本文档只记差异与同步口径；玩法、架构、发布细节分别写在 `docs/DESIGN.md`、`docs/ARCHITECTURE.md`、`docs/RELEASE-POLICY.md`。

## 6. 同步记录（按上游版本倒序）

### 0.3.3 → 增强版下一版（2026-10-24）

15 个文件冲突，处理方式全部是「整文件取上游新版，再回贴增强的小改动」——上游对 `room.js`、`loadout.js`、`loadout.css` 与四个语言包
的改动量远大于增强侧（每文件 4–94 行），逐段合并只会把上游新结构搅碎。

| 文件 | 回贴的增强内容 |
| --- | --- |
| `public/js/screens/loadout.js` | 上游新增 `diySlotList/slotRecord` 导入与卡片视图；保留增强的 `lineupModel` 导入、配队状态与函数、配队弹层。**新增入口**：「更多」弹层里加「本地配队」菜单项（`data-testid="loadout-presets-more"`），否则卡片视图下点不到 |
| `public/css/screens/loadout.css` | 配队弹层样式并入上游新样式表 |
| `public/js/screens/briefing.js` | 上游删掉了 `MicroLabel/Img/RichText/tParts` 用法，只留增强的 `assetPreload` 预热效果 |
| `public/js/screens/room.js` | `inviteLink()` 走 `buildInviteLink` + `readSettings()`；`copy()` 缺服务器地址时提示而不是复制壳来源（R-009） |
| `server/index.js` | 保留 TCP 监听启动块，并放在上游 `eventLoop?.start()` 之前（TCP 失败时 eventLoop 尚未启动） |
| `package.json` | 采用上游 `test`（`tools/test-run.mjs`）与 `test:guards`，保留增强 `test:affected`；版本号维持增强版 |
| `package-lock.json` | 取增强侧，只保留根两处版本号 |
| 四个语言包 / `README` / `CHANGELOG` / `docs/PLAYING.md` | 两侧条目都保留 |

同步时修掉的不兼容：`test/ui/lineups.test.js` 断言 `sp.pref.loadout` 是 v1 平面表，上游 0.3.3 改成 v2 按干员存
（`{v:2, byChar, ops}`），断言改为 v2 形状。

已知工具缺陷（待单独修）：`tools/release-policy.mjs` 的 `versionLine()` 用带 `g` 的正则交给 `text.replace`，
会替换 `package-lock.json` 里所有同版本号的依赖条目（本次把 `@puppeteer/browsers` 的 3.2.3 误写成 3.2.4），需要限定到根两处。
