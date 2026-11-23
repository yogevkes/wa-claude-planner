@echo off
rem Visible run (first WhatsApp link, debugging).  Usage: start.bat [instance]
chcp 65001 >nul
cd /d "%~dp0.."
set "INST=%~1"
if "%INST%"=="" set "INST=default"
title WA-Claude Planner - %INST%
node src\index.js --instance %INST%
pause
