卫戍协议：盟约 · Windows 便携客户端
=====================================

1. 双击“Stronghold Protocol Client.exe”。
2. 选择连接协议并输入服务器地址：
   WebSocket（HTTP）：192.168.1.10:3000
   TCP 直连：192.168.1.10:3001
3. 输入博士代号，点击“连接服务器”。

离线完整包已包含美术、音频、游戏数据和本地战斗模拟。配置私有 R2 的薄客户端会在成功连接游戏服务后，使用短期授权下载并校验运行时素材；素材保存在当前 Windows 应用数据目录 %APPDATA%\com.zasx77771.stronghold-protocol-enhanced.client\asset-runtime，不会写入或覆盖程序安装目录。会话令牌与素材网关签发的短期 JWT 只在客户端原生代码（Rust）中使用，不会交给网页脚本。
服务器负责对局、匹配和权威校验，默认 WebSocket 端口 3000，原生 TCP 端口 3001。
标题页的本地统计页仅保存本设备已结算的对局摘要；它不连接账号、回放或服务器对局记录服务。
玩家资料、配队和干员配置保存在本机，可在下次启动客户端时复用。

本客户端是 Tauri 2 原生程序（源码在 src-tauri/，用 cargo tauri build 构建），不需要安装 Node.js。
首次启动时若系统缺少 Microsoft Edge WebView2 运行库，安装程序会按需下载安装；页面资源由程序内部的
私有协议直接从安装目录读取，不监听任何本地端口。窗口默认 1440×810，最小 960×540，可自由缩放。

支持的地址：
  192.168.1.10:3000
  http://example.com:3000
  https://game.example.com
  ws://example.com:3000/ws
  wss://game.example.com/ws
  tcp://192.168.1.10:3001

TCP 直连只在 Windows/Android 客户端中可用；它不是 HTTP 服务。

本作品是非官方同人作品，仅供学习交流与个人非商业使用。完整声明见 NOTICE.md。
