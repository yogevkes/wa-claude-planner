@echo off
rem Connect / re-connect Google Calendar for an instance.  Usage: google-auth.bat [instance]
chcp 65001 >nul
cd /d "%~dp0.."
set "INST=%~1"
if "%INST%"=="" set "INST=default"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" -Instance %INST%
node scripts\google-auth.js --instance %INST%
echo.
echo Now start the bot again: windows\start.bat %INST%  (or reboot if autostart is installed).
pause
