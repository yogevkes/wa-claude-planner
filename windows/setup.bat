@echo off
rem One-click setup: checks Node.js and Claude Code, installs packages, creates config, connects Google.
chcp 65001 >nul
cd /d "%~dp0.."
echo === WA-Claude Planner setup ===
set MISSING=0
where node >nul 2>&1 && (for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v) || (echo [X] Node.js not found - install the LTS version from https://nodejs.org & set MISSING=1)
(where claude >nul 2>&1 || if exist "%USERPROFILE%\.local\bin\claude.exe" ver >nul) && (echo [OK] Claude Code found) || (echo [X] Claude Code not found - in PowerShell run:  irm https://claude.ai/install.ps1 ^| iex   then run "claude" once to log in & set MISSING=1)
if "%MISSING%"=="1" (echo. & echo Install what is missing, close this window, and run setup again. & pause & exit /b 1)
if not exist data mkdir data
if not exist config.json (copy config.example.json config.json >nul & echo [OK] config.json created)
echo.
echo Installing packages...
call npm install --no-fund --no-audit || (echo [X] npm install failed & pause & exit /b 1)
echo [OK] Packages installed
echo.
if exist data\google-credentials.json (
  if not exist data\google-token.json (
    echo Connecting Google Calendar - a browser window will open...
    call npm run google-auth
  ) else echo [OK] Google Calendar already connected
) else (
  echo [!] Missing data\google-credentials.json - create the OAuth Desktop client in Google Cloud ^(see README^), save it there, and run setup again.
)
echo.
echo Next: run windows\start.bat and scan the WhatsApp QR code.
pause
