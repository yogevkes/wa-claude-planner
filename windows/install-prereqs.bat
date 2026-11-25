@echo off
rem Installs Node.js LTS and Claude Code if they are missing.
rem Node.js: winget first; if that fails, install-node.ps1 downloads the official MSI from nodejs.org
rem (SHA256-verified) and writes a full installer log to data\logs\node-install.log.
chcp 65001 >nul
cd /d "%~dp0.."
set FAIL=0
echo === Installing prerequisites ===
call :hasnode && (echo [OK] Node.js already installed) || (
  echo Installing Node.js LTS - approve the Windows permission prompt if it appears...
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  call :hasnode || (
    echo winget did not install Node.js - trying the official installer from nodejs.org...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
    call :hasnode || (echo [X] Node.js was not installed - details in data\logs\node-install.log & set FAIL=1)
  )
)
where claude >nul 2>&1 && (echo [OK] Claude Code already installed) || (
  if exist "%USERPROFILE%\.local\bin\claude.exe" (echo [OK] Claude Code already installed) else (
    echo Installing Claude Code...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
  )
)
set HASCLAUDE=0
where claude >nul 2>&1 && set HASCLAUDE=1
if exist "%USERPROFILE%\.local\bin\claude.exe" set HASCLAUDE=1
if "%HASCLAUDE%"=="0" (echo [X] Claude Code was not installed & set FAIL=1)
echo.
if "%FAIL%"=="1" (echo Something above failed - fix it and run install-prereqs.bat again. & pause & exit /b 1)
if exist "%USERPROFILE%\.local\bin\claude.exe" (
  echo Opening Claude Code in a new window - log in there once, then close it.
  start "Claude Code login" cmd /k ""%USERPROFILE%\.local\bin\claude.exe""
)
echo.
echo Done. Close this window and run setup.bat.
pause
exit /b 0

:hasnode
where node >nul 2>&1 && exit /b 0
if exist "%ProgramFiles%\nodejs\node.exe" exit /b 0
exit /b 1
