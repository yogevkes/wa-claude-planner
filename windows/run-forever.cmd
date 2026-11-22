@echo off
rem Keeps the planner running; restarts it 15s after a crash.
rem Exit code 2 = WhatsApp logged out -> stop and wait for a manual re-link (start.bat).
chcp 65001 >nul
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
:loop
echo [%date% %time%] starting >> data\logs\runner.log
node src\index.js >> data\logs\console.log 2>&1
set CODE=%ERRORLEVEL%
echo [%date% %time%] exited with code %CODE% >> data\logs\runner.log
if "%CODE%"=="2" (
  echo [%date% %time%] WhatsApp logged out - run windows\start.bat to link again >> data\logs\runner.log
  exit /b 2
)
rem ping instead of timeout: timeout fails in background (no console) sessions
ping -n 16 127.0.0.1 >nul
goto loop
