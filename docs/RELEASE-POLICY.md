# 版本与发布政策

本文件规定增强版（`Stronghold Protocol Enhanced`）的版本号、标签与 Release 口径。它只讲「版本怎么算、发布长什么样」；发布包怎么做、产物叫什么名字见 [../scripts/CLIENT-UPDATES.md](../scripts/CLIENT-UPDATES.md)。

## 版本号

- 上游 `0.M.N` 对应增强版 `M.N.R`：`M` 取上游次版本号，`N` 取上游补丁号，`R` 是同一上游基线内的增强修订号，新基线从 `R=0` 开始。
- 已发布的旧 `0.2.*`、`0.3.*` 不追溯改名。
- `release-policy.json` 是机器可读的真源：`upstreamMainlineVersion` 必须是 `0.M.N`，`androidVersionCode` 是 Android 的内部递增整数；`package.json` 的 `version` 必须等于 `M.N.R`。
- 校验：

```bash
node tools/release-policy.mjs              # 任意版本（含 R>0）
node tools/release-policy.mjs --mainline   # 新上游基线，要求 R=0
```

## 什么时候升版本

- 普通代码 PR **不**改版本号。多个已合并 PR 可以归入同一个尚未发布的版本。
- 只有明确执行正式发布、或生成正式产物时才升版本，由发布那一次提交统一改：`package.json`、`package-lock.json`、`README.md` 徽章、`shared/constants.js`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`android/app/build.gradle`、`release-policy.json`、`CHANGELOG.md`。
- Android 对外 `versionName` 与增强版一致，`versionCode` 每次正式发布加一；`versionCode` 不进标签、产物名或 Release 标题。

## 标签与 Release

- 标签：`enhanced-vM.N.R`，打在发布对应的合并提交上。
- Release 标题：`Stronghold Protocol Enhanced M.N.R`。
- 标签、Release 与产物只发布到个人仓库 `zasx77771/Stronghold-Protocol-Enhanced`，不发布到上游主仓库。
- 已发布的包不得原地替换。

## Release 附件

- **默认不附安装包**：Release 只发布说明文字，安装包另行分发。
- 若要附包，必须在发布记录里写明：为什么附、附了哪几个文件（文件名 + 大小 + SHA-256）。
- 无论是否附包，说明里都要列出本版产物的文件名、大小与 SHA-256，便于持有人自查。

## 测试包

- 测试包可以沿用当前版本号，但文件名必须带 `test`、功能名或提交号，且不得覆盖正式产物。

## 验证清单

发布前依次确认：

1. `node tools/release-policy.mjs` 通过。
2. 走查按 `WORKSPACE-RULES.md` 的走查中断点跑完（桌面 + TCP + 可用的 Android 客户端），并停住等确认。
3. 本版产物已生成、哈希已记录（见 [../scripts/CLIENT-UPDATES.md](../scripts/CLIENT-UPDATES.md)）。
4. `CHANGELOG.md` 有对应版本段落。
5. 标签、Release 已创建；Release 说明含产物哈希。
