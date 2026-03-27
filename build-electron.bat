@echo off
setlocal

cd /d "%~dp0"

set CSC_IDENTITY_AUTO_DISCOVERY=false

echo Installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo Building Electron portable executable...
call npm run build:electron
if errorlevel 1 goto :fail

echo Build complete. Output is in the dist folder.
exit /b 0

:fail
echo Build failed.
exit /b 1
