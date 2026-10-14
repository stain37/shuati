@echo off
rem Open the site in an Edge/Chrome "app window": no address bar, no tabs - looks like a desktop app.
rem Your records stay in the same browser profile, so they are the same as when you open index.html normally.
setlocal
cd /d "%~dp0"
set "P=%~dp0index.html"
set "P=%P:\=/%"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE="
if defined EDGE goto useedge
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME="
if defined CHROME goto usechrome
echo [i] Edge / Chrome not found - opening in the default browser instead.
start "" "%~dp0index.html"
exit /b 0
:useedge
start "" "%EDGE%" --app="file:///%P%"
exit /b 0
:usechrome
start "" "%CHROME%" --app="file:///%P%"
exit /b 0
