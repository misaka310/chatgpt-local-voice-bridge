param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$VoiceName = "",
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

if ($VoiceName -and $VoiceName.Trim().Length -gt 0) {
  $synth.SelectVoice($VoiceName)
}

$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
$synth.SetOutputToWaveFile($OutFile)
$synth.Speak($text)
$synth.SetOutputToNull()
$synth.Dispose()
