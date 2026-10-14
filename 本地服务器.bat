@echo off
chcp 65001 >nul
cd /d "%~dp0"
cls
type "%~dp0usage-server.txt"
echo.
echo ------------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo [X] This computer has no Python.
    echo     You can still use the site: double-click index.html
    echo     ^(all quiz features work; only offline/PWA install and big
    echo      knowledge-base storage need this server.^)
    echo.
    start "" "%~dp0index.html"
    echo Opened index.html instead. Press any key to close.
    pause >nul
    exit /b 0
  )
)
echo Starting local server at http://localhost:5173/
echo Keep this window open. Close it to stop the server.
echo ------------------------------------------------------------
echo.
start "" "http://localhost:5173/"
python -m http.server 5173
if errorlevel 1 (
  echo No python found, trying py launcher...
  py -3 -m http.server 5173
)
echo.
echo Server stopped. Press any key to close.
pause >nul
