@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-qwen-stack.ps1"
set EXITCODE=%ERRORLEVEL%
echo.
echo scripts\start-qwen-stack.cmd exited with code %EXITCODE%.
if not "%EXITCODE%"=="0" (
  echo Press any key to close this window...
  pause >nul
)
exit /b %EXITCODE%
