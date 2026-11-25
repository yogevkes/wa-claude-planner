@echo off
rem Keeps one instance running; restarts it 15s after a crash.  Usage: run-forever.cmd [instance]
rem Exit code 2 = WhatsApp logged out -> stop and wait for a manual re-link (start.bat).
rem Exit code 3 = the bot now runs on another computer -> stop (windows\take-over.bat moves it back).
chcp 65001 >nul
cd /d "%~dp0.."
set "INST=%~1"
if "%INST%"=="" set "INST=default"
if /i "%INST%"=="default" (set "LOGDIR=data\logs") else (set "LOGDIR=instances\%INST%\data\logs")
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
:loop
echo [%date% %time%] starting %INST% >> "%LOGDIR%\runner.log"
node src\index.js --instance %INST% >> "%LOGDIR%\console.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%date% %time%] exited with code %CODE% >> "%LOGDIR%\runner.log"
if "%CODE%"=="2" (
  echo [%date% %time%] WhatsApp logged out - run windows\start.bat %INST% to link again >> "%LOGDIR%\runner.log"
  exit /b 2
)
if "%CODE%"=="3" (
  echo [%date% %time%] The bot now runs on another computer - stopped here. Run windows\take-over.bat %INST% to move it back >> "%LOGDIR%\runner.log"
  exit /b 3
)
rem ping instead of timeout: timeout fails in background (no console) sessions
ping -n 16 127.0.0.1 >nul
goto loop
