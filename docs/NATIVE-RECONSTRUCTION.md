# 原生客户端增强层重构计划

> 2026-10-18 入口连接体验：登录卡仅显示“服务器地址 / SERVER”输入框和同排的“应用”按钮；不显示连接方式、邀请链接或 `INVITE` 文案。原生端根据输入自动判断：`主机:端口` 或 `tcp://` 走 TCP，`http(s)://` / `ws(s)://` 走 WebSocket；完整邀请链接和房间码仍可直接粘贴并自动加入。标题屏固定横向视口、禁止横向拖动；“应用”与实际输入框齐平，触控目标不小于 44px。

> 2026-10-22 恢复连接方式切换（取代上一条的“按地址自动判断”）：原生外壳在地址框上方重新显示 `WebSocket / TCP` 分段切换，浏览器页面没有 TCP 桥、不显示这一行。切换只改变本机选择，点「应用」后保存并**立即重连**（不刷新页面，见下一条）。TCP 模式的地址接受 `主机:端口`、`tcp://主机:端口` 与 `http://主机:端口` 三种写法（`https://` 因原生套接字没有 TLS 而被拒绝，端口 80 的裸 `http://主机` 也拒绝——那是 HTTP 服务不是帧端点）；WebSocket 模式仍接受 `http(s)://`、`ws(s)://` 与 `主机:端口`。粘贴的邀请链接若自带 `tcp://`，其传输方式覆盖切换按钮当前的选择。

> 2026-10-22 切换不再刷新页面：`native/bridge/stronghold-native-bridge.js` 改为**常驻**门面，按每次连接的 URL 分流——`tcp://主机:端口` 走原生 TCP 通道，`ws://` / `wss://` 直接交给宿主自己的 WebSocket（没有宿主 WebSocket 时退回已保存的端点，只为测试沙箱保留）。因此外壳启动时不再按 `sp.server.transport` 决定是否安装门面，标题屏保存传输方式后用 `connection.parseAddress()` 得到的 `socketUrl` 直接 `net.setUrl()` + 重连。同一提交里，原生外壳的「复制链接」不再可能给出壳自己的来源（`http://sp.localhost`、`https://appassets.androidplatform.net`）：TCP 分享 `tcp://主机:端口/?room=`，WebSocket 分享服务器网页地址 `http://主机:端口/?room=`（`wss://` 映射成 `https://`），还没有服务器地址时不复制并提示先填写——浏览器页面仍分享自己的页面 URL，只有当玩家把客户端指向了别的服务器时才分享那台服务器。


状态：阶段 A 修复中；共享 bridge、Windows/Android 容器骨架与上游兼容检查已写入，尚未进行实际原生打包。
分类：增强功能类。
重构基线：`upstream/master` 的 `6ab2468279e926d107788f63d7fe219b85f67b4a`。

## 目标

以最新上游网页端为唯一游戏与网页功能核心，重新建设 Windows 与 Android 原生客户端增强层。旧 `enhanced-mode` 只用于审计已有能力和测试思路，不能作为代码合并源或新功能分支的基线。

网页端继续保留上游的素材下载、素材包导入、Service Worker、素材哈希与缓存行为。原生能力通过明确的桥接接口和私有存储接入，不替换或复制网页核心。

## 范围

### 1. 原生客户端运行时

- Windows：Tauri 外壳、私有静态资源协议、文件路径隔离、WebView2 与构建配置。
- Android：WebView 外壳、`appassets` 资源处理、生命周期、文件选择和构建配置。
- 原生 TCP 桥：保持网页端统一 bridge 契约；网页浏览器无桥时必须正常降级。

### 2. 原生素材可用性

这是一个功能组；R2、未来国内镜像和本地导入不是三个互相替代的产品。

> 2026-10-18 起，R2 在线素材更新连同索引、token、delta 与镜像一并放弃，素材改为随安装包内嵌（见 2.1）。以下 R2/镜像条目保留为历史设计记录，不再是待实施项。

- ~~保持 R2 在线更新~~（已退役）：Windows 与 Android 都直接读取安装包内素材，不再检查在线索引。
- 本地导入仍显示校验、解压/安装、完成和可操作错误；不再有下载计划或下载字节。
- 增加用户显式触发的离线导入，作为本地覆盖与修复手段；不再存在“在线源失败”这一触发场景。
- 本地导入写入唯一的 `AssetStore`，共用锁、inventory 和原子提交。
- ~~预留受服务端认证的 `mirrors` 配置~~（已随 R2 一并删除，代码中不再有 `mirrors` 字段）。
- 原生离线导入仅接受带清单、`ASSETS.json`、SHA-256 与 inventory 的原生 `assets-base` / delta 包。上游网页用的 `Stronghold-Protocol-v0.3.0-assets.zip` 仍只用于网页导入，不能直接解压进原生存储。

### 2.1 素材随包内嵌（0.3.1 起取代在线素材更新）

上游 0.3.0 的在线素材更新（R2、索引、token、delta、镜像）不再随增强客户端发布：Windows 完整客户端与 Android APK 直接携带 `data/assets.json` 列出的官方素材，离线可用。原生 `AssetStore` 与导入仍是本地存储层，但不再有远程下载路径。

- 素材仍由 `npm run assets` 生成到 `public/assets`（git 忽略），构建时整体进入安装包或 APK。
- 发布构建必须通过 `npm run assets:check`（即 `--strict`）：清单里每个 `/assets/…`、`/fonts/…` 都要在 `public/assets` 下真实存在，且 `stats.files` 与清单的 `/assets/` 条目数一致（防止清单过期掩盖缺文件）。Windows 由 `src-tauri/build.rs` 在 release 构建中自动执行同一脚本并带 `--strict`；Android 由 `checkEmbeddedAssets` Gradle 任务在 `syncNativeWeb` 前执行同样的存在性与计数校验。缺失即构建失败，避免发出图片 404 的安装包。
- 仅本地调试允许 `SP_SKIP_EMBED_CHECK=1` 跳过；正式产物不得使用该开关。
- 打包不引入任何在线素材源、凭证或下载路径，客户端启动即可离线进入对局。

### 3. 发布与更新工具链

- 本地原生包（`assets-base` / delta）的校验与导入检查；不再有在线索引、签名索引或 pins。
- Windows 完整客户端、Android APK、Windows 增量包和必要的 Windows 服务端包。
- Windows 服务端包用 `scripts/make-server-lite.mjs` 打（`npm run package:server:lite`）：不含素材文件，但保留
  `data/assets.json` 素材清单，客户端仍可请求清单与对局服务；玩家便携包（`scripts/make-windows-bundle.mjs`）不用于服务端部署。
- 发布产物只写入 `enhanced-client-servers`；素材、缓存、密钥、账户数据和录像不进 Git。

### 4. 后续增强功能重构

后续增强不是本轮结束后才临时决定的尾项：从本计划确认时即开始盘点，在原生基础平台稳定后逐项实施。本机 profile/预设只是第一批候选之一；账户/tag、对局记录和回放已被有意移除，不重新引入。

每一项候选增强必须先写入取舍表，并完成以下判断后才可以建独立实现分支：

| 字段 | 必填内容 |
| --- | --- |
| 功能与用户价值 | 要保留的可观察行为及使用场景。 |
| 上游状态 | 上游已有、部分已有或完全没有；已有时必须复用上游。 |
| 平台范围 | 网页、Windows、Android，以及无能力时的降级行为。 |
| 数据与协议 | 持久数据、网络协议、迁移与旧数据兼容风险。 |
| 最小改动边界 | 允许修改的上游文件、原生文件和新增接口。 |
| 验收与回退 | 回归测试、实际平台验证、失败时如何保持旧行为。 |
| 结论 | 迁入、延后或明确不迁入，并记录用户确认。 |

## 不做的事

- 不从旧 `enhanced-mode` 整批合并 184 个变更文件。
- 不重写上游已有的网页素材下载、网页素材包导入或 Service Worker。
- 不把未知第三方 URL、P2P、HTTP 或客户端猜测的镜像加入原生下载。
- 不将素材导入实现为未校验的 ZIP 解压。

## 架构边界

| 层 | 权威与职责 |
| --- | --- |
| 上游网页 | 游戏规则、UI、网页素材清单、网页下载/导入与缓存。 |
| 原生 bridge | 只暴露平台能力；不得向页面泄露素材网关令牌或本地路径。 |
| 原生 AssetStore | 唯一的原生素材安装位置，负责校验、解压、原子提交、回退。 |
| 随包素材 | 平台安装包直接携带 `data/assets.json` 列出的官方素材，是默认读取来源。 |
| 本地交付 | 用户选择的已钉扎原生包；校验完成后使用同一 AssetStore 提交，覆盖随包素材。 |

## 实施阶段与验收门槛

### 阶段 A：上游基线与桥接骨架

从本重构基线新建 Windows 与 Android 原生壳、TCP bridge、最小静态资源处理与跨平台降级测试。验收：浏览器、Windows、Android 共享网页模块不回归；原生 TCP 可连接且令牌不暴露给页面。

### 阶段 B：原生 AssetStore 与随包素材

保留经过审计的 `AssetStore`（SHA-256/inventory 验证、解压与原子安装）作为本地覆盖层；运行时的默认素材来源改为安装包内嵌的 `public` 素材，不再有远程索引、下载或自动检查。验收：随包素材离线可用；本地导入、校验失败、旧素材保留与原子回退在两端可见。

### 阶段 C：本地导入

增加 Windows/Android 文件选择、受钉扎原生包验证、单写锁与 UI 状态；不再有镜像或在线互斥语义。验收：坏包不能改变当前素材；导入后仍可回退到随包素材；导入与读取互斥。

### 阶段 D：发布与实际平台验证

实现素材包、客户端包、增量包和发布检查。验收：实际 Windows 客户端、Android APK 与 Windows 服务端包能够分别安装、更新、离线导入和回退；完整测试结果单独记录。

### 阶段 E：后续增强功能逐项重构

从取舍表中选择已确认的功能，每项单独建立分支和 PR，按“上游状态、平台范围、数据/协议、最小边界、验收/回退”实施。首批候选是本机 profile/预设；后续候选必须先完成同样的取舍，不得夹带账户、tag、记录或回放。

### 阶段 F：集成、发布与持续盘点

在已确认的增强 PR 全部独立验证并经用户确认合并后，执行跨平台回归、实际产物验证和正式发布。未进入本轮的候选功能保留在取舍表中，进入下一轮时重新核对最新上游，而不是从旧增强代码直接搬运。

## PR 边界

每个阶段以独立增强 PR 提交到个人 `enhanced-mode`，每次合并都需要用户确认：

1. 原生运行时与 TCP bridge。
2. 随包素材、AssetStore 与本地导入。
3. 本地导入状态与原生验证。
4. 打包、更新器、发布工具和平台级测试。
5. 后续增强功能：每项独立 PR；本机 profile/预设仅是首个候选。
6. 集成验证与发布适配（只纳入已获确认的增强 PR）。

实施前必须再次 fetch `origin` 与 `upstream`，核对基线、分支、工作树和 ahead/behind。若上游已具备相同能力，优先保留上游实现，只保留必要的最小增强差异。

## 当前决定

- 2026-10-18 起放弃 R2 在线素材更新：索引、token、bucket、delta、镜像与在线下载路径全部移除。
- Windows 与 Android 的完整安装包直接携带 `data/assets.json` 列出的官方素材，运行时离线读取。
- 本地导入是用户显式操作，用于覆盖/修复随包素材；不是在线失败的自动回退。
- 本地导入必须产出可解释的校验、解压/安装进度与错误。


## 本次重构的优先规则

旧规则、流程和默认选择仅作为历史参考，不再具有约束力。本次重构中形成并经确认的新规则、实际发现的问题及其处置记录，连同本次对话中用户的最新要求，才是执行依据；如彼此冲突，以最新确认的重构结论为准。

1. 以最新 `upstream/master` 为唯一游戏与网页端主线；不得从旧 `enhanced-mode` 整体合并或继续在其代码上修补。
2. 旧增强版只可按文件、行为和测试逐项作为参考。每项迁入都必须说明最小边界，并保持上游网页功能与游戏规则不变。
3. 重构目标是让网页核心原生支持 Windows 与 Android。原生能力经明确 bridge 接入，不能将平台私有路径、下载细节或 TCP 实现泄漏到网页核心。
4. 上游网页端素材下载、素材包导入及 Service Worker 缓存保持上游逻辑；原生端有独立的 AssetStore 与独立入口，二者不互相替换。
5. 素材随安装包内嵌，运行时只读本地文件；不再实现在线索引、token、下载或自动检查。
6. Windows 与 Android 都提供用户主动选择的原生素材包导入；只接受带 `ASSETS.json`、SHA-256 与 inventory 的原生 `assets-base` / delta。它是随包素材的覆盖层，网页用素材 ZIP 不得直接导入原生 AssetStore。
7. 不再保留 `mirrors` 配置；镜像、R2 与在线更新全部随第 5 条一起退役。
8. 后续增强功能在主线原生层完成且稳定后，按取舍清单逐项重构、独立验证；不恢复账户、tag、记录和回放等已明确移除的功能。
9. 本阶段不将历史发布、分支命名或旧版流程作为阻塞条件；当前工作树只承载可审计的源码、测试和本重构文档，不生成正式发布物。

## 后续增强取舍清单

此清单以 `upstream/master` 对 `origin/enhanced-mode` 的实际差异为盘点来源，不是把旧差异批量迁回。状态“选入主线”属于本次先完成的原生层；“后续候选”只在主线稳定后再建立独立实现；“不迁入”则明确保持上游或移除。

| 历史能力或差异 | 结论 | 时序与最小边界 | 原因与验收 |
| --- | --- | --- | --- |
| Windows Tauri 壳、静态资源协议、网页 bridge、原生 TCP | 选入主线 | 阶段 A；仅 `src-tauri/` 和共享 bridge/连接入口 | 使网页核心可作为 Windows 客户端运行；网页浏览器路径与 WebSocket 不回归。 |
| Android WebView、`appassets` 路由、网页 bridge、原生 TCP | 选入主线 | 阶段 A；仅 `android/` 和共享 bridge/连接入口 | 使同一网页核心可在 Android 运行；不改网页业务或规则。 |
| 服务地址输入与原生 TCP 连接流程 | 选入主线 | 阶段 A；作为 bridge 契约的一部分 | 客户端必须能连接用户指定服务端；浏览器仍保留上游连接方式。 |
| 原生 AssetStore 与本地包校验 | 选入主线 | 阶段 B；平台私有存储 | 保留原子提交与回退；不保留 R2 索引、下载或服务端令牌接口。 |
| ~~R2 下载/校验/解压安装进度~~ | 不迁入（已退役） | 随 R2 一起删除 | 素材随包内嵌后没有下载阶段；只剩本地导入的校验/解压/安装进度。 |
| 原生素材包本地导入 | 选入主线 | 阶段 C；文件选择器 + 相同 AssetStore 提交 | 仅用户触发、仅受签名清单约束的原生包；是随包素材的覆盖层。 |
| 国内镜像 | 不迁入（已退役） | 随 R2 一起删除 | 代码中不再有 `mirrors` 字段或校验入口。 |
| Windows/Android 构建、服务端包和更新器 | 选入主线 | 阶段 D；仅重建当前主线所需工具链 | 验证可构建与安装，不以历史产物或版本规则为前置条件。 |
| 本机 profile/预设 | 部分选入（仅 C1） | 阶段 E；独立本地数据格式 `sp.pref.lineups`，只复用上游调配语义 | 用户确认只做“本机多份命名配队”。代号由上游 `identity` 持久化，旧 `sp.pref.profile` 信封不迁入；remember-name 开关与 bundle 导出/导入未选入；账户/tag/战绩/回放不迁入。 |
| 旧桌面 runtime（非 Tauri） | 不迁入 | 不建立兼容层 | 已被 Tauri 路径替代，双运行时只会扩大维护面。 |
| 为旧客户端所作的网页布局、渲染、战斗或数据改动 | 不批量迁入 | 仅当上游当前 UI 在原生容器实测失败时，单点修复 | 主线网页实现优先，避免把历史游戏差异重新带入。 |
| 账户、四位 tag、对局记录、回放 | 不迁入 | 不创建数据、协议或 UI 兼容代码 | 已由用户明确移除。 |



## 上游快速更新规则

主线升级不再通过把旧增强版与新上游做大范围合并实现。原生层必须保持为可独立复用的薄适配层：上游网页目录不承载 Windows 或 Android 实现，平台启动时在 `index.html` 交付前注入 bridge，网页在浏览器中不加载也不依赖该 bridge。

| 约束 | 重构决策 | 上游更新时的效果 |
| --- | --- | --- |
| 网页源代码 | 不为原生端长期分叉 `public/`、游戏规则、网页素材流程或 Service Worker | 更新时优先快进/合并上游网页，而不是处理历史平台补丁。 |
| 注入点 | Windows `sp://` 协议与 Android `WebViewAssetLoader` 都只在返回入口 HTML 时插入同一份 bridge | 只校验稳定的 `</head>` 注入锚点；锚点变化会被兼容测试立即发现。 |
| 连接兼容 | bridge 在原生容器中提供 WebSocket 兼容外观并转交 TCP，浏览器继续使用上游 WebSocket | 避免修改 `net.js`、`main.js` 和标题页来维持原生连接。 |
| 原生素材 | AssetStore 覆盖原生请求路径，网页素材下载/导入/缓存仍完整运行原逻辑 | 上游调整网页素材流程时不会与原生更新逻辑争夺所有权。 |
| 版本与构建 | 平台工程、bridge 和兼容测试固定在独立目录；构建脚本从当前 checkout 打包网页资源 | 上游更新后无需复制整棵旧客户端或手工重放历史发布流程。 |
| 自动核验 | 每次上游更新执行入口注入、bridge 契约、浏览器回退、Windows/Android 静态路径和 TCP 帧兼容检查 | 将“更新耗时长”的人工排查改为可定位的少数失败项。 |

完成主线重构后，一次上游更新的标准路径是：更新 `upstream/master` → 运行原生兼容检查 → 仅在检查指出的注入锚点、浏览器 API 或协议契约变化时调整薄适配层 → 运行两个原生容器验证。不得再把旧 `enhanced-mode` 当作上游升级输入。

## 重构决策与问题记录

| 编号 | 类型 | 结论或问题 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| R-001 | 架构 | 不修改 `public/`、`net.js`、`main.js`、标题页来支持原生 TCP。 | 两端仅在返回 `index.html` 时注入同一经典 bridge；它只在检测到原生宿主后替换 `WebSocket` 外观。 | 已实施，受 `native:check` 保护。 |
| R-002 | 架构 | 上游更新必须能快速定位原生兼容断点。 | 新增 `npm run native:check` 与 Node 契约测试，验证入口锚点、零网页分叉、同一 bridge、两端资源暂存。 | 已实施。 |
| R-003 | 体验 | 原生运行没有已配置 TCP 地址时不能依赖上游网页地址，也不能替玩家猜一个。 | 地址只在标题页的「服务器地址」填写并写入本机存储（`sp.server.address` 与 `sp.native.tcp`）；bridge 不另弹设置面板，也**没有任何内置默认地址**：没存过地址时不发起 TCP 连接，标题页状态改为「请先填写服务器地址」。浏览器不写这两个键。 | 已实施（2026-10-19 改：先删掉首次启动的本机地址设置面板，再删掉 `127.0.0.1:3001` 兜底，按用户要求以填写内容为准）。 |
| R-004 | 契约 | 安卓壳与 Tauri 壳向 bridge 推送 TCP 事件的方式不同。 | 安卓壳用一次性的 `evaluateJavascript` 调用 `__strongholdNativeTcpEvent(<对象>)`；Tauri 壳带 `id` 与 `payload` 两个参数。bridge 同时接受两种形状，否则安卓端所有事件（含 `open`）都会被丢掉，连接停在「正在连接服务器」直到服务端 `hello timeout`。 | 已实施（2026-10-19 修 Android 卡在连接中），受 `test/native/bridge-contract.test.js` 保护。 |
| R-005 | 体验 | 原生客户端左下角曾有常驻「素材」浮动按钮。 | 素材自 0.3.1 起随包内嵌，标题页已有「下载完整素材 / 导入素材包」，浮动按钮遮挡战场且无入口价值，已移除；原生素材状态通道（`__strongholdAssetUpdate`）保留给导入流程。 | 已实施（2026-10-19）。 |
| R-006 | 性能 | 安卓客户端显示约 160 ms 延迟，而同一网络下 PC 客户端 45–50 ms、手机裸 ping 服务端 min 60 / avg 72 / max 80 ms。 | 根因在壳内而非网络：每条入站帧都走 `runOnUiThread(webView.evaluateJavascript(...))`，手机上一次投递约 50 ms（2–3 个渲染帧），一次 ping 往返叠两次。改为页面调用 `StrongholdAndroidTcp.channelReady()` 换取 WebMessagePort，帧经 `postWebMessage` 直达页面 JS 线程，`evaluateJavascript` 只作旧壳回退。顺带 `setTcpNoDelay(true)`，长度头与正文合成一次 `write`。 | 已实施（2026-10-20），受 `test/native/bridge-channel.test.js` 保护；2026-10-21 用户真机验证 3.2.3 延迟恢复正常，不再只是预期。 |
| R-007 | 平台限制 | 安卓客户端为什么只能走 TCP，不能像浏览器那样连 `ws://host:3000`。 | 页面来源是 `https://appassets.androidplatform.net`（`MainActivity.java`），WebView 未设 `setMixedContentMode`（默认 `NEVER_ALLOW`），`AndroidManifest.xml` 是 `usesCleartextTraffic="false"`，而服务端 3000 只提供明文 HTTP/WS。因此安卓端只能用原生 TCP 帧端点；要改用 3000 端口必须改壳放行 mixed content/cleartext，或服务端上 `wss`。 | 已实施为「TCP-only」口径（2026-10-19 确认地址以填写内容为准）；2026-10-22 起 TCP 模式接受 `http://主机:端口` 写法（不再把 `http://` 归一成 `ws://`），但 `https://` 仍因无 TLS 拒绝。受 `test/native/bridge-contract.test.js` 与 `test/connection.test.js` 保护。 |
| R-008 | 体验 | 玩家手里常是 `http://域名:3001` 这样的网页地址，原生端又提供 WebSocket/TCP 切换，解析规则必须两种模式一致可预期。 | 传输方式由切换按钮决定（浏览器固定 WebSocket）；TCP 模式：`主机:端口` / `tcp://` / `http://主机:端口`，`https://` → `tls_unsupported`，`ws(s)://` → `invalid_scheme`，缺端口 → `invalid_endpoint`（端口 80 是 HTTP 服务，不是帧端点）；WebSocket 模式：空白回退当前页面、`http(s)://` 映射到 `ws(s)://`、无路径补 `/ws`。保存时 TCP 地址统一规范化为 `主机:端口` 写入 `sp.server.address` 与 `sp.native.tcp`，`http://` 前缀不落库，旧值兼容。两种模式都返回 `socketUrl`（TCP 为 `tcp://主机:端口`），原生门面据此在运行期选择传输方式。 | 已实施（2026-10-22），受 `test/connection.test.js` 保护。 |
| R-009 | 体验 | 切换 WebSocket/TCP 需要刷新整个原生窗口，且壳里的「复制链接」给出 `http://sp.localhost/?room=…` 这种别人打不开的地址。 | 旧桥在页面加载时按 `sp.server.transport` 决定是否安装 TCP 门面，改成 WebSocket 就只能 reload 让桥重新判断；邀请链接只在 TCP 模式换成端点，WebSocket 模式退回 `location.origin`，而 Tauri 页面来源是 `sp://localhost`（序列化为 `http://sp.localhost`）、安卓是 `https://appassets.androidplatform.net`。现在桥常驻并按 URL 分流（`tcp://` → 原生 TCP；`ws(s)://` → 宿主 WebSocket），切换后直接重连；邀请链接在原生外壳里只分享服务器地址（TCP `tcp://`、WebSocket `http(s)://`），没有地址时提示先在标题界面填写，绝不分享壳来源。 | 已实施（2026-10-22），受 `test/connection.test.js`、`test/native/bridge-channel.test.js` 与 `test/native/bridge-endpoint.test.js` 保护。 |
| I-001 | 环境 | 当前工作机没有 `cargo`、Java 或 Android Gradle 环境。 | 已运行静态兼容检查和 Node 契约测试；Windows 编译、Android APK 构建与实机 TCP 联调均标记为未运行，待具备工具链后执行。 | 未解决，不阻塞源码继续重构。 |
| I-002 | 素材 | 原生 AssetStore、R2 校验与进度已接入两端；离线导入、镜像和正式打包仍属后续阶段。 | 阶段 B 已实施：同一 `sp-assets-*` 数据模型、原子提交、token 端点、进度状态与原生面板；Rust/Java 未编译验证。 | 已实施，待工具链验证。 |

## 阶段执行分工（2026-10-17 确认）

- 阶段 A 的主线边界、兼容检查、复核和修复由 Codex 负责。
- 阶段 B 及之后（原生 AssetStore 与 R2、进度、离线导入、镜像接口、打包及后续增强）的实际重构由 DeepSeek 在同一重构 worktree 中执行。
- Codex 不替代 DeepSeek 实现阶段 B 及之后的功能；职责是检查差异、运行可用验证、报告证据并修复发现的问题。
- DeepSeek 如提出需要用户确认、授权或取舍的事项，Codex 必须保留原文转发，在用户答复前不代替决定。

## 阶段 B 实施记录（2026-10-17）

> **历史记录（已被 2.1 取代）**：以下“阶段 B/C 实施记录”描述的是 2026-10-17 的 R2 在线素材方案。2026-10-18 起该方案整体退役，文中 `assetToken.js`、`/api/assets/token`、`asset-config.json`、`AssetConfig`/`AssetIndex`/`AssetUpdater`/`AssetUpdateSession`、`mirrors`、`tools/assetPackages.mjs` 及相关测试均已从代码删除，仅作设计沿革保留。当前实现是：素材随安装包内嵌，`AssetStore` 只服务本地导入。

原生 AssetStore 与 R2 在线更新已接入，网页素材下载/导入/Service Worker 未改动。

| 位置 | 内容 |
| --- | --- |
| `server/http/assetToken.js` | 会话 token → 600 秒 HS256 JWT（`aud=stronghold-assets`、`scope=assets:read`、`prefix=runtime-assets/`）；未配置密钥 503，无会话 401。 |
| `server/http/routes.js` | `GET /api/assets/token`，`Cache-Control: no-store`；其余静态路由不变。 |
| `server/index.js` | 由 `SP_ASSET_TOKEN_SECRET` 创建 issuer；Codex 的 TCP 逻辑原样保留。 |
| `src-tauri/src/assets.rs` | 包索引、增量/base 路由、SHA-256/inventory、staging → 层目录 → 原子指针；新增进度回调与 `status()`。 |
| `src-tauri/src/commands.rs` | `sp_set_asset_session_token` 校验 32 位小写 hex 后自动更新，事件名 `sp-asset-event`；新增 `sp_asset_status`。 |
| `src-tauri/src/protocol.rs` | 私有 AssetStore 优先于打包文件；`index.html`、`sw.js` 用 `no-store`，其余 `no-cache`。 |
| `android/.../assets/` | 与 Windows 相同的 `sp-assets-store-v1` / `sp-assets-package-v1` 模型、原子提交与 inventory 校验。 |
| `android/.../MainActivity.java` | `StrongholdAndroidAssets`（available/status/prepare/start/retry/cancel），`__strongholdAssetUpdate` 推送状态；素材请求先 store 后 APK。 |
| `native/bridge/stronghold-native-bridge.js` | 从 `welcome.token` 读取会话 token；Windows 监听 `sp-asset-event`，Android 左下“素材”按钮；展示计划、字节、阶段与进度条。 |

运行时配置不进入网页源码：

- Windows：优先读取客户端根（打包资源目录或 exe 旁的 `client/`）的 `asset-config.json`；缺失或无效时回退到私有存储目录 `%APPDATA%\<identifier>\asset-runtime\asset-config.json`，无需重新打包即可配置。格式 `sp-assets-config-v1`，字段 `enabled/indexUrl/tokenUrl/maxChain/allowHttp`；都缺失时状态为 blocked 并显示原因。
- Android：Gradle 属性 `SP_ASSET_INDEX_URL`（必填）与 `SP_ASSET_TOKEN_URL`（可选）在 `syncNativeWeb` 之后生成 `asset-config.json`；未设置时不生成，运行时显示未配置。
- 服务端：`SP_ASSET_TOKEN_SECRET` 至少 32 字节；未设置时 token 端点返回 503，原生更新不启动。

进度事件统一为：`checking` → `ready`（含 plan）→ 每个包 `downloading`（done/total/bytes）→ `verifying` → `applying` → `complete`，失败为 `failed` 并保留当前已安装版本。

## 阶段 C 实施记录（2026-10-17）

原生素材离线导入与镜像配置预留已接入，R2 在线路径、网页下载/导入/Service Worker 均未改动。

| 位置 | 内容 |
| --- | --- |
| `src-tauri/src/commands.rs` | `sp_import_asset_package` 只接受原生文件选择器结果，参数仅 `AppHandle`，网页不能传入路径；选择后在后台线程计算整包 SHA-256 并调用 `AssetStore::import_package`。 |
| `src-tauri/src/assets.rs` | `AssetStore::import_package` 复用既有 `apply_package`（整包 SHA-256 → `ASSETS.json` → inventory → staging → 原子指针）；新增 `Mirror`/`MAX_MIRRORS=4`/`check_mirrors`，镜像只解析、只展示，不参与下载。 |
| `src-tauri/src/lib.rs` / `Cargo.toml` / `capabilities/default.json` | 注册 `tauri-plugin-dialog`，仅开放 `dialog:allow-open`。 |
| `android/.../MainActivity.java` | `StrongholdAndroidAssets.importPackage()` 打开 `ACTION_OPEN_DOCUMENT`；选中 URI 在应用缓存流式复制并同步计算 SHA-256，随后 `AssetStore.apply`；页面拿不到路径或 URI。 |
| `android/.../AssetConfig.java` | 解析可选 `mirrors` 数组（≤4，https 或显式 `allowHttp`，无凭据/query/fragment），坏条目只记 `mirrorProblems`，不使配置失效。 |
| `android/.../AssetUpdateSession.java` | 状态新增 `mirrors`、`mirrorProblems`、`importAvailable`，供页面只读展示。 |
| `native/bridge/stronghold-native-bridge.js` | 仅原生宿主显示“素材”入口；面板新增“导入素材包…”、镜像说明与导入后“重新加载”。普通浏览器不创建按钮、不暴露选择器。 |

离线导入的信任链与边界：

- 仅接受本项目原生包格式：ZIP 根含 `ASSETS.json`，`format=sp-assets-package-v1`，带 `kind/version/count/bytes/inventory/files`；delta 另含 `from/fromInventory/removed`。网页 `--assets` 包、任意素材目录和网页 ZIP 导入格式都不被接受。
- 校验顺序：整包 SHA-256 → ZIP 结构/路径安全（拒绝绝对路径、`..`、盘符、控制字符、非 ASCII、尾随空格）→ 清单成员与大小 → 逐文件 SHA-256 → 合并本地 inventory（delta）→ 计算目标 inventory digest → `staging` 解压 → 层目录 rename → 原子替换 `asset-store.json`。
- 导入失败保留原有 store 与当前版本；临时包在 `finally` 删除。导入与在线传输互斥：Android 先 `AssetUpdateSession.cancel()`，Windows 由 `AssetStore` 串行写入口保证一次只提交一层。
- 导入是用户显式动作，永不自动触发；导入成功后不自动启动在线更新，由用户点击“重新加载”使用新素材。

镜像配置（预留，不启用）：

- 数据结构：`asset-config.json` 的可选 `mirrors: [{name,url}]`；Rust 与 Java 使用同一规则解析，`status()` 返回 `mirrors`/`mirrorProblems` 供面板显示。
- 默认来源仍是 `indexUrl`/`tokenUrl`（R2）；代码不内置任何国内镜像 URL，不因镜像为空或无效改变默认下载地址，也不自动回退。
- 镜像目前只是配置与展示入口；将来接入时仍要求短期资产 token、受控来源与同一 SHA-256/inventory 校验，不能成为第二套清单或第二种包格式。

未验证项：本工作机未执行 `cargo check`/`gradlew`/`npm test`（由 Codex 复核）；Rust 命令签名、Android 编译与真机文件选择器均需实际构建确认。新增静态契约测试 `test/native/asset-import.test.js`，并扩展 `npm run native:check`。

## 阶段 D 历史记录：原生素材包生成器（2026-10-17，已删除）

> **历史记录（已被 2.1 取代）**：`tools/assetPackages.mjs`、`assets-index.json`、`assets-base`/delta 包与 `npm run assets:package` 已随 R2 在线更新一起删除。下面只保留设计沿革；本地导入仍接受同格式的 `ASSETS.json` 包，由 `AssetStore` 校验，但仓库不再提供生成器。

新增 `tools/assetPackages.mjs`，作为 Windows Tauri 与 Android WebView 共用的原生 AssetStore 包生成器。它只负责把已经整理好的运行素材树打成原生格式，**不是**正式发布流程，也不上传 R2、不生成正式产物、不写版本号。

与网页 `tools/package.mjs --assets` 的区别：

| | 网页 `--assets` 包 | 原生 `tools/assetPackages.mjs` |
| --- | --- | --- |
| 消费者 | 浏览器标题页“导入素材包” | 原生 `AssetStore.apply`（Rust/Java） |
| 根布局 | `public/assets/`、`public/fonts/`、README | ZIP 根直接是 `assets/`、`fonts/`、`data/*.json` |
| 清单 | 无（按服务端 `~hash` 清单校验） | 必须有 `ASSETS.json`，格式 `sp-assets-package-v1` |
| 校验 | 逐文件前 16 位 SHA-256 + Spine 模型哈希 | 整包 SHA-256 + 逐文件 SHA-256 + inventory digest |
| 版本 | 无 | `version` / `from` / `fromInventory`，base 另带 `STATE.json` |

命令接口（默认输出 `.native-assets/packages/`，已加入 `.gitignore`）：

```bash
# base：完整素材树 → assets-base-<version>.zip + assets-index.json
node tools/assetPackages.mjs --source public --version 0.3.0

# delta：旧快照 → assets-delta-<from>-<to>.zip
node tools/assetPackages.mjs --source public --previous .native-assets/source-0.3.0 \
  --from 0.3.0 --version 0.3.1

# 校验已有包/索引
node tools/assetPackages.mjs --verify .native-assets/packages/assets-base-0.3.0.zip
node tools/assetPackages.mjs --verify-index .native-assets/packages/assets-index.json
```

- 输入：`--source` 指向含 `assets/`、`fonts/`、`data/assets.json` 的素材树；`data/local-assets.json` 可选。只收集这四类运行素材，`server/`、`public/` 网页代码等不会进包。`data/assets.json` 必须是原生运行用的普通清单，不做 `~hash` 重写。
- 清单：`ASSETS.json` 含 `format/kind/version/count/bytes/shipped/inventory/files`；base 的 `count == files.count`，delta 的 `count/bytes` 描述合并后的目标 inventory，`shipped` 描述本包实际携带的文件；delta 另含 `from`、`fromInventory`、`removed[{path,size,sha256}]`。base 另写 `STATE.json`（`sp-assets-state-v1`），其 inventory digest 必须与清单一致。
- 索引：`assets-index.json`（`sp-assets-index-v1`）的 base 条目同时写 `version` 与 `to`，满足 Rust 与 Java 两套解析器；同名版本重建时替换旧条目，不产生重复包；`latest` 默认按版本比较前进，也可用 `--latest` 强制。
- 安全：拒绝符号链接、非 ASCII/控制字符/尾随空格路径、`..`、盘符、绝对路径与 junk 文件；路径必须属于 `assets/**`、`fonts/**`、`data/assets.json`、`data/local-assets.json`。显式拒绝输出到 `enhanced-client-servers`，输出目录也不能位于素材源内部。
- 确定性：ZIP 条目排序、固定 1980-01-01 时间戳、无 extra field/data descriptor；JSON 两空格缩进；同一输入与 Node/zlib 版本产生逐字节一致的结果。
- 测试：`test/native/asset-packages.test.js`（base/delta/index、`removed`、确定性、清单篡改拒绝、不安全路径、输出目录边界），`npm run assets:package:check`。

未验证项：`cargo check`/`gradlew` 与真实素材树（仓库不含 `public/assets/`）未在本机运行，由 Codex 用实际发布树复核包能被 Rust/Java `AssetStore` 接受。


### 阶段 D 复核记录（2026-10-17）

本轮只复核原生薄层与测试，不改网页业务逻辑，不恢复客户端安装包/发布编排，不生成正式产物，不上传 R2。

- **隐私契约**：`AssetStore::status()` 不再返回 `storeRoot`；`sp_client_info` 不再返回 `assetRoot`；`sp_asset_status` 的离线 fallback 不再返回 `storeRoot`；Rust 导入 `importing` 事件不再携带所选文件名，选路失败只返回通用错误。Android 的 `describe(Throwable)` 统一脱敏应用私有目录、盘符路径、`/data/`、`/storage/`、`/sdcard/`、`/mnt/`、`file://` 与 `content://` URI，导入忙时返回明确提示而不是静默丢弃。
- **生成器边界**：ZIP 条目数上限 60,000（防止 EOCD u16 静默截断），单文件 512 MiB、成品 ZIP 上限 2 GiB；`--verify` 的 deflate 分支按声明大小设置 `maxOutputLength`，拒绝解压炸弹；Java 导入按块流式解压并同时执行声明大小、单文件上限与总预算，不再把整个条目读入内存；拒绝 `~<16hex>` 服务端哈希视图路径；拒绝同一路径同时出现在 `files` 与 `removed`（Rust `apply_package` 与 Java `AssetPackage.check` 也在运行时拒绝）；索引按包身份替换，允许同一目标版本同时存在 base 与 delta，也保留多个来源的 delta；输出目录拒绝 `enhanced-client-servers`、旧 `成果文件` 和仓库根目录。
- **契约核对**：生成器 base 条目同时写 `version` 与 `to`，分别满足 Java `AssetIndex` 与 Rust `check_index`；base 的 `STATE.json` 与 Java `AssetStore.apply` 的 digest 校验一致；Rust/Java 的 R2 认证、下载、进度与原子安装路径未改动。
- **回归**：`node test/native/asset-packages.test.js` 11 pass；`node test/native/privacy-contract.test.js` 4 pass；全部 native 测试文件 36 pass；`node tools/check-native-compat.mjs` 通过；`public/` 与 `tools/package.mjs` 无 diff。
- **仍未验证**：`cargo check`、`gradlew`、真实素材树打包与 Rust/Java `AssetStore` 实机安装，由 Codex 在最终构建阶段执行。

## 阶段 E 实施记录：本机多份命名配队（C1，2026-10-17）

阶段 E 的第一个候选已实施：在干员调配界面增加**本机多份命名配队**（保存当前配队 / 读取覆盖当前配队 / 删除一份 / 清空全部，最多 20 份）。其余候选按阶段 E 的取舍结论不并入本轮：代号由上游 `identity` 持久化，不需要 `sp.pref.profile` 信封；remember-name 开关、bundle 导出/导入、账户/tag/战绩/回放都不涉及。旧增强源码只作行为参考，未复制其 `profileModel.js` 或整段 UI。

### 数据模型

| | 内容 |
| --- | --- |
| 键 | `localStorage.sp.pref.lineups`（`ui/lineupModel.js` 的 `LINEUPS_PREF`，经 `store.js` 的 `loadPref`/`savePref` 读写，与其它 `sp.pref.*` 同一前缀） |
| 结构 | `{ v: 1, items: [{ id, name, at, entries, ops }] }`；`v` 不等于 1 的整份数据读作空列表，不猜测旧结构 |
| 上限 | `LINEUPS_MAX = 20` 份，超出时丢最旧的一份；`LINEUP_NAME_MAX_LEN = 24` 字符 |
| 载荷 | `entries` / `ops` **就是** `ui/loadoutModel.js` 的 `toStored` 语义（`parseStored` / `parseStoredOps` 读回），没有第二套调配格式 |
| 不碰的东西 | `sp.name`（代号）、`sp.pref.loadout`（当前调配）、账户、对局记录、回放、任何服务端字段或消息 |
| 旧数据 | 旧增强版的 `sp.pref.profile` **不读取、不迁移**；其中唯一独立的信息是配队列表，而代号上游已有，双份真相不应重建 |

### 代码边界

| 文件 | 改动 |
| --- | --- |
| `public/js/ui/lineupModel.js` | 新增，197 行：`LINEUPS_PREF`/`LINEUPS_VERSION`/`LINEUPS_MAX`/`LINEUP_NAME_MAX_LEN`、`cleanLineupName`、`newLineupId`、`emptyLineups`、`sanitizeLineups`、`loadLineups`、`saveLineups`、`saveLineup`、`removeLineup`、`clearLineups`、`lineupOf`、`lineupPayload`、`lineupSize`。名称清洗去掉控制/双向/零宽字符与 BOM，控制与行分隔符读作一个空格；写入失败（隐私模式、配额满）只保留会话副本，不抛异常。 |
| `public/js/screens/loadout.js` | 干员调配标题栏加“本地配队”按钮（`data-testid="loadout-presets"`，icon `book`）与一个 Modal。读取走**与导入完全相同**的路径：`loadoutOpsImportRefusal` → `cultivationCharIds(chess, backups)` → `applyLoadoutEntries(entries, getChess, { ops, isOperator })`；读取前 `confirmDialog` 确认覆盖，全部失效时提示“未做任何改动”并保留当前调配。 |
| `public/css/screens/loadout.css` | 新增 `.lo-lineup__*`（列表行、名称/人数/按钮、窄屏换行），沿用现有 `max(.xrem, Npx)` 与颜色变量。 |
| `public/i18n/en.json`、`ja.json`、`ko.json`、`zh-TW.json` | 各新增 25 条 msgid；`node tools/i18n.mjs check --all --strict` 四包均 1787/1787（100%，0 missing）。 |
| `test/ui/lineups.test.js` | 新增，17 个用例：名称清洗与截断（含不切断代理对）、id 格式、版本与 junk、上限与同名覆盖、空名称/空载荷拒绝、损坏/敌意 id、删除与清空、写失败、以及与 `parseStored`/`parseStoredOps`、`applyLoadoutEntries` 的一致性。 |

### 平台行为

- 网页、Windows（Tauri `sp://localhost/`）、Android（`https://appassets.androidplatform.net`）**同一份代码**：只依赖 `localStorage`，不新增原生 API、不传文件路径、不读写容器私有目录。
- 两端的 origin 由容器固定，所以配队在重启后保留；清除站点数据、卸载应用或换设备会丢失，跨设备仍用上游导出/导入。
- 未使用 `sp.pref.profile` 之类的“profile 信封”，因此不会与代号、账户或后续上游 identity 改动互相覆盖。

### 测试与证据

| 项目 | 结果 |
| --- | --- |
| `node test/ui/lineups.test.js` | 17 pass / 0 fail |
| `test/ui/loadout.test.js`、`loadout-ops-import`、`loadout-quick`、`loadout-rows`、`loadout-stats`、`loadout-sync-stale`、`stats` | 21 / 2 / 4 / 9 / 10 / 9 / 51 pass，全部 0 fail（现有调配同步与存储未受影响） |
| `node tools/i18n.mjs check --all --strict` | 四包 100%，0 missing，0 errors |
| `node --check public/js/screens/loadout.js public/js/ui/lineupModel.js test/ui/lineups.test.js` | 通过（`package.json` 为 `type: module`） |
| `node test/ui/loadout.e2e.test.js` | 0 个用例执行：该文件是 `SP_E2E=1` 才启用的浏览器 E2E（需要 puppeteer-core 与本机 Chrome） |
| 未运行 | `npm test` / `node --test` 全套（本环境禁止子进程 stdio，且 `public/vendor/` 未由 `npm run vendor` 生成）；`cargo`、`gradlew`；浏览器与两端原生容器实机 |

本地运行方式说明：`public/vendor/` 由 `npm run vendor` 生成且不入库，本工作机未生成、并且本会话禁止命令写文件，因此上面的 Node 测试是以 `--experimental-loader` 把 `public/vendor/*` 解析到 `node_modules` 原始模块后执行的（等价于 `npm run vendor` 之后的解析结果，未改仓库内任何文件）。在正常安装了依赖的 checkout 上应直接运行 `node --test test/ui/lineups.test.js`。

### 冲突与回退

- 冲突面集中在两处上游热点：`public/js/screens/loadout.js`（近 50 次提交中约 20 次）与 `public/i18n/en.json`（约 50 次）。改动形态是“标题栏一个按钮 + 文件末尾一个 Modal + 一个 model 文件”，上游改动这些文件时按段落重放即可；`lineupModel.js`、`test/ui/lineups.test.js` 是新增文件，不产生冲突。
- 回退：删掉 `public/js/ui/lineupModel.js`、`test/ui/lineups.test.js`，以及 `loadout.js` 的按钮/Modal、`loadout.css` 的 `.lo-lineup__*`、四份 i18n 的 25 条 msgid，即回到上游行为；残留的 `sp.pref.lineups` 键不被任何上游代码读取，无害。

### 本轮自行作出的最小安全取舍（用户未逐条回答）

1. 范围：只做多份命名配队，不迁代号信封、不做 bundle 导出/导入、不恢复 remember-name 开关。
2. 旧数据：不读取 `sp.pref.profile`，不提供迁移入口（其中没有上游缺失的信息）。
3. 上限与命名：20 份、名称 24 字符、同名覆盖（保留原 id），超出丢最旧。
4. 入口：只在干员调配标题栏加按钮，不改标题页与大厅其它入口。
5. 读取：覆盖前确认；一份都应用不上时不动当前调配；损坏条目在读取时静默丢弃，不弹错误。
6. i18n：四包都补齐（en/ja/ko/zh-TW），未新增机器翻译占位。
## 阶段 E 实施记录：连接与邀请（E1，2026-10-18）

- 新增 `public/js/connection.js`：解析并保存本机连接方式（`sp.server.transport` = `websocket` | `tcp`）与服务器地址（`sp.server.address`；TCP 端点同时写入 bridge 的 `sp.native.tcp`）。
- 原生 bridge 只在连接方式不是 `websocket` 时替换 `globalThis.WebSocket`；升级安装没有该键时仍按 `tcp` 处理，保持旧行为。
- 标题画面在「开始」下方提供连接方式切换（仅原生外壳显示 TCP）、服务器地址与「应用」，以及「同盟邀请」粘贴框；粘贴邀请只设置 `ui.pendingJoin`，由 `main.js` 在进入且连上后自动加入，未填代号时聚焦代号输入框。
- `net.setUrl()` 让启动时保存的地址覆盖页面推导的 WebSocket URL。
- 测试：`test/connection.test.js`（11 项），以及 `test/lobby.test.js`、`test/client-static.test.js`、`test/docs-consistency.test.js`、`test/docs-paths.test.js` 全通过；`node tools/i18n.mjs check --all --strict` 2176/2176。
- 未验证：Windows/Android 真机上的 TCP 与 WebSocket 切换（需要实际构建与局域网服务器）。

## 阶段 E 实施记录：标题画面左横幅 / 右登录（E2，2026-10-18）

- 结构：`<main class="title-main">` 里先是 `<div class="title-hero">`（徽记 `Emblem`、英文标题、`title-cn`、`title-tag`），随后是 `<div class="title-side">`（完整登录框 `.title-login` 与素材按钮 `.title-assets`）；登录框内部保持一列：博士代号 → 同盟邀请 → 开始 → 连接状态 → 连接方式/地址/应用。
- CSS：`.title-main` 在任何视口都是 `flex-direction: row`，没有堆叠断点、没有 `order` 调换；`.title-hero` 为 `flex: 1 1 auto`，`.title-side` 固定 `4.9rem` 宽、`max-height: 92vh` 且 `overflow-y: auto`，让窄屏时登录列自己滚动；`.title-side > .title-login/.title-assets` 宽 `100%` 且 `flex: 0 0 auto`，避免被 flex 压缩后内容溢出面板。
- 窄屏（`max-width: 640px`）：间距收到 `.08rem`、横幅上限 `3.7rem`、标题/英文字号按比例缩小、登录列 `4.4rem` 宽且 `max-height: 96vh`；控件尺寸不动，触控目标沿用项目既有的 `--tap-min: 44px`（`public/css/devices.css:20`），连接方式按钮在 `pointer: coarse` 下用 `min-height: var(--tap-min, 44px)`。
- 不改变既有接线：`开始` 仍是 `.title-login .btn--primary`，第一个输入框仍是博士代号，邀请粘贴与 `applyConnection` 逻辑未动；未重新引入任何下载/镜像入口。
- 测试：`test/ui/title-layout.test.js` 8 项（左右分块与顺序、登录框单列、行列方向无堆叠、登录列滚动与子项不压缩、窄屏让位与 `--tap-min`、四个语言包已删的旧分组文案、无远程素材入口）；另用本机 Chrome（puppeteer-core）在 1280×800、915×412、700×500、640×360、568×320、412×915、360×640、320×568 八个视口实测：全部 `flex-direction: row`、登录列在标题右侧且完整落在视口内、`document.scrollWidth === innerWidth`（无横向滚动），915×412 与 700×500 下登录列 `scrollHeight > clientHeight`（可纵向滚动）。
- 未验证：Windows/Android 真机观感（需要构建与设备）；上述几何由无头 Chrome 量取，真机触屏的 `pointer: coarse` 分支（44px 命中高度）未在设备上复测。

## 阶段 E 实施记录：读取剪贴板（E3，2026-10-23）

- 入口：标题画面服务器地址框内右侧、大厅「最近的同盟」行各一枚「读取剪贴板」按钮。只在用户点击时读一次，不在启动、切换焦点或粘贴时自动读取。
- 通道（`public/js/ui/clipboard.js` 的 `readText()`，返回 `{ ok, text, reason? }`，`reason` ∈ `empty` / `denied` / `unsupported`，永不抛出）：

| 宿主 | 走什么 | 说明 |
| --- | --- | --- |
| Windows（Tauri 外壳） | `invoke('sp_read_clipboard')` | 命令与 `src-tauri/capabilities/default.json` 的 `clipboard-manager:allow-read-text` 本来就在，本轮只是前端首次调用 |
| Android 外壳 | `StrongholdAndroidClipboard.readText()` | `android/.../MainActivity.java` 的内部类 `ClipboardBridge` 同步返回 `String`：`ClipboardManager.getPrimaryClip()` 取第 0 项 `coerceToText`，为空或被系统拒绝一律返回空串 |
| 普通浏览器 | `navigator.clipboard.readText()` | 仅 `isSecureContext` 下存在；`http://host:3000` 这类明文部署是非安全上下文，直接返回 `unsupported`，页面提示手动粘贴 |

- 落点行为：标题画面只把文本填进地址框，不自动「应用」、不改连接方式；文本是邀请链接时也原样填入，之后照旧由 `applyConnection` 按 `parseAddress`/`inviteCode` 处理。大厅用 `public/js/connection.js` 的 `clipboardCode(text, codeLen)` 取 4 位密钥，识别裸码、`room: CODE`、`同盟密钥：CODE`、`tcp://…?room=CODE`、`http://…?room=CODE`；服务器地址这类文本返回 `null`，不会被截成 `HTTP` 填错房间。
- 平台限制（如实标注）：Android 11+ 只有前台获得焦点的应用能读剪贴板，被系统拒绝时返回空串并提示手动粘贴；WebView 的 `navigator.clipboard.readText()` 需要瞬时用户激活加权限授予，实测不可靠，因此走外壳直读。只开读取，写入仍由页面原有 `copyText()`（`execCommand('copy')` 兜底）负责。
- 样式：`TextField` 新增可选 `trailing` 槽（`public/js/ui/components.js`）；`public/css/components.css` 的 `.field__trail` 绝对定位、不参与 flex 排版，未聚焦时输入区只让出「图标宽 + 6px」，聚焦时图标淡出并把宽度还给输入区。地址框外宽与改动前逐像素一致：7 个视口（1920×1080 / 1440×900 / 1280×800 / 1024×768 / 844×390 / 740×360 / 390×844）用 `measure.mjs` 对基线 `cf82bd99` 逐项比对，field / input / 大厅 join-row 均无位移。
- 测试：`test/ui/clipboard-read.test.js` 7 项（三宿主、优先级、空/拒绝/不支持）、`test/native/clipboard-bridge.test.js` 4 项（接线与权限的源码检查；删掉 `addJavascriptInterface(new ClipboardBridge(), "StrongholdAndroidClipboard")` 会转红）、`test/connection.test.js` 追加 `clipboardCode` 用例（18 项）；`node tools/i18n.mjs check --all --strict` 2186/2186。
- 状态：布局与提示态用无头 Chrome 在桌面、平板、手机横竖屏实测；**Windows 打包客户端与 Android 真机上的剪贴板读取尚未实测（待复测）**。
