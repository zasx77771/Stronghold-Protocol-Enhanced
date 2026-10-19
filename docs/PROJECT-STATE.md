# 项目状态快照（增强版）

本文件记录**增强版新增内容**的当前状态：版本、分支、产物、已验证与未验证的范围。
上游本体（干员、技能、敌人、盟约、战斗规则）的规则文档仍是 `docs/DESIGN.md`、
`docs/ARCHITECTURE.md`、`docs/DATA.md`、`docs/SIM.md` 等，本文件不重复它们。

## 版本与分支

| 项目 | 当前值 |
| --- | --- |
| 上游基线 | `0.3.2`（`upstream/master` @ `c9d804f4`；上游尚未给 0.3.2 打标签） |
| 增强版版本 | `3.2.1`（映射规则：上游 `0.M.N` → 增强版 `M.N.<增强修订>`） |
| 版本事实来源 | `package.json`、`release-policy.json`（`upstreamMainlineVersion` / `androidVersionCode`） |
| 集成分支 | `ds-enhanced-mode` |
| 已发布标签 | `enhanced-v3.2.1`（在 `enhanced-v3.2.0` = `50d938b1` 之后） |
| GitHub Release | `Stronghold Protocol Enhanced 3.2.1`：只发布说明，**不上传安装包**（安装包留在本地成果目录） |

版本校验：`node tools/release-policy.mjs` 必须输出
`Release policy valid: upstream 0.3.2, local 3.2.1, Android versionCode 32.`（--mainline 只用于上游基线首次发布，3.2.1 的修订号不为 0，不加该开关）

## 产物与命名

正式产物只放工作区的 `enhanced-client-servers/02-增强版正式发布/v<版本>/`，目录名固定，文件名沿用旧口径。`3.2.1` 只升版本并发 Release，**未重打安装包**；下表是最后一次实际打出的 `3.2.0` 产物（3.2.1 的界面修复已在 `04-测试与验证/v3.2.0-post-merge/` 的测试包里验证过）：

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
- 上游 `0.3.2` 尚未打标签，增强版 `3.2.0` 的「上游基线」指 `upstream/master` 的 `c9d804f4`。
- Windows 增量包（`--update`）本轮未生成。

## 构建与自检

```bash
node tools/doctor.mjs          # 环境与素材自检
node tools/release-policy.mjs --mainline
node tools/check-native-compat.mjs
node tools/i18n.mjs check --all --strict
node --test test/docs-consistency.test.js test/docs-paths.test.js
npm run package:client:win     # Windows 便携客户端（需 Rust MSVC + 已构建的 release exe）
npm run package:client:android # 收集已签名的 release APK
npm run package:server:lite    # 精简服务端（不含素材）
```

改动历史见 `CHANGELOG.md`。
