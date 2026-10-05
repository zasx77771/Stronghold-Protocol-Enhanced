卫戍协议：盟约 · Windows 独立网络服务端
=======================================

快速启动
--------
1. 双击 start-server.cmd。
2. 默认监听 WebSocket 端口 3000、游戏原生 TCP 端口 3001，以及回放原生 TCP 端口 3002。
3. 客户端选择协议后填写对应地址：WebSocket 使用 192.168.1.10:3000，TCP 直连使用 192.168.1.10:3001；Windows 客户端的“对局记录”使用 192.168.1.10:3002。

这个发行包只负责 WebSocket / TCP 联机、房间、匹配、对局状态与服务端校验：
  /ws       WebSocket 联机入口
  /healthz  服务状态检查
  TCP 3002  对局记录 / 回放入口（长度前缀 JSON，不是 HTTP 网页）

它不包含、也不会提供网页、图片、音频、字体或客户端脚本；所有其他 HTTP 路径均返回 404。
data 目录中的少量 JSON 是服务端进行房间和对局计算所必需的内部规则数据，不会通过 HTTP 暴露。

自定义端口
----------
PowerShell：
  .\start-server.ps1 -Port 3000 -TcpPort 3001 -SpectatorPort 3002

或在 cmd 中：
  set PORT=3001
  set TCP_PORT=3002
  set SPECTATOR_PORT=3003
  start-server.cmd

公网部署时请在系统防火墙和路由器中开放所用端口。WebSocket 反向代理必须支持 Upgrade，
并把 /ws 转发到本服务。启用 HTTPS 的站点应让客户端使用 wss:// 地址。
原生 TCP 端口不能通过普通 HTTP 反向代理，只供 Windows/Android 打包客户端使用。

可选环境变量
------------
  PORT=3000            监听端口
  TCP_PORT=3001        原生 TCP 直连端口（默认 PORT + 1）
  SPECTATOR_PORT=3002  对局记录 / 回放原生 TCP 端口；设为 off 可禁用
  HOST=0.0.0.0         监听地址
  TRUST_PROXY=auto     代理来源地址信任策略（auto / 1 / 0）
  SP_VERIFY=sample     抽样复核客户端战斗结果（也可设为 all；默认 off）
  SP_COMBAT=server     使用旧版服务端战斗模拟模式（默认由客户端模拟）

关闭服务端：在服务端窗口按 Ctrl+C。
本作品是非官方同人作品，仅供学习交流与个人非商业使用。完整声明见 NOTICE.md。
