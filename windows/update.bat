@echo off
rem Updates the code from GitHub. Keeps config.json, data\ and instances\ untouched.
chcp 65001 >nul
cd /d "%~dp0.."
set "ROOT=%CD%"
set "TMPDIR=%TEMP%\wa-claude-update"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
echo Downloading the latest version...
curl -L -s -o "%TMPDIR%\main.zip" https://github.com/yogevkes/wa-claude-planner/archive/refs/heads/main.zip || (echo Download failed & pause & exit /b 1)
tar -xf "%TMPDIR%\main.zip" -C "%TMPDIR%" || (echo Extract failed & pause & exit /b 1)
robocopy "%TMPDIR%\wa-claude-planner-main" "%ROOT%" /E /XD data instances node_modules .git /XF config.json /NFL /NDL /NJH /NJS /NP
if %ERRORLEVEL% GEQ 8 (echo Copy failed & pause & exit /b 1)
call npm install --no-fund --no-audit
echo.
echo Updated. Restart the bot(s) to use the new version: reboot, or stop.ps1 -All and start again.
pause
