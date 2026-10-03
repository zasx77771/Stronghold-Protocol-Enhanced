# 上游更新后的增强版重新部署

本仓库用两个明确的 Git 标签保存改造范围：

- `upstream-v0.1.0`：用户提供的 `Stronghold-Protocol-v0.1.0.zip` 原始源码基线。
- `enhanced-v0.2.3-vc10`：当前完整增强版（Android versionCode 10）；从上述基线到该标签的有序提交范围，就是本次从头到尾的全部源码改动。`enhanced-v0.2.3` 保留为上一版历史节点。

`成果文件`、Node 依赖、游戏素材、Android SDK/Gradle 缓存和打包产物不进入 Git。它们可由源码和现有构建脚本重新生成。

## 推荐：把增强提交重放到新版上游

先保存现有工作，再获取上游：

```powershell
git status
git remote add upstream https://github.com/sganggs/Stronghold-Protocol.git
git fetch upstream --tags
```

如果已经存在名为 `upstream` 的 remote，跳过 `remote add`。随后从新版上游分支建立部署分支，并重放增强提交：

```powershell
git switch -c redeploy/latest upstream/main
git cherry-pick upstream-v0.1.0..enhanced-v0.2.3-vc10
```

出现冲突时，优先保留新版上游的游戏逻辑，再把增强版的连接入口、剪贴板/邀请链接、桌面与 Android 壳、移动端布局和详情面板交互逐项合并。常见冲突位置为：

- `public/js/screens/title.js`、`serverAddress.js`：服务器地址、用户名、房间码、邀请链接与剪贴板。
- `public/js/screens/game.js`、`public/js/ui/gameLogic.js`：详情面板、撤退与出售按钮事件。
- `public/css/devices.css`、`public/js/ui/fieldHost.js`、`public/js/render/app.js`：Android 布局、清晰度、商店折叠镜头和触控区域。
- `server/index.js`、`server/tcp.js`：WebSocket/HTTP 与 TCP 传输。
- `desktop/`、`android/`、`scripts/build-*.ps1`：Windows/Android 壳和构建流程。

解决冲突后：

```powershell
git add <已解决的文件>
git cherry-pick --continue
```

## 使用导出的补丁

如果目标仓库没有本仓库历史，可将目标仓库切到对应的新上游版本，再应用 `成果文件/07-Git迁移包` 中的补丁：

```powershell
git am --3way 000*.patch
```

`--3way` 会在文件上下文变化时尝试三方合并。补丁是源码差异，不包含 APK、Electron、SDK、`node_modules` 或游戏素材。

## 使用 Git bundle 完整恢复

Git bundle 包含基线、增强提交、分支和标签，可在另一台机器直接克隆：

```powershell
git clone -b main <Stronghold-Protocol-Enhanced.bundle 路径> Stronghold-Protocol-Enhanced
```

## 重新安装依赖、测试与打包

```powershell
npm ci
npm test
powershell -ExecutionPolicy Bypass -File scripts/build-windows-client.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-windows-server.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-android-client.ps1
```

构建脚本默认把成果写入仓库外层的 `成果文件` 分类目录。Android 重新签名或发布正式版时，不要提交签名文件、密钥或口令。
