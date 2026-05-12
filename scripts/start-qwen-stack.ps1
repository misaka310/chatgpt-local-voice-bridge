[CmdletBinding()]
param(
  [string]$ComfyRunBat = "D:\ComfyUI_TTS_E2E_SANDBOX\start_comfyui_tts_sandbox.bat",
  [string]$ComfyBaseUrl = "http://127.0.0.1:8288",
  [string]$LocalApiBaseUrl = "http://127.0.0.1:8765",
  [int]$ComfyStartupTimeoutSec = 240,
  [int]$LocalApiStartupTimeoutSec = 90
)

$ErrorActionPreference = "Stop"
$voiceScript = Join-Path $PSScriptRoot "start-voice-stack.ps1"
if (-not (Test-Path -LiteralPath $voiceScript)) {
  throw "start-voice-stack.ps1 not found: $voiceScript"
}

Write-Host "[compat] start-qwen-stack.ps1 is deprecated. Redirecting to start-voice-stack.ps1..."

& $voiceScript `
  -ComfyRunBat $ComfyRunBat `
  -ComfyBaseUrl $ComfyBaseUrl `
  -LocalApiBaseUrl $LocalApiBaseUrl `
  -ComfyStartupTimeoutSec $ComfyStartupTimeoutSec `
  -LocalApiStartupTimeoutSec $LocalApiStartupTimeoutSec
