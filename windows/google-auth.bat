@echo off
rem Re-connect Google Calendar (creates a new data\google-token.json). Stop the bot first.
chcp 65001 >nul
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
call npm run google-auth
echo.
echo Now start the bot again: windows\start.bat (or reboot if autostart is installed).
pause
