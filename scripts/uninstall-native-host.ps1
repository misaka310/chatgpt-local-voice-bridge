$ErrorActionPreference = "Stop"

param(
  [string]$HostName = "com.chatgpt.local_voice_bridge"
)

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
if (Test-Path $regPath) {
  Remove-Item -Path $regPath -Recurse -Force
  Write-Host "Uninstalled native host registry: $HostName"
} else {
  Write-Host "Native host registry not found: $HostName"
}
