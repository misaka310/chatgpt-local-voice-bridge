param(
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $repoRoot 'local-api\.venv'
$python = Join-Path $venvRoot 'Scripts\python.exe'
$requirements = Join-Path $repoRoot 'tests\windows\requirements-gui-smoke.txt'
$smokeScript = Join-Path $repoRoot 'tests\windows\hosted_tray_uia_smoke.py'
$launcher = Join-Path $repoRoot 'LocalVoiceBridge.exe'

function Invoke-Process {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $repoRoot -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "$FailureMessage (exit=$($process.ExitCode))"
    }
}

if (-not [Environment]::UserInteractive) {
    throw 'Windows GUI smoke requires a logged-in interactive desktop session.'
}

if (-not (Test-Path $python)) {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -ne $py) {
        Invoke-Process -FilePath $py.Source -Arguments @('-3', '-m', 'venv', $venvRoot) -FailureMessage "Failed to create GUI smoke virtual environment: $venvRoot"
    }
    else {
        $systemPython = Get-Command python.exe -ErrorAction Stop
        Invoke-Process -FilePath $systemPython.Source -Arguments @('-m', 'venv', $venvRoot) -FailureMessage "Failed to create GUI smoke virtual environment: $venvRoot"
    }
}

if (-not $SkipDependencyInstall) {
    Invoke-Process -FilePath $python -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip') -FailureMessage 'Failed to update pip for the GUI smoke environment.'
    Invoke-Process -FilePath $python -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', $requirements) -FailureMessage 'Failed to install Windows GUI smoke dependencies.'
}

Push-Location $repoRoot
try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Invoke-Process -FilePath $node -Arguments @((Join-Path $repoRoot 'scripts\run-launcher-build.js')) -FailureMessage 'LocalVoiceBridge.exe could not be built.'
    if (-not (Test-Path $launcher -PathType Leaf)) {
        throw 'LocalVoiceBridge.exe could not be built.'
    }

    Invoke-Process -FilePath $launcher -Arguments @('--self-test') -FailureMessage 'LocalVoiceBridge.exe self-test failed.'
    $smoke = Start-Process -FilePath $python -ArgumentList @($smokeScript) -WorkingDirectory $repoRoot -Wait -PassThru -NoNewWindow
    exit $smoke.ExitCode
}
finally {
    Pop-Location
}
