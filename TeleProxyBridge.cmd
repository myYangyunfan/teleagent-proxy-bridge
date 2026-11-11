@echo off
chcp 65001 >nul
setlocal EnableExtensions
title TeleProxyBridge
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

call :findnode
if errorlevel 1 goto :nonode

if not "%~1"=="" goto :arg

:menu
cls
echo ==========================================================
echo    TeleProxyBridge  -  TeleAgent 本地反代
echo ==========================================================
echo    node : %NODE%
echo    root : %ROOT%
echo ----------------------------------------------------------
echo    1  开启桥接  （启动桥 + 挂钩 + 重启 TeleAgent）
echo    2  关闭桥接  （还原地址 + 重启 TeleAgent）
echo    3  查看状态
echo    4  查看日志
echo    5  打开抓包目录
echo    6  创建桌面快捷方式
echo    7  每日签到  （状态 / 下次时间）
echo    8  立即签到一次
echo    9  打开控制台  （图形面板，推荐）
echo    0  退出
echo ----------------------------------------------------------
set "SEL="
set /p "SEL=请选择: "
if not defined SEL goto :eof
if /i "%SEL%"=="1" call :do up & pause & goto :menu
if /i "%SEL%"=="2" call :do down & pause & goto :menu
if /i "%SEL%"=="3" call :do status & pause & goto :menu
if /i "%SEL%"=="4" call :do logs --lines 60 & pause & goto :menu
if /i "%SEL%"=="5" (start "" "%ROOT%\captures") & goto :menu
if /i "%SEL%"=="6" (call :do shortcut) & pause & goto :menu
if /i "%SEL%"=="7" (call :do signin --status) & pause & goto :menu
if /i "%SEL%"=="8" (call :do signin) & pause & goto :menu
if /i "%SEL%"=="9" (call :do ui) & goto :menu
if /i "%SEL%"=="0" goto :eof
goto :menu

:arg
call :do %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%

:do
echo.
"%NODE%" "%ROOT%\src\cli.mjs" %*
exit /b %ERRORLEVEL%

:findnode
set "NODE="
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if defined NODE goto :findnode_ok
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if defined NODE goto :findnode_ok
if exist "%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" set "NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe"
if defined NODE goto :findnode_ok
if exist "D:\app\TeleAgent\resources\node\node.exe" set "NODE=D:\app\TeleAgent\resources\node\node.exe"
if defined NODE goto :findnode_ok
if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if defined NODE goto :findnode_ok
echo [!] 没有找到 Node.js
echo     装一个 Node 18+，或把 node.exe 放到 %ROOT%\runtime\node.exe
exit /b 1
:findnode_ok
exit /b 0

:nonode
pause
endlocal & exit /b 1
