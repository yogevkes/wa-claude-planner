@echo off
rem Installs Node.js LTS (winget) and Claude Code (official installer) if they are missing.
chcp 65001 >nul
echo === Installing prerequisites ===
where node >nul 2>&1 && (echo [OK] Node.js already installed) || (
  echo Installing Node.js LTS - approve the Windows permission prompt if it appears...
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
)
where claude >nul 2>&1 && (echo [OK] Claude Code already installed) || (
  if exist "%USERPROFILE%\.local\bin\claude.exe" (echo [OK] Claude Code already installed) else (
    echo Installing Claude Code...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
  )
)
echo.
if exist "%USERPROFILE%\.local\bin\claude.exe" (
  echo Opening Claude Code in a new window - log in there once, then close it.
  start "Claude Code login" cmd /k ""%USERPROFILE%\.local\bin\claude.exe""
)
echo.
echo Done. Close this window and run setup.bat again.
pause
