@echo off
rem Double-click: stops WA-Claude Planner completely. It stays stopped after a restart of the computer.
rem To start it again: start-bot.bat (or the Start menu).
start "" wscript.exe "%~dp0windows\stop-app.vbs"
