$ErrorActionPreference = "Stop"

param(
  [string]$TaskName = "ChatGPTLocalVoiceBridge"
)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Uninstalled startup task: $TaskName"
} else {
  Write-Host "Startup task not found: $TaskName"
}
