@echo off
setlocal

cd /d "%~dp0"

set CSC_IDENTITY_AUTO_DISCOVERY=false
set PYTHON=python
set npm_config_python=python

if exist node_modules\duckdb\build (
  echo Cleaning stale DuckDB build folder...
  rmdir /s /q node_modules\duckdb\build
)

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
