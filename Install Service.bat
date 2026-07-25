@echo off
title Install Server Dashboard Service
cd /d "%~dp0"

REM ============================================================
REM  Installs the dashboard as a Windows service via NSSM. After
REM  this it starts at boot, runs with no window, and never needs
REM  a UAC prompt.
REM
REM  Get NSSM from https://nssm.cc/ and either put nssm.exe on
REM  your PATH or set NSSM below to its full path.
REM ============================================================

set SERVICE=ServerDashboard
set NSSM=nssm.exe

REM %~dp0 ends with a backslash, which would escape the closing quote and bake a
REM stray " into any quoted argument. Strip it before using it as a path.
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "config.json" (
    echo ERROR: no config.json. Copy config.example.json to config.json first.
    pause
    exit /b 1
)

where %NSSM% >nul 2>&1
if %errorlevel% neq 0 (
    if not exist "%NSSM%" (
        echo ERROR: NSSM not found.
        echo.
        echo Download it from https://nssm.cc/ and either put nssm.exe on your PATH,
        echo or edit this file and set NSSM to its full path, for example:
        echo     set NSSM=C:\Apps\nssm\nssm.exe
        pause
        exit /b 1
    )
)

for /f "delims=" %%n in ('where node') do set NODEEXE=%%n
if "%NODEEXE%"=="" (
    echo ERROR: node.exe not found on PATH.
    pause
    exit /b 1
)
echo Using node: %NODEEXE%

set PORT=8770
for /f "delims=" %%p in ('node -p "JSON.parse(require('node:fs').readFileSync('config.json','utf8')).port ?? 8770" 2^>nul') do set PORT=%%p
echo Using port: %PORT%

REM Stop any console instance still holding the port.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo Stopping running instance ^(PID %%p^)...
    taskkill /F /PID %%p >nul 2>&1
)

sc query %SERVICE% >nul 2>&1
if %errorlevel% equ 0 (
    echo Service already exists - reinstalling...
    "%NSSM%" stop %SERVICE% >nul 2>&1
    "%NSSM%" remove %SERVICE% confirm >nul 2>&1
    timeout /t 2 /nobreak >nul
)

echo Installing service "%SERVICE%"...
"%NSSM%" install %SERVICE% "%NODEEXE%" "server.js"
"%NSSM%" set %SERVICE% AppDirectory "%APPDIR%"
"%NSSM%" set %SERVICE% DisplayName "Server Dashboard"
"%NSSM%" set %SERVICE% Description "Monitors and controls game servers and Windows services on port %PORT%."
"%NSSM%" set %SERVICE% Start SERVICE_AUTO_START
"%NSSM%" set %SERVICE% AppStdout "%APPDIR%\data\service-out.log"
"%NSSM%" set %SERVICE% AppStderr "%APPDIR%\data\service-err.log"
"%NSSM%" set %SERVICE% AppRotateFiles 1
"%NSSM%" set %SERVICE% AppRotateBytes 5242880

REM LocalSystem so it can stop and start elevated servers and services, and so
REM backups of a running server can use robocopy's backup mode.
"%NSSM%" set %SERVICE% ObjectName LocalSystem

echo.
echo Starting service...
"%NSSM%" start %SERVICE%

timeout /t 6 /nobreak >nul
echo.
sc query %SERVICE% | findstr /i "STATE"
echo.

REM Don't just trust the service state - confirm it actually answers. A 401 is a
REM success here: it means the dashboard is up and asking for a login.
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/status' -TimeoutSec 8 -UseBasicParsing; if ($r.StatusCode -eq 200) { Write-Host 'VERIFIED: dashboard is responding on port %PORT%.' -ForegroundColor Green; exit 0 } } catch { if ($_.Exception.Response.StatusCode.value__ -eq 401) { Write-Host 'VERIFIED: dashboard is responding on port %PORT% (login required).' -ForegroundColor Green; exit 0 } }; Write-Host 'FAILED: service did not come up. Check data\service-err.log' -ForegroundColor Red; exit 1"

if %errorlevel% neq 0 (
    echo.
    echo --- last lines of service-err.log ---
    powershell -NoProfile -Command "Get-Content '%APPDIR%\data\service-err.log' -Tail 15 -ErrorAction SilentlyContinue"
    echo.
    pause
    exit /b 1
)

echo.
echo Done. Dashboard runs at http://localhost:%PORT% with no window,
echo and starts automatically at boot.
echo.
echo To remove it later, run "Uninstall Service.bat".
echo.
pause
