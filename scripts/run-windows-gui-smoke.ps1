param(
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$venvRoot = Join-Path $repoRoot 'local-api\.venv'
$python = Join-Path $venvRoot 'Scripts\python.exe'
$requirements = Join-Path $repoRoot 'tests\windows\requirements-gui-smoke.txt'
$smokeScript = Join-Path $repoRoot 'tests\windows\tray_uia_smoke.py'
$launcher = Join-Path $repoRoot 'LocalVoiceBridge.exe'

if (-not [Environment]::UserInteractive) {
    throw 'Windows GUI smoke requires a logged-in interactive desktop session.'
}

if (-not (Test-Path $python)) {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -ne $py) {
        & $py.Source -3 -m venv $venvRoot
    } else {
        $systemPython = Get-Command python.exe -ErrorAction Stop
        & $systemPython.Source -m venv $venvRoot
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create GUI smoke virtual environment: $venvRoot"
    }
}

if (-not $SkipDependencyInstall) {
    & $python -m pip install --disable-pip-version-check --upgrade pip
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to update pip for the GUI smoke environment.'
    }
    & $python -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to install Windows GUI smoke dependencies.'
    }
}

Push-Location $repoRoot
try {
    & npm run build:launcher
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $launcher)) {
        throw 'LocalVoiceBridge.exe could not be built.'
    }

    & $launcher --self-test
    if ($LASTEXITCODE -ne 0) {
        throw 'LocalVoiceBridge.exe self-test failed.'
    }

    & $python $smokeScript
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
