@echo off
rem Log in to a separate Claude account for an instance.  Usage: claude-login.bat roni
chcp 65001 >nul
set "INST=%~1"
if "%INST%"=="" (echo Usage: claude-login.bat ^<instance^> & pause & exit /b 1)
set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-%INST%"
set "CLAUDE_EXE=claude"
where claude >nul 2>&1 || set "CLAUDE_EXE=%USERPROFILE%\.local\bin\claude.exe"
echo Opening Claude Code for "%INST%" (settings in %CLAUDE_CONFIG_DIR%).
echo Log in with THAT person's Claude account. When you see the Claude prompt, type /exit
echo.
"%CLAUDE_EXE%"
