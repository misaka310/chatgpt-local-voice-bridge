$ErrorActionPreference = "Stop"
$LocalApiPort = 8717

$Root = Split-Path -Parent $PSScriptRoot
$LocalApiDir = Join-Path $Root "local-api"
$RuntimeDir = Join-Path $LocalApiDir "runtime"
$ServerPath = Join-Path $LocalApiDir "server.py"
$VenvPythonPath = Join-Path $LocalApiDir ".venv\Scripts\python.exe"

if (!(Test-Path -LiteralPath $ServerPath)) {
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
    $netstatCmd = Get-Command netstat -ErrorAction SilentlyContinue
    if ($null -eq $netstatCmd) {
      $systemNetstat = Join-Path $env:WINDIR "System32\netstat.exe"
      if (Test-Path -LiteralPath $systemNetstat) {
        $netstatCmd = [pscustomobject]@{ Source = $systemNetstat }
      }
    }

    if ($null -ne $netstatCmd) {
      try {
        $netstatExe = $netstatCmd.Source
        $netstat = & $netstatExe -ano -p tcp | Select-String -Pattern (":{0}\s+" -f $Port)
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
      } catch {
        $pids = @()
      }
    }
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

Write-Host "ChatGPT Local Voice Bridge"
Write-Host ("Repo root: {0}" -f $Root)
Write-Host ("Local API: {0}" -f $LocalApiDir)
Write-Host ("Preparing port {0}..." -f $LocalApiPort)
Stop-PortOwners -Port $LocalApiPort

$env:LOCAL_VOICE_PORT = "$LocalApiPort"
$env:LOCAL_VOICE_PUBLIC_BASE_URL = "http://127.0.0.1:$LocalApiPort"

if (Test-Path -LiteralPath $VenvPythonPath) {
  $pythonCmd = $VenvPythonPath
} else {
  throw "venv python not found: $VenvPythonPath. Run setup-qwen-env.cmd first."
}

Write-Host ("Using Python: {0}" -f $pythonCmd)
Write-Host ("Local API URL: http://127.0.0.1:{0}" -f $LocalApiPort)
Write-Host ("Health URL: http://127.0.0.1:{0}/health" -f $LocalApiPort)

$PreflightScript = Join-Path $LocalApiDir "scripts\preflight_qwen.py"
if (!(Test-Path -LiteralPath $PreflightScript)) {
  throw "preflight_qwen.py not found. Run setup-qwen-env.cmd first."
}

Write-Host ""
Write-Host "Checking Qwen/Torch/model-cache preflight..."
& $pythonCmd -u $PreflightScript --strict --check-cache
$preflightExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
if ($preflightExitCode -ne 0) {
  throw "Qwen preflight failed. Run setup-qwen-env.cmd first."
}

Write-Host ""
Write-Host "Preflight OK. Model files are cached, but the model is not loaded yet."
Write-Host "First /v1/speak loads the model into GPU memory and may take longer than later calls."
Write-Host "Keep this window open while using the extension. Close it to stop the Local API."
Write-Host ""

Set-Location $LocalApiDir
& $pythonCmd .\server.py
