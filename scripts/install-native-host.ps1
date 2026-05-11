$ErrorActionPreference = "Stop"

param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,
  [string]$HostName = "com.chatgpt.local_voice_bridge"
)

$Root = Split-Path -Parent $PSScriptRoot
$NativeDir = Join-Path $Root "tools\native-host"
$TemplatePath = Join-Path $NativeDir "manifest.template.json"
$HostCmdPath = Join-Path $NativeDir "host.cmd"
$ManifestPath = Join-Path $NativeDir "manifest.generated.json"

if (!(Test-Path $TemplatePath)) {
  throw "manifest.template.json が見つかりません: $TemplatePath"
}
if (!(Test-Path $HostCmdPath)) {
  throw "host.cmd が見つかりません: $HostCmdPath"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "python コマンドが見つかりません。PythonをインストールしてPATHを設定してください。"
}

$template = Get-Content -Raw -Encoding UTF8 $TemplatePath
$escapedHostPath = ($HostCmdPath -replace '\\', '\\\\')
$manifest = $template.Replace("__HOST_PATH__", $escapedHostPath).Replace("__EXTENSION_ID__", $ExtensionId)
$manifest | Set-Content -Encoding UTF8 $ManifestPath

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $ManifestPath

Write-Host "Installed native host: $HostName"
Write-Host "Manifest: $ManifestPath"
