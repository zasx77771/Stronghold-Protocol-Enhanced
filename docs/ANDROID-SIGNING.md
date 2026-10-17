# Android APK 签名与升级规则

本文件记录 Android APK 正式发布的签名要求，以及遇到“签名不一致”时的处理方式。

## 根因

Android 允许同一个 `applicationId` 只有在签名证书一致时覆盖安装。`versionCode` 递增不能绕过签名校验。Gradle 默认的 `debug.keystore` 属于测试密钥；如果 `ANDROID_USER_HOME` 位于不同 worktree、缓存目录或构建机，Gradle 可能自动生成另一把调试密钥。这样 APK 可以正常安装到卸载过旧版的设备，却不能覆盖安装已发布的旧版。

## 正式发布要求

- 正式 APK 必须使用受控且长期稳定的发布 keystore，不得使用 `assembleDebug` 或 Gradle 默认 `debug.keystore`。
- 私钥、keystore 和口令不得提交 Git、放入产物目录或写入公开 Release。仓库和发布记录只保存证书 SHA-256 指纹、别名等非秘密信息。
- 构建脚本必须显式注入签名配置和 keystore 路径，不能依赖 worktree 的默认 `ANDROID_USER_HOME`。同一发布线的所有 APK 必须使用同一发布证书。
- 每次发布前，用 `apksigner verify --verbose --print-certs CURRENT_APK` 检查 APK，并与上一正式 APK 对比：`applicationId`、证书 SHA-256 指纹和递增的 `versionCode` 都必须符合预期。
- 在没有卸载旧版的测试设备上执行覆盖安装。覆盖安装失败是发布阻断项；仅在卸载旧版后安装成功不能证明升级兼容。

## 发现不一致时

1. 停止上传或发布，不删除设备上的旧应用和用户数据。
2. 用 `apksigner` 读取当前 APK 和上一正式 APK 的证书指纹，确认差异；同时检查实际使用的 `ANDROID_USER_HOME`、keystore 路径和构建变体。
3. 找回原发布 keystore 后，从正确密钥重新构建新版本，并重新执行覆盖安装和签名校验。已发布 APK 不原地重签或替换。
4. 如果原密钥确实不可用，不能让新证书继续使用同一个 `applicationId` 冒充升级。应选择新的 `applicationId`，或发布明确要求卸载重装的迁移版本，并在版本说明中说明本地数据迁移影响。
5. 不得仅为隐藏问题而修改包名；包名变化是需要单独评审的迁移。

## 发布记录

发布验证记录至少包含：源码提交、APK 文件 SHA-256、`applicationId`、`versionName`、`versionCode`、签名证书 SHA-256、覆盖安装结果和测试设备。不得包含私钥、keystore 文件或口令。

2026-10-13：2.3.0 与 2.5.0 因不同 worktree 生成不同默认 `debug.keystore` 而出现签名不一致；该事件验证了上述规则的必要性。
