# Windows 便携包（零安装方案）

本文说明怎么打一份「目标机器什么都不用装」的 Windows 便携包，包里放了什么、没放什么，以及发出去之前要确认的授权。
相关代码：`scripts/make-windows-bundle.mjs`（打包）、`scripts/launch.mjs`（准备 + 起服务器 + 打开浏览器）。

## 1. 这份包解决什么

便携包只做一件事：**让这台 Windows 电脑当服务器**——包内自带 Node、素材与生产依赖，目标机器什么都不用装，
双击 `启动游戏.bat` 就在本机开服并自动打开浏览器，控制台会打印可以发给朋友的局域网地址
（自己玩、或和同宿舍/同办公室的朋友玩）。

**连别人的服务器不需要这个包**：直接用浏览器打开对方的网址就行，和你在浏览器里输网址是同一件事，
本机不用跑服务、不用下素材。包里因此没有「连接服务器」这个入口。

## 2. 打一份便携包

先准备素材（`public/assets`、`public/fonts`、`public/vendor` 都不进版本库）：

```bash
node tools/setup.mjs
```

然后在仓库里（**任意平台**，只要有 Node 22+ 且能上网下载官方 Node 归档）执行：

```bash
node scripts/make-windows-bundle.mjs                    # 产物默认在 <仓库上一级>/Stronghold-Protocol-Windows
node scripts/make-windows-bundle.mjs --out D:\Game\Stronghold-Protocol-Windows --force
node scripts/make-windows-bundle.mjs --no-node          # 目标机器已装 Node 22+ 时不必带便携 Node
node scripts/make-windows-bundle.mjs --node-version v22.23.3 --sha256 <64 位十六进制>   # 换 Node 版本
```

`--out` 请给一个**专用目录**（像上面那样指到某个父目录下的子目录）。加 `--force` 时只会删掉两种情况：
目录是空的，或者里面就是上一次打的便携包（包根有 `README-开箱即用.md` 和 `app\`）。
其余情况一律拒绝并提示 —— 免得手滑把 `--out` 指到仓库、桌面或者其它有东西的目录上，`--force` 就把它们删了。
指向仓库本身或仓库的上级目录时更是在第一步就被挡下来。

产出的始终是 **Windows** 包（内含 win-x64 的 `node.exe`），但它**可以在 macOS / Linux 上打**：
官方归档解压出来的布局固定是 `<zip 名>/node.exe`，与打包机器是什么系统无关。

产物内容：

```
node\node.exe            官方 Windows x64 便携版 Node（版本与 sha256 钉在仓库里，只取 node.exe）
node\LICENSE-node.txt    Node 自己的许可证（MIT，与 node.exe 出自同一个官方归档）
app\                     游戏本体：代码 + 生产依赖 + public（全部素材）+ data，完全离线
启动游戏.bat             app\scripts\launch.mjs --no-setup
启动游戏-插件沙箱.bat    同上，加 --scripts sandbox（脚本插件在沙箱里运行）
README-开箱即用.md       给玩家看的说明（含非官方 / 严禁盈利 / 素材版权声明）
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
```

把整个文件夹拷到目标电脑 —— **什么都不用安装**，双击 `启动游戏.bat` 即可（等于 `app\scripts\launch.mjs --no-setup`：
素材已经在包里，跳过联网准备，直接起服务器并打开浏览器）。
卸载＝删除文件夹（不写注册表、不放系统目录）。素材约 330 MB 是硬成本，包因此比较大。
只想开服、不需要替玩家带素材？见第 7 节的**精简服务端包**。

## 3. 包里放了什么、没放什么

`app\` 的文件清单来自 **`git ls-files`**，不是手写的跳过表。因此被 `.gitignore` 挡在版本库外的本机文件
（`.env`、`.venv*`、`.claude/`、`scripts/service.env.cmd` …）**天然进不了包** ——
它们里面可能有密钥或本机路径，旧实现用一张窄表整树复制，漏一项就是把它打进别人下载的压缩包。

在此之上额外放入三份不进版本库、但游戏必需的资源，以及用 `npm ci --omit=dev` **重新装好的生产依赖**：

* `public/assets`、`public/fonts`、`public/vendor`（由 `tools/setup.mjs` 下载 / 生成）；
* `node_modules` 只含生产依赖 —— `puppeteer-core` 这类 devDependency 是开发测试用的，打进发行包只会白涨体积；
* `data/local-assets.json`（本机提取过 3D 棋盘贴图时才有）：贴图本体在 `public/assets/local`（约 68 MB，会随
  `public/assets` 进包），但游戏是靠这份 JSON 才知道有哪些贴图可用 —— 只带贴图不带清单，玩家拿到的是 68 MB
  用不上的文件。清单不存在时会提示先跑 `node tools/setup.mjs --local`。
* `test/` 一律不进包（省体积）。

整树复制时会跳过符号链接与**点开头的条目**：打包机器的 `.DS_Store` 既不属于项目，也不该出现在别人下载的包里。

Node 版本与 sha256 **钉死在 `scripts/make-windows-bundle.mjs` 的 `NODE_PIN`** 里（不用 `latest-v22.x`）：
那样今天打包和上个月打包内容不同，出了问题也无法复现。换版本必须显式给 `--node-version`（要写成 `vX.Y.Z` 这样的
具体版本）+ `--sha256`。

官方 zip 的下载缓存放在仓库的 **`.cache/`**（不进版本库），而 **`node.exe` 每次都从校验过的 zip 重新解压**：
解压目标是新建的临时目录、用完即删。缓存的是 zip，不是解压结果 —— 解压中断留下的残缺 `node.exe` 与校验过的
zip 没有任何对应关系，复用就等于把坏文件发出去；系统临时目录在 Linux 上还是共享的。
解压器按平台兜底：`tar`（Windows 10+ 与 macOS 自带的 bsdtar 都认得 zip）→ `unzip`（GNU tar 解不了 zip，
Linux 上是这一档）→ Windows 自带的 `Expand-Archive`。

关于 `--out` 与 `--force`：`--out` 指向**仓库本身或它的上级目录**时直接拒绝；即使指到别处，`--force` 也只会在
「目录是空的」或「里面就是上一次打的便携包（包根有 `README-开箱即用.md` 和 `app\`）」时才删除，
其它情况一律拒绝并不动那个目录 —— 路径比较挡不住大小写、符号链接、8.3 短名这些花样，所以规则是反着写的：
只有能确认「这就是上次的产物」才动手。

## 4. 授权（发出去之前请确认你同意）

便携包把整个游戏原样带给别人，所以包根会带上本项目的声明文件，包内 `README-开箱即用.md` 也完整重复了一遍：

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有。这些素材**不适用**本项目的 GPL-3.0 许可证；GPL 只覆盖本项目自己编写的代码。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括但不限于：售卖本项目或整合包、付费下载或付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现方式，以及其他任何商业用途。
> - 本包为了方便玩家附带了游戏的美术与音频素材，下载即视为同意本声明。请勿将素材用于本项目以外的用途或**单独再分发**。完整条款见 [NOTICE.md](../NOTICE.md)。
> - 权利人如认为本项目侵犯其权益，请通过 Issue 联系，我们会**立即删除**相关内容。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。

内置 Node.js（MIT）与其它第三方组件的许可见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) 与
`node\LICENSE-node.txt`（`node.exe` 自己的许可证，从同一个官方归档里取出来一起发）。

## 5. 常见问题

| 症状 | 处理 |
|---|---|
| 双击 `.bat` 一闪而过 | 在命令行里跑 `启动游戏.bat` 看报错，或手动运行 `node\node.exe app\scripts\launch.mjs --no-setup`（`.bat` 会在非 0 退出时暂停）。**`--no-setup` 别省**：省掉它会去联网准备素材，而且 PATH 上不一定有 `node` |
| 提示找不到 node | 便携包应含 `node\node.exe`；没有就用 `--no-node` 的包，并自行安装 Node 22/24 LTS |
| 端口被占用 | 关掉占用 3000 的程序（`node tools/doctor.mjs` 会指出是谁），或在启动命令后加 `--port 3001` |
| 浏览器没自动打开 | 手动访问 `http://127.0.0.1:<端口>`；`--no-open` / `SP_NO_BROWSER=1` 会禁用自动打开 |
| 朋友连不上 | 防火墙专用网络未放行、或不在同一网段；用 `node tools/doctor.mjs` 诊断（源仓库里见 [DEPLOY.md](DEPLOY.md) 的防火墙一节） |
| 进游戏时弹出「下载文件信息」 | 那是 IDM / 迅雷这类下载管理器在嗅探音频地址，不是游戏在下载。新版本已经改走不带扩展名的 `/media/…` 路由（见 [PR #28](https://github.com/sganggs/Stronghold-Protocol/pull/28)），**应该不会再弹**；如果还弹，把弹出的地址贴到 Issue，或在下载器里加例外（如 `http://127.0.0.1:3000/*`）、玩游戏时先退出它 |
| 首次进游戏很慢 | 每位玩家要下载几十 MB 素材（本机开服时是本机读盘），之后走浏览器缓存 |
| 在 Linux 上打包报解压失败 | GNU tar 不认 zip：装一个 `unzip`（或在文档允许的范围内改用 macOS / Windows 打包） |

## 6. 安全与体积说明

* 便携包里的 `node.exe` 来自 nodejs.org 官方发行版，**按仓库里钉死的 sha256 校验**后才复制，未做任何修改；
  同时取出同一个归档里的 `LICENSE` 作为 `node\LICENSE-node.txt` 一起发出去。
* `app\` 里只有版本库跟踪的文件 + 生产依赖 + 素材 + 3D 棋盘清单，被 `.gitignore` 排除的本机文件
  （`.env`、`.claude/`、`scripts/service.env.cmd` 等）不会进包。
* 游戏不写注册表、不装服务；`启动游戏.bat` 内容只有几行（切到 UTF-8 代码页 → 找 `node\node.exe` →
  跑 `app\scripts\launch.mjs --no-setup`）。
* 想做成随开机启动的 Windows 服务，用仓库自带的 `scripts/install-service-windows.ps1`（面向整合包/源码部署，见 [DEPLOY.md](DEPLOY.md)）。

## 7. 精简服务端包（只给服主用，不含素材）

第 2 节的便携包把素材（约 330 MB）一起发给玩家，因为它同时扮演「本机服务器」和「浏览器游戏」。如果只需要一台
对局服务器、素材由玩家自己的客户端带，用精简服务端包：

```bash
node scripts/make-server-lite.mjs                        # 产物默认在 <仓库上一级>/Stronghold-Protocol-Enhanced-<版本>-Windows-Server-Lite
node scripts/make-server-lite.mjs --out D:\Srv\SP-Lite   # 指定目录（同样要专用目录）
node scripts/make-server-lite.mjs --no-node              # 目标机器已装 Node 22+，不带便携 Node
node scripts/make-server-lite.mjs --no-zip               # 只要目录，不打 zip
```

`npm run package:server:lite` 等价于第一条。`--out` / `--force` 的删除规则与第 2 节一致，只是「上一次的产物」认的是
包根有 `README-Lite-Server.md` 和 `app\`。

产物内容：

```
node\node.exe            官方 Windows x64 便携版 Node（同一个 NODE_PIN，sha256 校验）
node\LICENSE-node.txt    Node 自己的许可证（MIT）
app\                     服务端本体：server / shared / public（无素材）/ data / packs / plugins / scripts / tools / docs
启动轻量服务端.bat       SP_ASSET_INDEX=0、SP_STUDIO=off，默认 PORT=3000、TCP_PORT=3001
README-Lite-Server.md    给服主看的说明
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
```

和玩家包相比，取舍是：

* **不含素材文件**：`public/assets`、`public/fonts`、`public/vendor` 都不进包，本地素材路径返回 404，启动器把
  `SP_ASSET_INDEX` 关掉（不去扫一棵不存在的素材树）。因此它**不是浏览器可玩客户端包** —— 要网页界面玩，用完整便携包，
  或把这三个目录放进 `app\public\` 再启动。
* **保留素材清单 JSON**：`data/assets.json` 照旧留在包里。客户端请求 `/data/assets.json` 仍然返回 200 和完整清单，
  靠它判断哪些素材存在；`data/local-assets.json`、`data/local-fx.json` 描述的是本机提取出来的素材，不属于服务端发布
  内容，所以不带 —— 缺省时服务端对这两条路径返回空清单（`{"version":1,"source":"none",...}`），不是 404。
* **不带原生客户端工程和测试**：`android/`、`src-tauri/`、`native/`、`test/` 与服端无关。
* 文件清单同样来自 `git ls-files`，生产依赖同样用 `npm ci --omit=dev` 重装；`--force` 的删除判定同样是反着写的。

发出去之前先自己跑一遍：

```
双击 启动轻量服务端.bat（或在命令行 set PORT=3021 & set TCP_PORT=3022 后再跑）
```

然后确认：`http://127.0.0.1:3021/data/assets.json` 返回 200（内容约 1.9 MB 的 JSON）、`/assets/<任意>` 与
`/fonts/<任意>` 返回 404、`/` 仍能打开网页骨架（缺 `public/vendor`，所以只是骨架）。端口可用 `PORT` / `TCP_PORT` /
`HOST` 覆盖，第一次开服记得在防火墙里放行专用网络。

## 8. 原生客户端（Tauri 便携包，不装安装器）

第 2 节的包用便携 Node 跑服务端、用浏览器玩。原生客户端是另一条路：Tauri 外壳（WebView2）把同一份网页装进窗口，
素材随包、启动不联网，TCP 直连服务端（不依赖浏览器 WebSocket 也能玩），发出去的是一个解压即用的目录或 zip。

```bash
node scripts/make-windows-client.mjs                    # 先 cargo tauri build，再组装 <仓库上一级>/Stronghold-Protocol-Enhanced-<版本>-Windows-Portable
node scripts/make-windows-client.mjs --skip-build       # 复用 src-tauri/target/release 里已有的 exe
node scripts/make-windows-client.mjs --exe D:\x\Stronghold Protocol.exe --no-zip
```

`npm run package:client:win` 等价于第一条。构建要求：Rust（MSVC 工具链）+ Visual Studio Build Tools + WebView2 Runtime，
外加素材已 `node tools/setup.mjs`。release 构建会由 `src-tauri/build.rs` 跑 `node ../tools/check-embedded-assets.mjs --strict`，
清单过期或素材缺失会直接构建失败。

产物布局：

```
Stronghold Protocol.exe   窗口主程序（sp://localhost/ 私有协议 + TCP 桥 + 素材导入）
client\                   窗口加载的网页：public\ 的原样内容（含 assets\ fonts\ vendor\）+ data\ + shared\ + sim\ + data.js
README-Windows.md         玩家说明
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
```

`client\` 必须和 exe 放在同一层：`src-tauri/src/protocol.rs` 的 `client_root()` 在没有安装资源目录时按
「exe 所在目录的 `client\`」找网页，找不到就 404。这里**不生成安装器**（`tauri.conf.json` 的 `bundle.targets`
不用 `nsis`），发布产物就是这个目录或它的 zip。目录名保持 `--out` 给的名字，zip 固定叫
`Stronghold-Protocol-Client-v<版本>-win-x64.zip`（与 `--out` 同级），沿用 2.x 起玩家下载的文件名。
素材包与增量包见 [NATIVE-RECONSTRUCTION.md](NATIVE-RECONSTRUCTION.md) 第 3 节。

启动失败排查：`main.rs` 先跑 `prepare_runtime()`，按「显式 `WEBVIEW2_USER_DATA_FOLDER` → 程序目录的
`webview2-profile\` → `%LOCALAPPDATA%\Stronghold Protocol Enhanced\WebView2` → 临时目录」取第一个可写的
WebView2 数据目录，并把启动记录与错误写进 `client.log`（先 exe 同目录，写不进去时依次退到用户目录与
临时目录）。`tauri::Builder::build` 抛错或被 Tauri 内部 panic 打断（典型是 WebView2 返回 `0x800700AA`
「请求的资源在使用中」）时，用下一个候选目录重新拉起进程重试一次，仍失败才弹原生错误框（而不是无声退出）。
遇到「普通权限闪退、管理员能开」时，先看这个日志，再确认包是不是解压到了
没有写权限的目录（`Program Files`、系统目录、只读盘，或在压缩包里直接双击）。
旧安装留下的 `%LOCALAPPDATA%\Stronghold Protocol\`（3.1.0 及更早）不会再被 3.2.0 读取或写入。
