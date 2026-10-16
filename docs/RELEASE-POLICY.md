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

## 0.3.0 Compatibility Release

On 2026-10-16, the user approved Stronghold Protocol 0.3.0 as Enhanced 2.6.3 and its
2.6.* compatibility line. `release-policy.json` records this explicit baseline exception
through `legacyVersionLine`; later upstream baselines continue to follow the normal
`0.M.N -> M.N.R` mapping.

## 元数据

正式增强版发布时同步更新：

- `package.json` 与 `package-lock.json`
- `shared/constants.js`
- `desktop/runtime/package.json`
- Android `versionName` 使用相同的 `M.N.R`；内部 `versionCode` 保持严格递增
- `release-policy.json`
- `CHANGELOG.md` 和显示版本号的说明文件

同一次发布的 Windows 客户端、Android APK、Windows 服务端、增量包、运行时素材包和清单使用同一个展示版本号。`master` 上的上游兼容修复不自行修改上游版本号。

## 运行时素材包（R2）

Android 的素材（`assets/`、`fonts/`、`data/assets.json`、`data/local-assets.json`）通过 Cloudflare R2 增量更新，不以 APK 版本号判断素材是否更新，也不要求玩家重装 APK。Windows 更新器只更新程序本体，任何情况下都不得更新素材。

增强版 `2.6.2` 起，R2 素材桶是发布素材的存储源，客户端先向游戏服务端 /api/assets/token 换取短期 JWT，再通过现有 Cloudflare Worker 网关访问素材；Worker 直接从 Cloudflare R2 拉取并向授权客户端提供素材。游戏服务端只负责会话鉴权和签发 JWT，不直接下载或转发 R2 素材。Worker 作为 R2 前的受保护服务网关时同样属于服务端边界；客户端、APK 和公开配置不得持有 R2 API 密钥。发布前必须验证 Cloudflare Worker 能从 R2 拉取并完整提供目标素材包和索引。

- 发布产出的素材包与 Windows 增量包放在同一个发布目录（`08-客户端增量包/<渠道>/`）：日常发布产出 `assets-delta-<from>-<to>.zip`（文件级新增/变更/删除的压缩增量），首次安装、修复、跨越过多版本或主线发布产出 `assets-base-<version>.zip`（完整基线），并刷新很小的 `assets-index.json`。
- R2 只承载运行时需要的素材包和索引；本地正式发布目录同时保留本体更新产物和对应的素材增量包。每隔数个大版本生成新的完整基线包，旧基线和旧链在确认没有受支持版本需要之后才清理（`node tools/assets-r2.mjs route` 是判断依据）。
- 索引必须最后上传：Cloudflare Worker 从 R2 读取索引后再向客户端提供，索引不得指向尚未上传的包。已发布的包不得原地替换，修复后发布新版本。
- 素材包与索引由维护者用本人凭据手工上传。仓库、脚本、APK、索引和 URL 中不得出现 R2 密钥、账户信息、签名 URL 或令牌；构建时/运行时使用公开配置，未配置时客户端安全降级为只使用 APK 内置素材。
- 下载的素材与素材包不得提交 Git。

## 状态定义

工作树版本、已提交版本、已合并版本、已打包版本、已打标签版本和已发布版本是不同状态。只有最终提交、实际标签、验证通过的产物和个人仓库 GitHub Release 全部对应时，才能称为已发布。

普通功能、修复、同步和适配 PR 不升级正式版本。一轮由用户逐个确认的 PR 全部合并后，自动进入发布流程；多个 PR 可以合并到同一个版本。

## 发布流程

1. 从最新个人 `enhanced-mode` 建立 `release/vM.N.R`，更新全部版本元数据和 CHANGELOG。
2. 临时测试包可以沿用当前版本，但文件名必须标记 `test`、功能名或提交号，且不能覆盖正式包。
3. 运行版本校验和完整测试，创建并自动合并发布 PR。
4. 从最终合并提交使用 `scripts/publish-client-release.ps1`；主线发布增加 `-MainlineUpdate`。素材 R2 已上线时同时传 `-AssetIndexUrl`，让 APK 使用不含凭据的 Worker 索引地址。
5. 验证完整 Windows 客户端、完整 Android APK、Windows 增量包和运行时素材包（基线/增量 ZIP 与 `assets-index.json`，逐包校验 SHA-256 并确认索引指向最新版本、没有版本变成不可达）；服务端变化时还要验证完整 Windows 服务端。
6. 任一测试、构建、清单、校验或升级验证失败时停止，不创建标签或 Release。
7. 只有完整包、主线增量包、清单和校验全部成功后，才允许清理两个主线端点之间的小版本完整客户端包。
8. 维护者用本人凭据把素材包与索引上传到 R2（先包后索引），并核对 Cloudflare Worker 能从私有 R2 拉取，授权客户端能通过网关完整下载。
9. 创建 `enhanced-vM.N.R`，在个人仓库发布标题为 `Stronghold Protocol Enhanced M.N.R` 的 GitHub Release 并上传产物。
10. 已发布产物不得原地替换；修复后发布新版本。

新增强标签使用 `enhanced-vM.N.R`，旧标签保持原名。Android `versionCode` 只用于系统内部升级顺序，不进入标签、产物名或 Release 标题。增强标签、Release 和产物只发布到个人仓库，不发布到上游。标签只能指向已经通过测试且与最终产物源码一致的提交。
