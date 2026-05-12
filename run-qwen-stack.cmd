@echo off
setlocal
echo [compat] run-qwen-stack.cmd is deprecated. Redirecting to run-voice-stack.cmd...
call "%~dp0run-voice-stack.cmd"
exit /b %ERRORLEVEL%
