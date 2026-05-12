[CmdletBinding()]
param(
  [string]$ComfyRunBat = "D:\ComfyUI_TTS_E2E_SANDBOX\start_comfyui_tts_sandbox.bat",
  [string]$ComfyBaseUrl = "http://127.0.0.1:8288",
  [string]$LocalApiBaseUrl = "http://127.0.0.1:8765",
  [int]$ComfyStartupTimeoutSec = 240,
  [int]$LocalApiStartupTimeoutSec = 90
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$LocalApiDir = Join-Path $RootDir "local-api"
$RuntimeDir = Join-Path $LocalApiDir "runtime"
$LogsDir = Join-Path $RuntimeDir "logs"
$ServerPath = Join-Path $LocalApiDir "server.py"
$StackStatePath = Join-Path $RuntimeDir "voice-stack.json"

$script:StartedComfyProcess = $null
$script:StartedLocalApiProcess = $null
$script:WatchdogProcess = $null
$script:CleanupDone = $false
$script:ComfyWasAlreadyRunning = $false
$script:LocalApiWasAlreadyRunning = $false

function New-LogFilePath {
  param(
    [Parameter(Mandatory = $true)][string]$Prefix
  )

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  return (Join-Path $LogsDir ("{0}-{1}.log" -f $Prefix, $timestamp))
}

function Test-HttpOk {
  param(
    [Parameter(Mandatory = $true)][string]$Url
  )

  try {
    $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Wait-HttpOk {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutSec = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk -Url $Url) {
      Write-Host ("{0} is ready: {1}" -f $Name, $Url)
      return
    }
    Start-Sleep -Seconds 2
  }

  throw ("{0} did not become ready within {1} seconds: {2}" -f $Name, $TimeoutSec, $Url)
}

function Get-ProcessSafe {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId
  )

  return (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$TargetProcessId
  )

  if ($TargetProcessId -le 0) {
    return
  }

  $children = Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $TargetProcessId) -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -TargetProcessId ([int]$child.ProcessId)
  }

  $proc = Get-ProcessSafe -ProcessId $TargetProcessId
  if ($null -ne $proc) {
    try {
      Stop-Process -Id $TargetProcessId -Force -ErrorAction Stop
      Write-Host ("Stopped process tree PID={0}" -f $TargetProcessId)
    } catch {
      Write-Warning ("Failed to stop PID=${TargetProcessId}: {0}" -f $_.Exception.Message)
    }
  }
}

function Save-StackState {
  $state = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    ownerPid = $PID
    comfyBaseUrl = $ComfyBaseUrl
    localApiBaseUrl = $LocalApiBaseUrl
    comfyWasAlreadyRunning = $script:ComfyWasAlreadyRunning
    localApiWasAlreadyRunning = $script:LocalApiWasAlreadyRunning
    comfyStartedByThisScript = [bool]($null -ne $script:StartedComfyProcess)
    localApiStartedByThisScript = [bool]($null -ne $script:StartedLocalApiProcess)
    comfyPid = if ($null -ne $script:StartedComfyProcess) { [int]$script:StartedComfyProcess.Id } else { $null }
    localApiPid = if ($null -ne $script:StartedLocalApiProcess) { [int]$script:StartedLocalApiProcess.Id } else { $null }
    watchdogPid = if ($null -ne $script:WatchdogProcess) { [int]$script:WatchdogProcess.Id } else { $null }
  }

  $json = $state | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($StackStatePath, $json, [System.Text.Encoding]::UTF8)
}

function Start-Watchdog {
  $comfyPid = if ($null -ne $script:StartedComfyProcess) { [int]$script:StartedComfyProcess.Id } else { 0 }
  $localApiPid = if ($null -ne $script:StartedLocalApiProcess) { [int]$script:StartedLocalApiProcess.Id } else { 0 }

  if ($comfyPid -le 0 -and $localApiPid -le 0) {
    return
  }

  $escapedStatePath = $StackStatePath.Replace("'", "''")
  $ownerPid = $PID

  $watchdogScript = @"
`$ErrorActionPreference = 'SilentlyContinue'
function Stop-Tree {
  param([int]`$TargetProcessId)
  if (`$TargetProcessId -le 0) { return }
  `$children = Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f `$TargetProcessId) -ErrorAction SilentlyContinue
  foreach (`$child in `$children) {
    Stop-Tree -TargetProcessId ([int]`$child.ProcessId)
  }
  `$proc = Get-Process -Id `$TargetProcessId -ErrorAction SilentlyContinue
  if (`$null -ne `$proc) {
    Stop-Process -Id `$TargetProcessId -Force -ErrorAction SilentlyContinue
  }
}

`$ownerPid = $ownerPid
`$comfyPid = $comfyPid
`$localApiPid = $localApiPid
`$statePath = '$escapedStatePath'

while (`$true) {
  `$owner = Get-Process -Id `$ownerPid -ErrorAction SilentlyContinue
  if (`$null -eq `$owner) {
    Stop-Tree -TargetProcessId `$localApiPid
    Stop-Tree -TargetProcessId `$comfyPid
    Remove-Item -LiteralPath `$statePath -Force -ErrorAction SilentlyContinue
    exit 0
  }
  Start-Sleep -Seconds 2
}
"@

  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchdogScript))
  $script:WatchdogProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
    -WindowStyle Hidden `
    -PassThru
}

function Stop-StartedProcesses {
  if ($script:CleanupDone) {
    return
  }
  $script:CleanupDone = $true

  Write-Host "Stopping voice stack processes started by this script..."

  if ($null -ne $script:StartedLocalApiProcess) {
    Stop-ProcessTree -TargetProcessId ([int]$script:StartedLocalApiProcess.Id)
  }

  if ($null -ne $script:StartedComfyProcess) {
    Stop-ProcessTree -TargetProcessId ([int]$script:StartedComfyProcess.Id)
  }

  if ($null -ne $script:WatchdogProcess) {
    Stop-Process -Id $script:WatchdogProcess.Id -Force -ErrorAction SilentlyContinue
  }

  Remove-Item -LiteralPath $StackStatePath -Force -ErrorAction SilentlyContinue
}

function Assert-HealthEngine {
  param(
    [Parameter(Mandatory = $true)][string]$HealthUrl
  )

  $health = Invoke-RestMethod -Uri $HealthUrl -Method GET -TimeoutSec 5
  if (-not $health.ok) {
    throw ("local-api health returned ok=false: {0}" -f $HealthUrl)
  }
  if ($health.engine -ne "comfyui_workflow") {
    throw ("local-api engine must be comfyui_workflow but was: {0}" -f $health.engine)
  }
}

$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-StartedProcesses }
$cancelHandler = [ConsoleCancelEventHandler]{
  param($sender, $eventArgs)
  $eventArgs.Cancel = $true
  Stop-StartedProcesses
  exit 130
}
[Console]::add_CancelKeyPress($cancelHandler)

try {
  if (-not (Test-Path -LiteralPath $ComfyRunBat)) {
    throw ("ComfyUI start bat not found: {0}" -f $ComfyRunBat)
  }
  if (-not (Test-Path -LiteralPath $ServerPath)) {
    throw ("local-api server.py not found: {0}" -f $ServerPath)
  }

  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "audio") | Out-Null

  $comfyStatsUrl = "{0}/system_stats" -f $ComfyBaseUrl.TrimEnd("/")
  $localHealthUrl = "{0}/health" -f $LocalApiBaseUrl.TrimEnd("/")

  if (Test-HttpOk -Url $comfyStatsUrl) {
    $script:ComfyWasAlreadyRunning = $true
    Write-Host ("ComfyUI already running: {0}" -f $comfyStatsUrl)
  } else {
    $comfyLog = New-LogFilePath -Prefix "comfyui"
    $comfyRoot = Split-Path -Parent $ComfyRunBat
    $comfyCommand = '""{0}" 1>>"{1}" 2>>&1"' -f $ComfyRunBat, $comfyLog
    Write-Host ("Starting ComfyUI via: {0}" -f $ComfyRunBat)
    Write-Host ("ComfyUI log: {0}" -f $comfyLog)
    $script:StartedComfyProcess = Start-Process `
      -FilePath "cmd.exe" `
      -ArgumentList @("/c", $comfyCommand) `
      -WorkingDirectory $comfyRoot `
      -NoNewWindow `
      -PassThru
    Save-StackState
    Wait-HttpOk -Url $comfyStatsUrl -Name "ComfyUI" -TimeoutSec $ComfyStartupTimeoutSec
  }

  if (Test-HttpOk -Url $localHealthUrl) {
    $script:LocalApiWasAlreadyRunning = $true
    Write-Host ("local-api already running: {0}" -f $localHealthUrl)
  } else {
    $pythonCmd = (Get-Command python -ErrorAction Stop).Source
    $localApiLog = New-LogFilePath -Prefix "local-api"
    $localApiCommand = '""{0}" "{1}" 1>>"{2}" 2>>&1"' -f $pythonCmd, $ServerPath, $localApiLog
    Write-Host ("Starting local-api via python: {0}" -f $ServerPath)
    Write-Host ("local-api log: {0}" -f $localApiLog)
    $script:StartedLocalApiProcess = Start-Process `
      -FilePath "cmd.exe" `
      -ArgumentList @("/c", $localApiCommand) `
      -WorkingDirectory $LocalApiDir `
      -NoNewWindow `
      -PassThru
    Save-StackState
    Wait-HttpOk -Url $localHealthUrl -Name "local-api" -TimeoutSec $LocalApiStartupTimeoutSec
  }

  Assert-HealthEngine -HealthUrl $localHealthUrl
  Start-Watchdog
  Save-StackState

  Write-Host ""
  Write-Host "Voice stack is ready."
  Write-Host ("ComfyUI : {0}" -f $ComfyBaseUrl)
  Write-Host ("local-api: {0}" -f $LocalApiBaseUrl)
  Write-Host "Keep this terminal open. Press Ctrl+C to stop only processes started by this script."

  while ($true) {
    if ($null -ne $script:StartedComfyProcess -and $script:StartedComfyProcess.HasExited) {
      throw "ComfyUI process started by this script exited unexpectedly."
    }
    if ($null -ne $script:StartedLocalApiProcess -and $script:StartedLocalApiProcess.HasExited) {
      throw "local-api process started by this script exited unexpectedly."
    }
    Start-Sleep -Seconds 2
  }
} finally {
  [Console]::remove_CancelKeyPress($cancelHandler)
  Stop-StartedProcesses
}
