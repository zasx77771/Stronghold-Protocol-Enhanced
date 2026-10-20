# 项目状态快照（增强版）

本文件记录**增强版新增内容**的当前状态：版本、分支、产物、已验证与未验证的范围。
上游本体（干员、技能、敌人、盟约、战斗规则）的规则文档仍是 `docs/DESIGN.md`、
`docs/ARCHITECTURE.md`、`docs/DATA.md`、`docs/SIM.md` 等，本文件不重复它们。

## 版本与分支

| 项目 | 当前值 |
| --- | --- |
| 上游基线 | `0.3.2`（`upstream/master` @ `c9d804f4`；上游尚未给 0.3.2 打标签） |
| 增强版版本 | `3.2.2`（映射规则：上游 `0.M.N` → 增强版 `M.N.<增强修订>`） |
| 版本事实来源 | `package.json`、`release-policy.json`（`upstreamMainlineVersion` / `androidVersionCode`） |
| 集成分支 | `ds-enhanced-mode` |
| 已发布标签 | `enhanced-v3.2.2`（在 `enhanced-v3.2.1` 之后） |
| GitHub Release | `Stronghold Protocol Enhanced 3.2.2`：只发服务端包与说明，客户端/APK 维持 3.2.1，安装包留在本地成果目录 |

版本校验：`node tools/release-policy.mjs` 必须输出
`Release policy valid: upstream 0.3.2, local 3.2.2, Android versionCode 33.`（--mainline 只用于上游基线首次发布，3.2.2 的修订号不为 0，不加该开关）

版本写入：`node tools/release-policy.mjs --sync 3.2.3 [--code 34]` 从一处写入 `package.json`、`package-lock.json`、
`shared/constants.js`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、
`android/app/build.gradle` 的 `versionName` 与 `release-policy.json` 的 `androidVersionCode`（不给 `--code` 时不动
versionCode），写完后按上面同一套规则复校验。不带版本参数的 `--sync` 只把 `package.json` 的当前版本补齐到其余副本。
`src-tauri/Cargo.lock` 里本包的那一行也纳入校验（3.2.2 曾出现 lock 仍写 3.2.1，下一次 `cargo build` 才被改写）。

## 产物与命名

正式产物只放工作区的 `enhanced-client-servers/02-增强版正式发布/v<版本>/`，目录名固定，文件名沿用旧口径。`3.2.1` 只升版本并发 Release，**未重打安装包**；下表是最后一次实际打出的 `3.2.0` 客户端产物（3.2.1 的界面修复已在 `04-测试与验证/v3.2.0-post-merge/` 的测试包里验证过）；`3.2.2` 只发服务端包，客户端与 APK 未重打：

| 产物 | 文件名 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Windows 客户端 | `Stronghold-Protocol-Client-v3.2.0-win-x64.zip` | 830,758,577 B | `40658C507B905CC13701DF0B99A9B025F9F0ED19867F06AA0EB17F82998B2EC5` |
| Android 客户端 | `android-client/Stronghold-Protocol-Client-v3.2.0-android.apk` | 858,810,511 B | `122AFAD90554F992D6270A0CF9F5961E13252EF11D884D09A5DA76453D90370A` |
| 精简服务端 | `Stronghold-Protocol-Server-v3.2.0-win-x64.zip` | 67,589,830 B | `8DDC9870C0269A6FFD44987DB68F2CFD159E5B5950C51427DBABB43774007653` |

- 命名由脚本固定：`scripts/make-windows-client.mjs`、`scripts/make-android-client.mjs`、
  `scripts/make-server-lite.mjs`；目录名照 `--out`，压缩包写到 `--out` 同级。
- Android 正式签名指纹 `68:9A:53:F1:DC:42:71:A5:0A:26:58:91:EE:BF:E1:AC:08:76:87:93:69:CE:5E:AA:EE:53:12:3A:42:03:31:DE`；
  发布前必须过 `apksigner verify --print-certs` 与 `zipalign -c -p 4`。
- 3.2.0 未生成 Windows 增量包（只出完整包）；3.2.1 未重打包。
- `3.2.2` 起的精简服务端包另行携带 `app\MANIFEST.json`，并额外出
  `Stronghold-Protocol-Server-v<版本>-win-x64-update.zip`（服务端增量包，见 [WINDOWS.md](WINDOWS.md) §7.1）。
  已发布的 3.2.0 / 3.2.1 完整包没有这份清单，仍可充当增量包的基线：服务器核对的是升级后的状态，不看基线包有没有清单。
- 3.2.2 只发服务端：完整包 `Stronghold-Protocol-Server-v3.2.2-win-x64.zip`（52,862,385 B，2,983 个文件 / 解压后
  150.0 MB）与增量包 `Stronghold-Protocol-Server-v3.2.2-win-x64-update.zip`（559,424 B，18 个文件，同时支持 3.2.0 与
  3.2.1 两个基线）。哈希与端到端验证记录只留在本地
  `enhanced-client-servers/02-增强版正式发布/v3.2.2/release-validation/v3.2.2-server.md`，不入 Git。
- 服务端增量包保留最近 2 个基线，已发布的完整包与增量包全部保留、不清理（客户端增量包才按主线验证后清理中间小版本）。

## 3.2.1 包含的修复

- 原生客户端「复制链接」改为玩家实际连接的 TCP 端点（	cp://host:port/?room=CODE），不再复制 WebView/Tauri 外壳自己的页面地址。
- 标题页登录列在手机上不再画滚动条（44px 触控热区与输入框角标画在盒子外，Android WebView 会为这几像素溢出画通栏滚动条）。
- 标题页的服务器地址框与博士代号框统一为 .field--lg，「应用」按钮跟同一把尺子，三者严格等高。
- 精简服务端打包改为按服务端真实 import 收缩运行时依赖（pp/node_modules 6,002 → 1,885 文件）。

## 3.2.0 包含的增强

### 原生客户端（Windows / Android）
- Windows 是 Tauri 便携包（**不生成安装器**），`client\` 必须与 `Stronghold Protocol.exe` 同层
  （`src-tauri/src/protocol.rs` 的 `client_root()` 先找 `resource_dir()/client`，再找 exe 旁的 `client`）。
- 启动可诊断：日志写到 `%LOCALAPPDATA%\Stronghold Protocol Enhanced\client.log`（回退 `%TEMP%`、exe 同目录），
  WebView2 配置目录固定并跟随 exe 旁（便携），首次创建失败会换一个干净目录重试。
- 没有内置服务器地址：地址只在标题页填写，缺地址时不发起 TCP 连接，标题页提示「请先填写服务器地址」。
- Android 原生桥同时接受 `report(id, event)` 与 `report({id, type, …})` 两种事件形状
  （安卓壳用后者；3.1.0 以来 Android 一直接不上就是这里），由 `test/native/bridge-contract.test.js` 保护。
- 素材：「素材」浮动按钮已移除（标题页负责下载/导入）；进入对局前由 `public/js/assetPreload.js`
  按本局内容集预取干员头像与立绘，网页端同样生效。

### 打包与服务端
- `npm run package:client:win` / `package:client:android` / `package:server:lite` 分别产出上表三件产物；
  玩家完整包（含素材）仍是 `npm run package`，不带素材的社区分享包是 `package:lite`。
- 精简服务端包不含任何素材文件，但保留 `data/assets.json` 清单（客户端据此请求素材）；
  启动器默认 HTTP `3000` + TCP `3001`、`SP_ASSET_INDEX=0`、单进程。
- 打包链细节见 `docs/WINDOWS.md` 第 7、8 节，原生改造的决策记录见 `docs/NATIVE-RECONSTRUCTION.md`。

## 验证状态（2026-10-19）

| 项目 | 结果 |
| --- | --- |
| HTTP 走查（桌面 1920×1080） | 8 步 / 失败 0 / 25.6 s；console 错误 0、页面异常 0、失败请求 0、4xx-5xx 0 |
| TCP 走查（3001） | 3/3：连接、ping→pong、hello→welcome |
| Android 走查（模拟器实装 APK） | 标题 → 协议选择 → 房间 → 简报 → 策略 → 战场，素材即时显示 |
| Windows 走查（打包 exe，普通权限） | 标题 → 模式选择 → 房间 → 简报 → 策略 → 战场 |
| 单元测试 | `docs-consistency` / `docs-paths` / `asset-preload` 36 pass；`test/native/*`、`connection`、`title-layout`、`client-static` 全绿 |
| i18n | `node tools/i18n.mjs check --all --strict`：四语言包各 2176 msgid / 100% / 0 missing |
| 原生兼容契约 | `node tools/check-native-compat.mjs` → OK |

**未验证 / 已知限制**

- 完整 `npm run ci` 未跑完：本机缺少 `SeCreateSymbolicLink` 特权，依赖符号链接的用例报 `EPERM`，
  另有并行构建下的超时；相关用例已单独复跑通过，但完整套件结论仍按「未通过」记录。
- 3.2.2 的完整 `npm test` 没有在放开限制的环境重跑（8,621 个用例里 89 个失败，均判断为本机 symlink/子进程/超时/
  性能阈值）：下一次生成完整包时按 `RELEASE-POLICY.md` 验证清单补跑，全过则把 3.2.2 的结论记为正常，未过照实报告。
- 上游 `0.3.2` 尚未打标签，增强版 `3.2.0` 的「上游基线」指 `upstream/master` 的 `c9d804f4`。
- Windows 增量包（`--update`）本轮未生成。

## 构建与自检

```bash
node tools/doctor.mjs          # 环境与素材自检
npm run release:check          # 版本一致性（上游基线首次发布用 node tools/release-policy.mjs --mainline）
npm run release:sync -- 3.2.3 --code 34   # 一处写 7 个文件版本号与 androidVersionCode
node tools/check-native-compat.mjs
node tools/i18n.mjs check --all --strict
node --test test/docs-consistency.test.js test/docs-paths.test.js
npm run package:client:win     # Windows 便携客户端（需 Rust MSVC + 已构建的 release exe）
npm run package:client:android # 收集已签名的 release APK
npm run package:server:lite    # 精简服务端（不含素材）
npm run package:server:update -- --from <旧包>,<旧包>   # 服务端增量包（覆盖最近 2 个基线）
```

## 前端截图自检（不打包）

改 CSS 或布局时不必走「打包 → 装机 → 截图」：

```bash
npm start                                                    # 另开一个终端，本地服务端在 3000
node scripts/shots.mjs --name title --url http://127.0.0.1:3000/
node scripts/shots.mjs --name title --url http://127.0.0.1:3000/ --compare test/e2e/out/shots
```

- 输出 `test/e2e/out/shots/<名字>.png`，同时报 HTTP 状态、页面标题、控制台/请求错误和横向溢出（`scrollWidth > clientWidth`）。
- `--compare <目录>` 与上一版逐像素比，给出不同像素数与 `<名字>.diff.png`（差异标红、其余压暗）；与 `--out` 指向同一目录时，比的是「上一次 vs 这一次」。
- 有控制台错误、横向溢出或与基线有差异时退出码为 1，可以直接当门禁。
- 其它选项：`--size 1280x720`、`--wait 4000`（多等动画/素材）、`--full-page`、`--json`。
- 它自己以 `--headless=new` 起本机 Chrome，再用 CDP 连它的调试端口（不用管道），所以需要 Chrome 或 `CHROME_PATH`。**在 DSH 沙箱里 Chrome 要建 Mojo 命名管道，会启动失败**，需对该条命令放宽权限或在沙箱外运行。

## 按改动挑测试

测试有 870 个文件，全量跑很慢。改完代码先让工具按改动挑：

```bash
node tools/affected.mjs                 # 相对 origin/ds-enhanced-mode 的全部改动
node tools/affected.mjs --uncommitted   # 只看工作区（对比 HEAD）
node tools/affected.mjs --staged        # 只看已暂存
node tools/affected.mjs --run           # 挑出来顺手跑掉
node tools/affected.mjs --json          # 给脚本用
```

- 判定方式：扫全部 `test/**/*.test.js` 的 import，建「文件 → 引用它的测试」反向表；改到哪个源文件，就跑引用了它的测试。
- Rust（`src-tauri/`）、文档（`docs/`、`*.md`）、界面（`public/css`、`ui/`、`*.css`）分别提示对应的门禁命令，不混进 Node 测试清单。
- **会自动升级为全量**：改了 `package.json` 等根配置；改了 `shared/`、`server/`、`public/js/` 却没有测试引用（可能是测试按路径读文件，索引看不到）；有文件无法归类；挑出的测试超过总量一半。
- 宁可多跑不可漏跑；它只影响「本地先跑哪些」，合入前的 `npm run ci` 仍是全量。

跑单个测试请用 `node test/<文件>`，不要用 `node --test <文件>`——后者要 spawn 子进程，受限沙箱里报 `spawn EPERM`。

改动历史见 `CHANGELOG.md`。
