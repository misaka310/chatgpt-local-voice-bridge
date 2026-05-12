$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Method GET
if (-not $health.ok) {
  throw "health check failed"
}
if ($health.engine -ne 'comfyui_workflow') {
  throw "engine is not comfyui_workflow: $($health.engine)"
}
if ($health.voiceProfile -ne 'irodori') {
  throw "voiceProfile is not irodori: $($health.voiceProfile)"
}

$payload = @{
  text = "Irodori smoke test from local voice bridge."
  requestId = "smoke-$(Get-Date -Format 'yyyyMMddHHmmss')"
}
$body = $payload | ConvertTo-Json -Compress
$response = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/speak" -Method POST -ContentType "application/json; charset=utf-8" -Body $body
$response | ConvertTo-Json -Depth 5
Start-Process $response.audioUrl
