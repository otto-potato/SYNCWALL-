@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 22.13.0 或更高版本。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次启动，正在安装依赖……
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo 正在启动 SYNCWALL 局域网服务……
call npm run dev
pause

