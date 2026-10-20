# 发布包：怎么打、叫什么

本文件讲发布包本身：四条打包命令产出的目录与压缩包、固定的文件名，以及上传前必须过的检查。版本号、标签与 Release 口径见 [../docs/RELEASE-POLICY.md](../docs/RELEASE-POLICY.md)。

## 四个打包脚本

| 产物 | 命令 | 目录（`--out`） | 压缩包/文件（固定名） |
| --- | --- | --- | --- |
| Windows 客户端 | `npm run package:client:win` | `windows-client/` | `Stronghold-Protocol-Client-v<版本>-win-x64.zip` |
| Android 客户端 | `npm run package:client:android` | `android-client/` | `Stronghold-Protocol-Client-v<版本>-android.apk` |
| Windows 服务端（精简） | `npm run package:server:lite` | `windows-server/` | `Stronghold-Protocol-Server-v<版本>-win-x64.zip` |
| 服务端增量包 | `npm run package:server:update -- --from <旧包 zip 或解压目录>[,<…>]` | `server/<版本>/` | `Stronghold-Protocol-Server-v<版本>-win-x64-update.zip` |

- `<版本>` 一律取 `package.json` 的 `version`，不要在命令行或文件名里手写版本。
- 目录名由 `--out` 决定；客户端与服务端完整包的压缩包写在 `--out` 的同级目录，服务端增量包直接写进 `--out`。
- 文件名的生成位置：`scripts/make-windows-client.mjs`、`scripts/make-android-client.mjs`、`scripts/make-server-lite.mjs`。
- **不要手工改名**。要改口径就改脚本，让下一次打包自然产出新名字。

服务端增量包由 `make-server-lite.mjs --update --from …` 生成：只包含相对列出的旧版本改动过的文件，外加新版本的
`app\MANIFEST.json` 与 `app\UPDATE.json`，没有外层文件夹；服主解压到含 `app\` 的包根覆盖即可，服务端启动第一件事会
核对 `app\MANIFEST.json`、删掉清单里 `removed` 的旧文件。

- `--from` 可以给**多个旧完整包**（逗号分隔，或重复 `--from`），一个增量包同时覆盖这些基线。保留最近 2 个基线
  （例如 3.2.2 的包同时支持 3.2.0 与 3.2.1）；已发布的完整包与增量包**全部保留，不删**。
- 只覆盖 `app\`：`node\`、`启动轻量服务端.bat`、包根的声明文件不在更新范围内，Node 换代（`NODE_PIN`）时脚本直接
  报错，只能发完整包。
- Android 不制作增量包；首次安装、跨多个大版本或增量包拒绝启动时，用同版本完整包覆盖 `app\`。

## 存放位置

正式产物只写工作区的 `enhanced-client-servers/`，目录名固定：

| 产物 | 目录 |
| --- | --- |
| Windows 客户端、Android APK、服务端完整包 | `02-增强版正式发布/v<版本>/` |
| 服务端增量包 | `03-客户端更新包/server/<版本>/` |
| Windows 客户端增量包 | `03-客户端更新包/windows/` |

已发布的包不得原地替换。Release 默认只发说明文字；要附安装包时，在说明里写清为什么附，并列出文件名、大小与
SHA-256（见 [../docs/RELEASE-POLICY.md](../docs/RELEASE-POLICY.md)）。

## 产物内容

- Windows 客户端：`Stronghold Protocol.exe` + 同层 `client/`（网页、数据、`shared/`、`server/sim/`）+ `README-Windows.md`、`unblock.bat`、法律文件。exe 与 `client/` 必须同层，`src-tauri/src/protocol.rs` 的 `client_root()` 先找资源目录、再找 exe 旁边的 `client/`。
- Android：只有一个 APK（素材已随包内嵌）。
- 服务端：便携 Node + `app/`（含裁剪过的 `node_modules`）+ `启动轻量服务端.bat` + README。**不含任何素材文件**，只保留 `data/assets.json` 清单。

## 上传前必须过

```bash
# Android：签名与对齐
<android-sdk>/build-tools/35.0.0/apksigner.bat verify --print-certs <apk>   # 证书 SHA-256 必须是正式指纹
<android-sdk>/build-tools/35.0.0/zipalign.exe -c -p 4 <apk>

# 每个产物：记下大小与 SHA-256，写进 Release 说明
Get-FileHash <file> -Algorithm SHA256
```

补充检查：

- Windows 客户端：普通权限双击能起来，`%LOCALAPPDATA%\Stronghold Protocol Enhanced\client.log` 里有 `[launch] starting`。
- 服务端：解压后跑 `启动轻量服务端.bat`，`/healthz`、`/data/assets.json` 返回 200，`/assets/*` 返回 404（证明没带素材）。
- 服务端增量包：把某个基线旧完整包解压到临时目录，再把增量包解压进去，启动后控制台出现「已更新到 v<版本>」，
  `app\UPDATE.json` 已改名 `.update-applied.json`，旧版本删掉的文件确实不在；每个基线都要这样验一遍。
- 包内不要 `npm install`（`node_modules` 已裁剪，装回去会重新引入浏览器库）。

## 常见问题

- **SmartScreen 拦住 exe**：包内带了 `unblock.bat`，解压后双击即可；也可以解压前对 zip 右键「解除锁定」。原因是没有代码签名，浏览器下载的 zip 解出的文件带「来自 Internet」标记。
- **解压很慢**：用 `tar.exe -xf <zip>`（Win10 1803+ 自带）而不是资源管理器右键；不要解到 SMB/NFS/网盘同步目录。杀软可以加安装目录排除：`Add-MpPreference -ExclusionPath 'D:\sp'`。
- **不用安装器**：Windows 客户端只发便携 ZIP，不生成 nsis 安装包。
