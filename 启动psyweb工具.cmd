@echo off
rem ============================================================
rem  psyweb converter - launcher  (ASCII only + CRLF on purpose)
rem  Why ASCII: cmd.exe reads .bat/.cmd with the console codepage
rem  (GBK on Chinese Windows). A UTF-8 file with Chinese text and
rem  LF-only line endings gets mis-split, and whole lines are then
rem  treated as unknown commands. Keep this file ASCII + CRLF;
rem  all Chinese wording lives in the browser UI (UTF-8 HTML).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   psyweb  -  PsychoPy to single-file HTML
echo ============================================
echo.

set "NODE_EXE="
rem 1) prefer the Node bundled next to this launcher (distribution package)
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
rem 2) otherwise the system Node (development machine)
if not defined NODE_EXE where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "E:\nodejs\node.exe" set "NODE_EXE=E:\nodejs\node.exe"
if not defined NODE_EXE goto noNode

if not exist "src\tool-server.js" goto noSource

echo Node.js : %NODE_EXE%
echo Starting local service, the browser will open automatically...
echo Close this window to stop the tool.
echo.

"%NODE_EXE%" "src\tool-server.js"
echo.
echo [stopped]
goto end

:noNode
echo [ERROR] Node.js not found.
echo         Install the LTS build from: https://nodejs.org
echo         (after installing, close this window and run this file again)
echo.
goto end

:noSource
echo [ERROR] src\tool-server.js not found in:
echo         %CD%
echo         Please run this launcher from the psyweb folder.
echo.

:end
if not "%PSYWEB_NOPAUSE%"=="1" pause
