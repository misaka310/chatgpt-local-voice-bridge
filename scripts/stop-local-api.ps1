$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$LocalApiDir = Join-Path $Root "local-api"
$RuntimeDir = Join-Path $LocalApiDir "runtime"
$PidFile = Join-Path $RuntimeDir "local-api.pid"

$stopped = $false

if (Test-Path $PidFile) {
  $pidText = Get-Content -Raw $PidFile
  $procId = 0
  if ([int]::TryParse($pidText.Trim(), [ref]$procId) -and $procId -gt 0) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $procId -Force
      Write-Host "Stopped Local API by PID file: $procId"
      $stopped = $true
    }
  }
  Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
}

$fallback = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like "*local-api*server.py*" -or $_.CommandLine -like "*17_chatgpt-local-voice-bridge*server.py*"
}

foreach ($proc in $fallback) {
  try {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped Local API process: $($proc.ProcessId)"
    $stopped = $true
  } catch {}
}

if (-not $stopped) {
  Write-Host "No running Local API process was found."
}
