@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "VENV=%CD%\local-api\.venv"
set "PY=%VENV%\Scripts\python.exe"

echo [1/12] Create local-api\.venv
if not exist "%PY%" (
  py -3 -m venv "%VENV%" || python -m venv "%VENV%" || goto :fail
)

echo [2/12] Upgrade pip tooling
"%PY%" -m pip install --upgrade pip setuptools wheel || goto :fail

echo [3/12] Replace venv launcher with the real Python executables
powershell -NoProfile -Command "$cfg = Get-Content '%VENV%\pyvenv.cfg'; $homeLine = $cfg | Where-Object { $_ -like 'home = *' } | Select-Object -First 1; if (-not $homeLine) { exit 1 }; $home = ($homeLine -replace '^home = ', '').Trim(); Copy-Item (Join-Path $home 'python.exe') '%VENV%\Scripts\python.exe' -Force; if (Test-Path (Join-Path $home 'pythonw.exe')) { Copy-Item (Join-Path $home 'pythonw.exe') '%VENV%\Scripts\pythonw.exe' -Force }" || goto :fail
set "PY=%VENV%\Scripts\python.exe"

echo [4/12] Install NVIDIA CUDA-capable PyTorch packages
"%PY%" -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu128 || goto :fail
"%PY%" -m pip install --upgrade torchcodec || goto :fail

echo [5/12] Download shared FFmpeg runtime for torchcodec
"%PY%" "%CD%\local-api\scripts\ensure_shared_ffmpeg.py" || goto :fail

echo [6/12] Install venv bootstrap for shared FFmpeg DLL loading
"%PY%" "%CD%\local-api\scripts\install_venv_bootstrap.py" || goto :fail

echo [7/12] Install Irodori runtime and PySide6 desktop app dependencies
"%PY%" -m pip install --upgrade --upgrade-strategy only-if-needed -r "%CD%\local-api\requirements.txt" || goto :fail
rem Upstream Irodori metadata still caps transformers below the security-fixed release.
rem Dependencies are installed above; install the verified pinned Irodori source without re-resolving them.
"%PY%" -m pip install --upgrade --no-deps -r "%CD%\local-api\requirements-irodori.txt" || goto :fail

echo [8/12] Verify CUDA/Torch and runtime imports
"%PY%" "%CD%\local-api\scripts\preflight_irodori.py" --strict-cuda --quick || goto :fail

echo [9/12] Download Irodori model and codec to Hugging Face cache
"%PY%" "%CD%\local-api\scripts\preflight_irodori.py" --strict-cuda || goto :fail

echo [10/12] Create runtime audio directory
if not exist "%CD%\local-api\runtime\audio" mkdir "%CD%\local-api\runtime\audio"

echo [11/12] Build the small Windows launcher EXE
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\build-launcher.ps1" || goto :fail

echo [12/12] Setup complete
echo Runtime: irodori_direct
echo Model: irodori-v3
echo Cache: %USERPROFILE%\.cache\huggingface
echo Shared FFmpeg: %CD%\local-api\runtime\ffmpeg-shared\bin
echo Next: double-click ChatGPTLocalVoiceBridge.exe
exit /b 0

:fail
echo.
echo [FAILED] setup-voice-env.cmd did not complete.
echo Check NVIDIA driver, Python 3.10+, network access to Hugging Face/GitHub, and free disk space.
echo Do not continue to the browser until setup completes.
exit /b 1
