$ErrorActionPreference = "Stop"

param(
  [string]$TaskName = "ChatGPTLocalVoiceBridge"
)

$Root = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $Root "scripts\start-local-api.ps1"

if (!(Test-Path $ScriptPath)) {
  throw "start-local-api.ps1 が見つかりません: $ScriptPath"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -Background"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Write-Host "Installed startup task: $TaskName"
