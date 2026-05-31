@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

where bash >nul 2>nul
if errorlevel 1 (
  echo ERROR: bash is required to run the KimiBuilt Suite compose installer on Windows.
  echo Install Git for Windows or use WSL, then rerun this command.
  exit /b 1
)

bash "%SCRIPT_DIR%install-compose.sh" %*
