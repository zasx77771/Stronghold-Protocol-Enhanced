@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "SP_SERVER_ONLY=1"
if not defined PORT set "PORT=3000"
if not defined HOST set "HOST=0.0.0.0"
node.exe server\index.js
if errorlevel 1 pause
