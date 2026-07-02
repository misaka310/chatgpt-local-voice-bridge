@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "VENV=%CD%\local-api\.venv"
set "PY=%VENV%\Scripts\python.exe"

echo [1/8] Create local-api\.venv
if not exist "%PY%" (
  py -3 -m venv "%VENV%" || python -m venv "%VENV%" || goto :fail
)

echo [2/8] Upgrade pip tooling
"%PY%" -m pip install --upgrade pip setuptools wheel || goto :fail

echo [3/8] Install NVIDIA CUDA-capable PyTorch packages
"%PY%" -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu128 || goto :fail
"%PY%" -m pip install --upgrade torchcodec || goto :fail

echo [4/8] Install Irodori direct runtime dependencies
"%PY%" -m pip install --upgrade -r "%CD%\local-api\requirements.txt" || goto :fail

echo [5/8] Verify CUDA/Torch
"%PY%" "%CD%\local-api\scripts\preflight_irodori.py" --strict-cuda --quick || goto :fail

echo [6/8] Download Irodori model and codec to Hugging Face cache
"%PY%" "%CD%\local-api\scripts\preflight_irodori.py" --strict-cuda || goto :fail

echo [7/8] Create runtime audio directory
if not exist "%CD%\local-api\runtime\audio" mkdir "%CD%\local-api\runtime\audio"

echo [8/8] Setup complete
echo Runtime: irodori_direct
echo Model: irodori-v3
echo Cache: %USERPROFILE%\.cache\huggingface
echo Next: run-voice-stack.cmd
exit /b 0

:fail
echo.
echo [FAILED] setup-voice-env.cmd did not complete.
echo Check NVIDIA driver, Python 3.10+, network access to Hugging Face/GitHub, and free disk space.
echo Do not continue to the browser until setup completes.
exit /b 1
