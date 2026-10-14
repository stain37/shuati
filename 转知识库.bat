@echo off
chcp 65001 >nul
cd /d "%~dp0"
cls
type "%~dp0usage-kb.txt"
echo.
echo ------------------------------------------------------------
echo [run] python make-kb.py %*
echo ------------------------------------------------------------
echo.
python "make-kb.py" %*
if errorlevel 9009 py -3 "make-kb.py" %*
echo.
echo Done. Press any key to close.
pause >nul
