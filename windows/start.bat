@echo off
rem Visible run (first WhatsApp link, debugging).  Usage: start.bat [instance]
chcp 65001 >nul
cd /d "%~dp0.."
rem An explicit start turns automatic start back on after a full stop (stop-bot.bat)
if exist "stopped.flag" del "stopped.flag"
set "INST=%~1"
if "%INST%"=="" set "INST=default"
title WA-Claude Planner - %INST%
node src\index.js --instance %INST%
pause
