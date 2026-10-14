@echo off
chcp 65001 >nul
cd /d "%~dp0"
cls
type "%~dp0usage-phone.txt"
echo.
echo ------------------------------------------------------------
echo Your IPv4 address(es) - use the one your phone can reach:
ipconfig | findstr /i "IPv4"
echo ------------------------------------------------------------
echo.
where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo [X] This computer has no Python.
    echo     Install Python ^(python.org, tick "Add python.exe to PATH"^) and run this again.
    echo     Or copy the whole folder to the phone and open index.html there.
    echo.
    pause >nul
    exit /b 0
  )
)
echo Starting server on all network interfaces, port 8080 ...
echo Keep this window open. Press Ctrl+C to stop.
echo ------------------------------------------------------------
echo.
python -m http.server 8080 --bind 0.0.0.0
if errorlevel 9009 py -3 -m http.server 8080 --bind 0.0.0.0
echo.
echo Server stopped. Press any key to close.
pause >nul
