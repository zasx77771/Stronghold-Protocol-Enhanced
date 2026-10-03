卫戍协议：盟约 · Windows 便携客户端
=====================================

1. 双击“Stronghold Protocol Client.exe”。
2. 选择连接协议并输入服务器地址：
   WebSocket（HTTP）：192.168.1.10:3000
   TCP 直连：192.168.1.10:3001
3. 输入博士代号，点击“连接服务器”。

客户端已包含美术、音频、游戏数据和本地战斗模拟，不需要从服务器下载这些资源。
服务器仍需单独运行 BaseCode 服务端。默认 WebSocket 端口 3000，原生 TCP 端口 3001。

支持的地址：
  192.168.1.10:3000
  http://example.com:3000
  https://game.example.com
  ws://example.com:3000/ws
  wss://game.example.com/ws
  tcp://192.168.1.10:3001

TCP 直连只在 Windows/Android 客户端中可用；普通浏览器受安全模型限制，不能打开原生 TCP Socket。

本作品是非官方同人作品，仅供学习交流与个人非商业使用。完整声明见 NOTICE.md。
