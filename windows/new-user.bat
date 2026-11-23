@echo off
rem Guided setup of an additional person (own WhatsApp, Google Calendar and Claude subscription).
rem Usage: new-user.bat roni   (or just double-click and type a name)
chcp 65001 >nul
cd /d "%~dp0.."
set "INST=%~1"
if "%INST%"=="" set /p INST=Short English name for the new user (e.g. roni): 
if "%INST%"=="" exit /b 1
if /i "%INST%"=="default" (echo "default" is reserved for the main user. & pause & exit /b 1)

echo.
echo ===== Step 0/5: create the folders =====
node scripts\init-instance.js --instance %INST% || (echo Invalid name - use English letters/digits only. & pause & exit /b 1)
echo.
echo ===== Step 1/5: Claude login =====
echo A Claude window opens. Log in with %INST%'s OWN Claude account, then type /exit.
pause
call "%~dp0claude-login.bat" %INST%
echo.
echo ===== Step 2/5: settings =====
echo Notepad opens with %INST%'s settings. Set at least:
echo   groupName   - exact name of %INST%'s WhatsApp group with herself/himself
echo   watchChats  - chats to check hourly, e.g. ["Mom", "Family group"]  (can stay [])
echo   userContext - a few lines about work hours, commute, habits
echo Save and close Notepad to continue.
start /wait notepad "instances\%INST%\config.json"
echo.
echo ===== Step 3/5: Google Calendar =====
echo A browser opens. Sign in with %INST%'s Google account and allow calendar access.
echo (If you see "Google hasn't verified this app": Advanced, then Go to WA Planner.)
pause
node scripts\google-auth.js --instance %INST%
echo.
echo ===== Step 4/5: WhatsApp =====
echo A new window shows a QR code. On %INST%'s phone: WhatsApp - Settings - Linked devices - Link a device.
echo When that window shows "Listening to group", send a test message in the group,
echo wait for the reply, then CLOSE that window and come back here.
pause
start "WhatsApp link - %INST%" cmd /k node src\index.js --instance %INST%
echo.
echo Press a key here after you closed the WhatsApp window...
pause >nul
echo.
echo ===== Step 5/5: start automatically =====
call "%~dp0install-autostart.bat" %INST%
echo.
echo Done! %INST% has an assistant of their own. Logs: instances\%INST%\data\logs\app.log
pause
