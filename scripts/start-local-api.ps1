param(
  [switch]$Background
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$LocalApiDir = Join-Path $Root "local-api"
$RuntimeDir = Join-Path $LocalApiDir "runtime"
$PidFile = Join-Path $RuntimeDir "local-api.pid"
$ServerPath = Join-Path $LocalApiDir "server.py"

if (!(Test-Path $ServerPath)) {
  throw "server.py が見つかりません: $ServerPath"
}

New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "audio") | Out-Null

if ($Background) {
  $pythonCmd = (Get-Command python -ErrorAction Stop).Source
  $proc = Start-Process -FilePath $pythonCmd -ArgumentList @($ServerPath) -WorkingDirectory $LocalApiDir -PassThru -WindowStyle Hidden
  $proc.Id | Set-Content -Encoding ASCII $PidFile
  Write-Host "Local API started in background (PID=$($proc.Id))"
  Write-Host "Health: http://127.0.0.1:8765/health"
  exit 0
}

Set-Location $LocalApiDir
python .\server.py
