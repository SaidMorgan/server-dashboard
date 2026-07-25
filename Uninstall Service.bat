@echo off
title Remove Server Dashboard Service
set SERVICE=ServerDashboard
set NSSM=nssm.exe

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo Stopping and removing %SERVICE%...
"%NSSM%" stop %SERVICE%
"%NSSM%" remove %SERVICE% confirm

echo.
echo Removed. You can still run it manually with "Start Dashboard.bat".
pause
