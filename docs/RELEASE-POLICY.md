# 版本与发布政策

本文件规定增强版（`Stronghold Protocol Enhanced`）的版本号、标签与 Release 口径。它只讲「版本怎么算、发布长什么样」；发布包怎么做、产物叫什么名字见 [../scripts/CLIENT-UPDATES.md](../scripts/CLIENT-UPDATES.md)。

## 版本号

- 上游 `0.M.N` 对应增强版 `M.N.R`：`M` 取上游次版本号，`N` 取上游补丁号，`R` 是同一上游基线内的增强修订号，新基线从 `R=0` 开始。
- 已发布的旧 `0.2.*`、`0.3.*` 不追溯改名。
- `release-policy.json` 是机器可读的真源：`upstreamMainlineVersion` 必须是 `0.M.N`，`androidVersionCode` 是 Android 的内部递增整数；`package.json` 的 `version` 必须等于 `M.N.R`。
- 写版本号：一律用 `node tools/release-policy.mjs --sync <版本> [--code <versionCode>]`（等价 `npm run release:sync -- <版本> [--code <versionCode>]`），一次写齐 `package.json`、`package-lock.json`、`shared/constants.js`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`android/app/build.gradle`，以及 `release-policy.json` 的 `androidVersionCode`。不要手改，漏一处要重打两个客户端才发现。
- 校验：`npm run release:check`（任意版本，含 R>0）；`node tools/release-policy.mjs --mainline` 只用于新上游基线的首次发布（要求 R=0）。

## 什么时候升版本

- 普通代码 PR **不**改版本号。多个已合并 PR 可以归入同一个尚未发布的版本。
- 只有明确执行正式发布、或生成正式产物时才升版本，由发布那一次提交统一改：`package.json`、`package-lock.json`、`README.md` 徽章、`shared/constants.js`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`android/app/build.gradle`、`release-policy.json`、`CHANGELOG.md`（`--sync` 负责前八处，徽章、CHANGELOG 与 `test/version.test.js` 的 `versionCode` 镜像断言手改）。
- Android 对外 `versionName` 与增强版一致，`versionCode` 每次正式发布加一；`versionCode` 不进标签、产物名或 Release 标题。

## 标签与 Release

- 标签：`enhanced-vM.N.R`，打在发布对应的合并提交上。
- Release 标题：`Stronghold Protocol Enhanced M.N.R`。
- 标签、Release 与产物只发布到个人仓库 `zasx77771/Stronghold-Protocol-Enhanced`，不发布到上游主仓库。
- 已发布的包不得原地替换。

## Release 附件

- **默认不附安装包**：Release 只发布说明文字，安装包另行分发。
- 服务端包（完整包 + 增量包，合计约 50 MB）可以附在 Release 上，方便服主直接下载升级；客户端与 APK 默认留在本地成果目录，要附时必须写明原因。
- 附包或附服务端包时，在说明里写明：为什么附、附了哪几个文件（文件名 + 大小 + SHA-256）。附包只新增资产，不替换已发布的资产。
- 无论是否附包，说明里都要列出本版产物的文件名、大小与 SHA-256，便于持有人自查。

## 测试包

- 测试包可以沿用当前版本号，但文件名必须带 `test`、功能名或提交号，且不得覆盖正式产物。

## 验证清单

发布前依次确认：

1. `npm run release:check` 通过（上游基线首次发布另加 `--mainline`）。
2. 走查按 `WORKSPACE-RULES.md` 的走查中断点跑完（桌面 + TCP + 可用的 Android 客户端），并停住等确认。
3. 本版产物已生成、哈希已记录（见 [../scripts/CLIENT-UPDATES.md](../scripts/CLIENT-UPDATES.md)）。
4. 服务端代码、运行时或协议变化时：完整包与增量包都已生成，增量包对**每个保留基线**（最近 2 个）做过真实升级验证。
5. `CHANGELOG.md` 有对应版本段落。
6. 标签、Release 已创建；Release 说明含产物哈希，附了包就写清原因。
7. 上一版若因环境限制没跑通完整测试，本版生成完整包时先补跑完整测试：全过就把结论记为正常，未过照实报告失败项。
