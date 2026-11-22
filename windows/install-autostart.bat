@echo off
rem Double-click to install autostart (asks for admin approval). Add "logon" as argument for logon mode.
set MODE=Startup
if /i "%~1"=="logon" set MODE=Logon
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -Mode %MODE%
