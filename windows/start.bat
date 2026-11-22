@echo off
rem Visible run: use this the first time (to scan the WhatsApp QR) and for debugging.
chcp 65001 >nul
cd /d "%~dp0.."
node src\index.js
pause
