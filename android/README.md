# Android 客户端

这是一个横屏 Android WebView 壳。构建脚本会把 `public/`、`data/`、`shared/` 和浏览器战斗模拟代码复制进 APK，运行时仅通过 WebSocket 连接独立服务端。

## 构建

```powershell
.\scripts\install-android-toolchain.ps1
.\scripts\build-android-client.ps1
```

工具链安装在项目的 `.android-toolchain/` 内，不修改系统 PATH。生成物位于：

`成果文件/03-Android客户端/Stronghold-Protocol-Client-v0.2.5-android-debug.apk`

文件名中的版本号会从根目录 `package.json` 自动读取，后续升级版本时无需手工修改打包脚本。

调试 APK 使用 Android 默认调试证书签名，可直接侧载测试。正式发布需要创建并妥善保管自己的发布签名密钥。
