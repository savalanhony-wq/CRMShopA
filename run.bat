@echo off
chcp 65001 >nul
if /i "%~1"=="loop" goto loop
title Asalac CRM
cd /d "%~dp0"

echo [1/4] Checking Node.js ...
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Installing with winget - internet required...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Could not install Node.js automatically.
  echo Please install it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)

echo [2/4] Checking libraries ...
if not exist xlsx.full.min.js (
  echo Downloading Excel library ...
  powershell -NoProfile -Command "try{Invoke-WebRequest 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js' -OutFile 'xlsx.full.min.js'}catch{Write-Host 'Download failed - check internet and run again.'}"
)
if not exist qrcode.js (
  echo Downloading QR library ...
  powershell -NoProfile -Command "try{Invoke-WebRequest 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js' -OutFile 'qrcode.js'}catch{Write-Host 'Download failed - check internet and run again.'}"
)

echo [3/4] Starting server ...
start "Asalac CRM Server" /min cmd /c ""%~f0" loop"
timeout /t 2 /nobreak >nul

echo [4/4] Opening your default browser ...
start "" "http://localhost:3000"
exit /b 0

:loop
title Asalac CRM Server
cd /d "%~dp0"
rem Keeps the server alive: restarts it if it stops with an error. Close this window to stop it.
:again
rem LAN=1 lets phones on the same Wi-Fi open the app (login is still required). Remove this line to allow this computer only.
set LAN=1
node server.js
if errorlevel 1 (
  echo [%date% %time%] Server stopped unexpectedly - restarting in 2 seconds ...
  timeout /t 2 /nobreak >nul
  goto again
)
exit /b 0
