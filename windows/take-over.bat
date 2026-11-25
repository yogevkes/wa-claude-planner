@echo off
rem Makes THIS computer the one that runs the bot (the other computer stops by itself within ~2 minutes).
rem Usage: take-over.bat [instance]
chcp 65001 >nul
cd /d "%~dp0.."
set "INST=%~1"
if "%INST%"=="" set "INST=default"
title WA-Claude Planner - take over - %INST%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" -Instance %INST% >nul
node src\index.js --instance %INST% --take-over || (echo. & echo Take-over failed - see the messages above. & pause & exit /b 1)
wscript "%~dp0start-hidden.vbs" %INST%
echo.
echo Done: the bot runs on this computer now (in the background).
pause
