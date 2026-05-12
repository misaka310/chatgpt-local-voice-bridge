@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-voice-stack.ps1"
set EXITCODE=%ERRORLEVEL%
echo.
echo Voice stack launcher exited with code %EXITCODE%.
if not "%EXITCODE%"=="0" (
  echo Press any key to close this window...
  pause >nul
) else (
  pause
)
exit /b %EXITCODE%
