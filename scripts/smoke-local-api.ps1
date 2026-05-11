$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Method GET
if (-not $health.ok) {
  throw "health check failed"
}
if ($health.engine -ne 'comfyui_qwen3') {
  throw "engine is not comfyui_qwen3: $($health.engine)"
}

$payload = @{
  text = "Qwen3 smoke test from local voice bridge."
  requestId = "smoke-$(Get-Date -Format 'yyyyMMddHHmmss')"
}
$body = $payload | ConvertTo-Json -Compress
$response = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/speak" -Method POST -ContentType "application/json; charset=utf-8" -Body $body
$response | ConvertTo-Json -Depth 5
Start-Process $response.audioUrl
