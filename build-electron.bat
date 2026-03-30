@echo off
setlocal

cd /d "%~dp0"

set CSC_IDENTITY_AUTO_DISCOVERY=false
set PYTHON=python
set npm_config_python=python

if not exist node_modules (
  echo Installing dependencies...
  call npm ci
  if errorlevel 1 goto :fail
) else (
  echo Reusing existing node_modules. Set FORCE_INSTALL=1 to reinstall dependencies.
  if /I "%FORCE_INSTALL%"=="1" (
    echo Reinstalling dependencies...
    call npm ci
    if errorlevel 1 goto :fail
  )
)

echo Building Electron portable executable...
call npm run build:electron
if errorlevel 1 goto :fail

echo Build complete. Output is in the dist folder.
exit /b 0

:fail
echo Build failed.
exit /b 1
