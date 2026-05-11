$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Method GET
if (-not $health.ok) {
  throw "health check failed"
}

$payload = @{
  text = "Local Voice Bridge smoke test. preview and audio route check."
  requestId = "smoke-$(Get-Date -Format 'yyyyMMddHHmmss')"
}
$body = $payload | ConvertTo-Json -Compress
$response = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/speak" -Method POST -ContentType "application/json; charset=utf-8" -Body $body
$response | ConvertTo-Json -Depth 5
Start-Process $response.audioUrl
