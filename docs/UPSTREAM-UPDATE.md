# 上游更新与增强版同步

本仓库使用 Git 远端、分支和实际标签保存上游与增强历史。标签必须先用 Git 核验，文档不得预先声明尚未创建的标签。

- `upstream-v0.1.0`：用户提供的 `Stronghold-Protocol-v0.1.0.zip` 原始源码基线。
- `upstream-v0.1.1`：用户提供的 `Stronghold-Protocol-v0.1.1.zip` 上游快照；提交 `1fd75dd` 从 `upstream-v0.1.0` 演进而来。
- `upstream-v0.1.2`：用户提供的 `Stronghold-Protocol-v0.1.2.zip` 上游快照；从 `upstream-v0.1.1` 演进而来。
- `upstream-v0.1.3`：用户提供的 `Stronghold-Protocol-v0.1.3.zip` 上游快照；从 `upstream-v0.1.2` 演进而来。
- `v0.1.4`、`v0.2.1`：上游仓库的正式 Git 标签；代码以 `upstream/master` 和实际标签为准。
- `enhanced-v1.4.0-vc17`：旧格式增强标签；旧标签保留原名，不追溯改名。
- `enhanced-v0.3.0-vc15`：基于上游 0.1.3 的旧格式增强标签。
- `enhanced-v0.2.6-vc13`：基于上游 0.1.2 的上一完整增强版（Android versionCode 13）。
- `enhanced-v0.2.5-vc12`：基于上游 0.1.1 的上一完整增强版。
- `enhanced-v0.2.4-vc11`、`enhanced-v0.2.3`、`enhanced-v0.2.3-vc10`：旧增强版历史节点，保留用于审计和回退。

`enhanced-client-servers`、Node 依赖、游戏素材、Android SDK/Gradle 缓存和打包产物不进入 Git。它们可由源码和现有构建脚本重新生成。

从下一次增强发布起，标签使用 `enhanced-vM.N.R`，不再附带 Android `versionCode`。版本是否已经发布还必须核验个人仓库的实际标签、GitHub Release 和产物。

用户后续提供的 ZIP 只用于素材复用，原文件保持不变；不得从 ZIP 导入或覆盖代码。

## 同步个人 master

`stronghold-protocol` 主工作区保持在个人 `master`，只负责与上游主仓库执行 Sync Fork。游戏代码开发必须使用从最新个人 `master` 建立的独立分支或 worktree，不在主工作区直接修改。

先确认工作树并获取远端：

```powershell
git status
git branch --show-current
git remote -v
git fetch upstream --tags
git fetch origin --prune
```

确认上游有更新后，通过 GitHub Sync Fork 更新个人 `master`。不要为尚未被上游合并的游戏 PR提前修改个人 `master`。

## 同步 enhanced-mode

从当前增强分支建立同步分支，再合并最新上游：

```powershell
git switch -c sync/upstream-<提交>-enhanced origin/enhanced-mode
git merge --no-ff upstream/master
```

解决冲突并完成测试后，从同步分支向个人 `enhanced-mode` 创建 PR；是否合并必须由用户单独确认。无需额外增强适配时，不创建空 PR；需要适配时，等待同步 PR 合并后，从最新 `origin/enhanced-mode` 另建分支和 PR。

出现冲突时优先保留新版上游游戏逻辑；上游已有相同或相似功能时删除重复增强实现，只保留必要且经过测试的最小差异。常见冲突位置为：

- `public/js/screens/title.js`、`serverAddress.js`：服务器地址、用户名、房间码、邀请链接与剪贴板。
- `public/js/screens/game.js`、`public/js/ui/gameLogic.js`：详情面板、撤退与出售按钮事件。
- `public/css/devices.css`、`public/js/ui/fieldHost.js`、`public/js/render/app.js`：Android 布局、清晰度、商店折叠镜头和触控区域。
- `server/index.js`、`server/tcp.js`：WebSocket/HTTP 与 TCP 传输。
- `desktop/`、`android/`、`scripts/build-*.ps1`：Windows/Android 壳和构建流程。

解决冲突后：

```powershell
git add <已解决的文件>
git merge --continue
```

## 历史补丁与 bundle

`enhanced-client-servers/07-Git迁移包` 中的补丁与 bundle 只用于复现或审计历史版本，不作为当前代码来源，也不得应用到当前工作树。

换机器时从个人 Git 仓库克隆，并重新配置 `upstream`。只有明确需要审计旧版本时，才在独立目录中使用历史 bundle，并先核对其校验值。

## 重新安装依赖、测试与打包

```powershell
npm ci
npm test
powershell -ExecutionPolicy Bypass -File scripts/build-windows-client.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-windows-server.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-android-client.ps1
```

构建脚本默认把成果写入仓库外层的 `enhanced-client-servers` 分类目录。Android 重新签名或发布正式版时，不要提交签名文件、密钥或口令。
