卫戍协议：盟约 · Windows 独立网络服务端
=======================================

快速启动
--------
1. 双击 start-server.cmd。
2. 默认监听 WebSocket 端口 3000 和游戏原生 TCP 端口 3001。
3. 客户端选择协议后填写对应地址：WebSocket 使用 192.168.1.10:3000，TCP 直连使用 192.168.1.10:3001。

这个发行包只提供游戏 WebSocket/TCP 服务，包括房间、匹配、对局状态和可选的服务端战斗校验：
  /ws       WebSocket 联机入口
  /healthz  服务状态检查
  /api/assets/token  已配置 SP_ASSET_TOKEN_SECRET 时，为已连接客户端换取短期 R2 素材令牌

服务端不提供账号、回放存储或服务器对局记录 API。本地统计页和可复用玩家资料均保存在客户端。
data 目录中的少量 JSON 是服务端进行房间和对局计算所必需的内部规则数据，不会通过 HTTP 暴露。

自定义端口
----------
PowerShell：
  .\start-server.ps1 -Port 3000 -TcpPort 3001

或在 cmd 中：
  set PORT=3000
  set TCP_PORT=3001
  start-server.cmd

公网部署时请在系统防火墙和路由器中开放所用端口。WebSocket 反向代理必须支持 Upgrade，
并把 /ws 转发到本服务。启用 HTTPS 的站点应让客户端使用 wss:// 地址。
原生 TCP 端口不能通过普通 HTTP 反向代理，只供 Windows/Android 打包客户端使用。

可选环境变量
------------
  PORT=3000            HTTP/WebSocket 监听端口
  TCP_PORT=3001        原生 TCP 直连端口（默认 PORT + 1）
  HOST=0.0.0.0         监听地址
  TRUST_PROXY=auto     代理来源地址信任策略（auto / 1 / 0）
  SP_VERIFY=sample     抽样复核客户端战斗结果（也可设为 all；默认 off）
  SP_COMBAT=server     使用旧版服务端战斗模拟模式（默认由客户端模拟）

关闭服务端：在服务端窗口按 Ctrl+C。
本作品是非官方同人作品，仅供学习交流与个人非商业使用。完整声明见 NOTICE.md。
