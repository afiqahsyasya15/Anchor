@echo off
setlocal
cd /d "%~dp0"
title Anchor - local preview

echo.
echo   ==========================================
echo    Anchor - local preview server
echo   ==========================================
echo.
echo   Folder: %CD%
echo.

rem Each check RUNS the tool rather than just looking for it on PATH.
rem Windows ships fake "python.exe" and "py.exe" shortcuts that only open the
rem Microsoft Store, and those look real to a PATH lookup.

rem --- Node.js: preferred, because serve.mjs ships with this folder ----------
node --version >nul 2>&1
if not errorlevel 1 goto usenode

rem --- Python launcher ------------------------------------------------------
py --version >nul 2>&1
if not errorlevel 1 goto usepy

rem --- Bare python ----------------------------------------------------------
python --version >nul 2>&1
if not errorlevel 1 goto usepython

goto nothingfound


:usenode
for /f "delims=" %%v in ('node --version') do echo   Found Node.js %%v
echo   Starting the bundled server on port 5173...
echo.
echo   ^>^>  Open:  http://localhost:5173
echo.
echo   KEEP THIS WINDOW OPEN while you use the app.
echo.
node serve.mjs 5173
goto ended


:usepy
for /f "delims=" %%v in ('py --version') do echo   Found %%v
echo   Starting the Python server on port 5173...
echo.
echo   ^>^>  Open:  http://localhost:5173
echo.
echo   KEEP THIS WINDOW OPEN while you use the app.
echo.
py -m http.server 5173
goto ended


:usepython
for /f "delims=" %%v in ('python --version') do echo   Found %%v
echo   Starting the Python server on port 5173...
echo.
echo   ^>^>  Open:  http://localhost:5173
echo.
echo   KEEP THIS WINDOW OPEN while you use the app.
echo.
python -m http.server 5173
goto ended


:nothingfound
echo   Neither Node.js nor Python is installed on this computer.
echo   (Windows has placeholder shortcuts for python that only open the
echo    Microsoft Store - those do not count.)
echo.
echo   TWO WAYS FORWARD, pick either:
echo.
echo   A) VS Code - you already have it, no command line needed
echo      1. Open VS Code
echo      2. File ^> Open Folder ^> select this ptaa-app folder
echo      3. Extensions icon on the left ^> search "Live Server"
echo         ^> install the one by Ritwick Dey
echo      4. Right-click index.html ^> "Open with Live Server"
echo      It opens on port 5500. That is fine - Firebase accepts
echo      localhost on any port.
echo.
echo   B) Install Node.js from https://nodejs.org (the LTS button),
echo      then double-click this file again.
echo.
echo   Or skip local preview entirely and deploy to Cloudflare Pages
echo   (step 8 in README.md) - the app works the same there.
echo.
pause
goto :eof


:ended
echo.
echo   Server stopped.
pause
