@echo off
title Server Dashboard
cd /d "%~dp0"

REM Game servers and Windows services usually run elevated, so stopping or
REM restarting them needs admin rights. Monitoring works fine without them, but
REM the Start/Stop/Restart buttons fail with "Access denied". So: self-elevate.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights ^(needed for Start/Stop/Restart^)...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "config.json" (
    echo.
    echo   No config.json found.
    echo.
    echo   Copy config.example.json to config.json and edit it for your servers,
    echo   then copy .env.example to .env and put your passwords there.
    echo.
    pause
    exit /b 1
)

REM Read the port from config.json so this keeps working if you change it.
set PORT=8770
for /f "delims=" %%p in ('node -p "JSON.parse(require('node:fs').readFileSync('config.json','utf8')).port ?? 8770" 2^>nul') do set PORT=%%p

echo Running elevated - server controls enabled.
echo.

REM Free the port if a previous (possibly non-elevated) instance is still up.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo Stopping previous dashboard instance ^(PID %%p^)...
    taskkill /F /PID %%p >nul 2>&1
)

REM Launch the browser via explorer so it opens as YOU, not as administrator.
start "" explorer "http://localhost:%PORT%"

echo Dashboard running on http://localhost:%PORT%
echo Close this window to stop it.
echo.
node server.js

echo.
echo Dashboard stopped.
pause
