@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行, 正在安装依赖...
  call npm install
)
node tools\launch.js
