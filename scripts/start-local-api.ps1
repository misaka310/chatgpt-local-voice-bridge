param(
  [switch]$Background
)

$ErrorActionPreference = "Stop"
$LocalApiPort = 8717

$Root = Split-Path -Parent $PSScriptRoot
$LocalApiDir = Join-Path $Root "local-api"
$RuntimeDir = Join-Path $LocalApiDir "runtime"
$PidFile = Join-Path $RuntimeDir "local-api.pid"
$ServerPath = Join-Path $LocalApiDir "server.py"

if (!(Test-Path $ServerPath)) {
  throw "server.py not found: $ServerPath"
}

function Get-PortOwnerProcessIds {
  param(
    [Parameter(Mandatory = $true)][int]$Port
  )

  $pids = @()
  try {
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $pids = @()
  }

  if (-not $pids -or $pids.Count -eq 0) {
    $netstat = netstat -ano -p tcp | Select-String -Pattern (":{0}\s+" -f $Port)
    $pids = @(
      $netstat |
      ForEach-Object {
        $line = ($_ -replace "^\s+", "") -replace "\s+", " "
        $parts = $line.Split(" ")
        if ($parts.Count -ge 5) {
          [int]$parts[4]
        }
      } |
      Where-Object { $_ -gt 0 } |
      Select-Object -Unique
    )
  }

  return @($pids | Where-Object { $_ -gt 0 -and $_ -ne $PID } | Select-Object -Unique)
}

function Stop-PortOwners {
  param(
    [Parameter(Mandatory = $true)][int]$Port
  )

  $ownerPids = Get-PortOwnerProcessIds -Port $Port
  if (-not $ownerPids -or $ownerPids.Count -eq 0) {
    Write-Host ("Port {0} is free." -f $Port)
    return
  }

  foreach ($ownerPid in $ownerPids) {
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
      continue
    }
    Stop-Process -Id $ownerPid -Force -ErrorAction Stop
    Write-Host ("Stopped process on port {0}: PID={1} Name={2}" -f $Port, $ownerPid, $proc.ProcessName)
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "audio") | Out-Null
Stop-PortOwners -Port $LocalApiPort

$env:LOCAL_VOICE_PORT = "$LocalApiPort"
$env:LOCAL_VOICE_PUBLIC_BASE_URL = "http://127.0.0.1:$LocalApiPort"

if ($Background) {
  $pythonCmd = (Get-Command python -ErrorAction Stop).Source
  $proc = Start-Process -FilePath $pythonCmd -ArgumentList @($ServerPath) -WorkingDirectory $LocalApiDir -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if (-not $alive) {
    throw "Local API failed to stay running. Run .\\scripts\\start-local-api.ps1 without -Background to see the error."
  }
  $proc.Id | Set-Content -Encoding ASCII $PidFile
  Write-Host "Local API started in background (PID=$($proc.Id))"
  Write-Host "Health: http://127.0.0.1:$LocalApiPort/health"
  exit 0
}

Set-Location $LocalApiDir
python .\server.py
