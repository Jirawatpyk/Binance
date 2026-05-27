@echo off
REM ============================================================
REM  Install the Binance Translation Bot as a Windows service.
REM  Double-click this file; it will request Administrator rights
REM  (UAC prompt), build the project, then install + start the
REM  service "BinanceTranslationBot".
REM ============================================================

REM --- Self-elevate to Administrator if not already running as admin ---
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

REM --- Run from the folder this .bat lives in (the project root) ---
cd /d "%~dp0"

echo.
echo === Installing BinanceTranslationBot service ===
echo Folder: %cd%
echo.

call npm run service:install

echo.
echo Hardening data\ folder ACLs (cookies.json is a live session token that bypasses 2FA)...
if not exist "%~dp0data" mkdir "%~dp0data"
icacls "%~dp0data" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" >nul 2>&1
if errorlevel 1 (echo   [warn] could not set ACLs on data\ - set them manually) else (echo   data\ restricted to %USERNAME%, SYSTEM, Administrators)

echo.
echo Done. Manage with: Get-Service BinanceTranslationBot
echo Logs: logs\app-*.log
echo.
echo NOTE: the service runs as LocalSystem by default. To run it under a
echo dedicated least-privilege account instead, see the comment block in
echo scripts\install-windows-service.js.
echo.
pause
