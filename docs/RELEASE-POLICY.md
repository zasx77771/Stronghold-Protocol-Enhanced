# 发布版本规则

`release-policy.json` 是版本规则的机器可读事实源。`npm test`、`npm version` 生命周期和发布脚本都调用同一校验器，禁止在脚本中另写一套映射算法。

## 版本映射

- 上游版本必须使用 `0.M.N`。
- 增强版使用 `M.N.R`，其中 `R` 是同一上游基线内的增强修订号。
- 新上游基线首次发布从 `R = 0` 开始；之后的正式增强更新只递增 `R`。

示例：

| 上游 | 增强版本线 | 首个增强版 |
|---|---|---|
| `0.1.4` | `1.4.*` | `1.4.0` |
| `0.2.0` | `2.0.*` | `2.0.0` |
| `0.2.1` | `2.1.*` | `2.1.0` |

## 历史兼容线

已经发布的 `0.2.*`、`0.3.*` 不追溯改名。上游 `0.1.3` 对应的历史兼容线 `0.3.*` 已在 `0.1.4` 更新时结束；从 `0.1.4 -> 1.4.0` 起直接使用 `0.M.N -> M.N.R`，不创建中间占位版本。

`release-policy.json` 不再保留已到期的 `legacyVersionLine`；后续上游更新继续直接使用通用映射。

## 元数据

正式增强版发布时同步更新：

- `package.json` 与 `package-lock.json`
- `shared/constants.js`
- `desktop/runtime/package.json`
- Android `versionName` 使用相同的 `M.N.R`；内部 `versionCode` 保持严格递增
- `release-policy.json`
- `CHANGELOG.md` 和显示版本号的说明文件

同一次发布的 Windows 客户端、Android APK、Windows 服务端、增量包和清单使用同一个展示版本号。`master` 上的上游兼容修复不自行修改上游版本号。

## 状态定义

工作树版本、已提交版本、已合并版本、已打包版本、已打标签版本和已发布版本是不同状态。只有最终提交、实际标签、验证通过的产物和个人仓库 GitHub Release 全部对应时，才能称为已发布。

普通功能、修复、同步和适配 PR 不升级正式版本。一轮由用户逐个确认的 PR 全部合并后，自动进入发布流程；多个 PR 可以合并到同一个版本。

## 发布流程

1. 从最新个人 `enhanced-mode` 建立 `release/vM.N.R`，更新全部版本元数据和 CHANGELOG。
2. 临时测试包可以沿用当前版本，但文件名必须标记 `test`、功能名或提交号，且不能覆盖正式包。
3. 运行版本校验和完整测试，创建并自动合并发布 PR。
4. 从最终合并提交使用 `scripts/publish-client-release.ps1`；主线发布增加 `-MainlineUpdate`。
5. 验证完整 Windows 客户端、完整 Android APK、Windows 增量包；服务端变化时还要验证完整 Windows 服务端。
6. 任一测试、构建、清单、校验或升级验证失败时停止，不创建标签或 Release。
7. 只有完整包、主线增量包、清单和校验全部成功后，才允许清理两个主线端点之间的小版本完整客户端包。
8. 创建 `enhanced-vM.N.R`，在个人仓库发布标题为 `Stronghold Protocol Enhanced M.N.R` 的 GitHub Release 并上传产物。
9. 已发布产物不得原地替换；修复后发布新版本。

新增强标签使用 `enhanced-vM.N.R`，旧标签保持原名。Android `versionCode` 只用于系统内部升级顺序，不进入标签、产物名或 Release 标题。增强标签、Release 和产物只发布到个人仓库，不发布到上游。标签只能指向已经通过测试且与最终产物源码一致的提交。
