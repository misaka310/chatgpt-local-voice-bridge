@echo off
setlocal
echo [compat] start-qwen-stack.cmd is deprecated. Redirecting to start-voice-stack.cmd...
call "%~dp0start-voice-stack.cmd"
exit /b %ERRORLEVEL%
