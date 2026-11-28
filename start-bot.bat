@echo off
rem Double-click: starts WA-Claude Planner (tray icon) and opens the settings page.
rem Also turns automatic start back on after stop-bot.bat.
start "" wscript.exe "%~dp0windows\start-app.vbs" -Open
