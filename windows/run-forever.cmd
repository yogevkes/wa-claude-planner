@echo off
rem Keeps one instance running; restarts it 15s after a crash.  Usage: run-forever.cmd [instance]
rem Exit code 2 = WhatsApp logged out (source installs without the settings page) -> stop and wait for a re-link.
chcp 65001 >nul
cd /d "%~dp0.."
set "INST=%~1"
if "%INST%"=="" set "INST=default"
if /i "%INST%"=="default" (set "LOGDIR=data\logs") else (set "LOGDIR=instances\%INST%\data\logs")
rem The installed app keeps its data in %LOCALAPPDATA%\WA-Claude Planner (see src\config.js)
if exist install.json (if /i "%INST%"=="default" (set "LOGDIR=%LOCALAPPDATA%\WA-Claude Planner\data\logs") else (set "LOGDIR=%LOCALAPPDATA%\WA-Claude Planner\instances\%INST%\data\logs"))
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
rem The installed app ships its own Node.js in node\
set "NODE=node"
if exist "%CD%\node\node.exe" set "NODE=%CD%\node\node.exe"
:loop
echo [%date% %time%] starting %INST% >> "%LOGDIR%\runner.log"
"%NODE%" src\index.js --instance %INST% >> "%LOGDIR%\console.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%date% %time%] exited with code %CODE% >> "%LOGDIR%\runner.log"
if "%CODE%"=="2" (
  echo [%date% %time%] WhatsApp logged out - run windows\start.bat %INST% to link again >> "%LOGDIR%\runner.log"
  exit /b 2
)
rem 75 = restart requested from the settings page
if "%CODE%"=="75" goto loop
rem ping instead of timeout: timeout fails in background (no console) sessions
ping -n 16 127.0.0.1 >nul
goto loop
