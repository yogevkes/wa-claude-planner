@echo off
rem Double-click to install autostart for the default instance (asks for admin approval).
rem   install-autostart.bat roni         -> instance "roni"
rem   install-autostart.bat roni logon   -> logon mode instead of startup mode
set "INST=%~1"
set "MODE=Startup"
if /i "%INST%"=="logon" (set "INST=default" & set "MODE=Logon")
if /i "%~2"=="logon" set "MODE=Logon"
if "%INST%"=="" set "INST=default"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -Mode %MODE% -Instance %INST%
