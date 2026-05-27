@echo off
REM ============================================================
REM  Remove the Binance Translation Bot Windows service.
REM  Double-click this file; it will request Administrator rights
REM  (UAC prompt), then stop + uninstall "BinanceTranslationBot".
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
echo === Uninstalling BinanceTranslationBot service ===
echo Folder: %cd%
echo.

call npm run service:uninstall

echo.
echo Done.
echo.
pause
