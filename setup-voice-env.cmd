@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "VENV=%CD%\local-api\.venv"
set "PY=%VENV%\Scripts\python.exe"

echo [1/11] Create local-api\.venv
if not exist "%PY%" (
  py -3 -m venv "%VENV%" || python -m venv "%VENV%" || goto :fail
)

echo [2/11] Upgrade pip tooling
"%PY%" -m pip install --upgrade pip setuptools wheel || goto :fail

echo [3/11] Replace venv launcher with the real Python executables
powershell -NoProfile -Command "$cfg = Get-Content '%VENV%\pyvenv.cfg'; $homeLine = $cfg | Where-Object { $_ -like 'home = *' } | Select-Object -First 1; if (-not $homeLine) { exit 1 }; $home = ($homeLine -replace '^home = ', '').Trim(); Copy-Item (Join-Path $home 'python.exe') '%VENV%\Scripts\python.exe' -Force; if (Test-Path (Join-Path $home 'pythonw.exe')) { Copy-Item (Join-Path $home 'pythonw.exe') '%VENV%\Scripts\pythonw.exe' -Force }" || goto :fail
set "PY=%VENV%\Scripts\python.exe"

echo [4/11] Install NVIDIA CUDA-capable PyTorch packages
"%PY%" -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu128 || goto :fail
"%PY%" -m pip install --upgrade torchcodec || goto :fail

echo [5/11] Download shared FFmpeg runtime for torchcodec
"%PY%" "%CD%\local-api\scripts\ensure_shared_ffmpeg.py" || goto :fail

echo [6/11] Install venv bootstrap for shared FFmpeg DLL loading
"%PY%" "%CD%\local-api\scripts\install_venv_bootstrap.py" || goto :fail

echo [7/11] Install Irodori direct runtime dependencies
"%PY%" -m pip install --upgrade --upgrade-strategy only-if-needed -r "%CD%\local-api\requirements.txt" || goto :fail
rem Upstream Irodori metadata still caps transformers below the security-fixed release.
rem Dependencies are installed above; install the verified pinned Irodori source without re-resolving them.
"%PY%" -m pip install --upgrade --no-deps -r "%CD%\local-api\requirements-irodori.txt" || goto :fail

echo [8/11] Verify CUDA/Torch and runtime imports
"%PY%" "%CD%\local-api\scripts\preflight_irodori.py" --strict-cuda --quick || goto :fail

echo [9/11] Download Irodori model and codec to Hugging Face cache
"%PY%" "%CD%\local-api\scripts\preflight_irodori.py" --strict-cuda || goto :fail

echo [10/11] Create runtime audio directory
if not exist "%CD%\local-api\runtime\audio" mkdir "%CD%\local-api\runtime\audio"

echo [11/11] Setup complete
echo Runtime: irodori_direct
echo Model: irodori-v3
echo Cache: %USERPROFILE%\.cache\huggingface
echo Shared FFmpeg: %CD%\local-api\runtime\ffmpeg-shared\bin
echo Next: run-voice-stack.cmd
exit /b 0

:fail
echo.
echo [FAILED] setup-voice-env.cmd did not complete.
echo Check NVIDIA driver, Python 3.10+, network access to Hugging Face/GitHub, and free disk space.
echo Do not continue to the browser until setup completes.
exit /b 1
