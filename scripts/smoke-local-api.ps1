$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Method GET
if (-not $health.ok) {
  throw "health check failed"
}
if ($health.engine -ne 'comfyui_workflow') {
  throw "engine is not comfyui_workflow: $($health.engine)"
}
if ($health.defaultVoiceProfile -ne 'irodori-v2') {
  throw "defaultVoiceProfile is not irodori-v2: $($health.defaultVoiceProfile)"
}

$profileIds = @($health.availableVoiceProfiles | ForEach-Object { $_.id })
if (-not ($profileIds -contains 'irodori-v2')) {
  throw "availableVoiceProfiles does not contain irodori-v2"
}
if (-not ($profileIds -contains 'irodori-v3')) {
  throw "availableVoiceProfiles does not contain irodori-v3"
}

function Invoke-SmokeSpeak {
  param(
    [Parameter(Mandatory = $true)][string]$VoiceProfile,
    [Parameter(Mandatory = $true)][string]$Text
  )

  $payload = @{
    text = $Text
    requestId = "smoke-$VoiceProfile-$(Get-Date -Format 'yyyyMMddHHmmss')"
    voiceProfile = $VoiceProfile
  }

  $body = $payload | ConvertTo-Json -Compress
  $response = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/speak" -Method POST -ContentType "application/json; charset=utf-8" -Body $body
  if (-not $response.ok) {
    throw "/v1/speak failed for $VoiceProfile"
  }
  if ([string]$response.voiceProfile -ne $VoiceProfile) {
    throw "response voiceProfile mismatch: expected=$VoiceProfile actual=$($response.voiceProfile)"
  }
  return $response
}

$v2 = Invoke-SmokeSpeak -VoiceProfile 'irodori-v2' -Text 'これはIrodori v2のスモークテストです。'
$v3 = Invoke-SmokeSpeak -VoiceProfile 'irodori-v3' -Text 'これはIrodori v3のスモークテストです。'

[ordered]@{
  health = $health
  v2 = $v2
  v3 = $v3
} | ConvertTo-Json -Depth 10
